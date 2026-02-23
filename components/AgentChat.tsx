"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import { useState, useRef, useEffect, useMemo, CSSProperties } from "react";
import { Bot, Expand, Minimize, SendHorizontal, X } from "lucide-react";

// Agent chat panel:
// - Streams assistant responses for the current table schema context
// - Detects executable DynamoDB snippets in assistant output
// - Lets users parameterize and run those snippets inline

// ─── Types ─────────────────────────────────────────────────────────────────
interface AgentChatProps {
  activeTable: string;
  schema: {
    pk: string;
    sk: string | null;
    gsi: string[];
  } | null;
  queuedPrompt?: { id: string; text: string } | null;
  onQueuedPromptHandled?: () => void;
  onClose: () => void;
}

type ExecInputType = "string" | "number" | "boolean";
type ExecOperation = "Query" | "Scan" | "GetItem" | "PutItem" | "UpdateItem" | "DeleteItem";

interface ExecInputSchema {
  name: string;
  type: ExecInputType;
  required?: boolean;
  description?: string;
}

interface ExecPayload {
  type: "dynamo-exec";
  operation: ExecOperation;
  tableName?: string;
  inputSchema?: ExecInputSchema[];
  params: Record<string, unknown>;
}

interface ExecuteResponse {
  operation: ExecOperation;
  tableName: string;
  rowCount: number;
  rows: Record<string, unknown>[];
  raw: Record<string, unknown>;
}

interface ExecutionState {
  prompted: boolean;
  isRunning: boolean;
  expanded: boolean;
  error: string | null;
  result: ExecuteResponse | null;
  inputValues: Record<string, string>;
}

type ThreadMode = "table" | "visualizer";

interface ChatThread {
  id: string;
  title: string;
  mode: ThreadMode;
  tableName: string;
  createdAt: string;
  updatedAt: string;
  messages: UIMessage[];
}

interface PersistedAgentChatState {
  threads: ChatThread[];
}

interface LegacyVisualizerChatState {
  messages: UIMessage[];
}

// ─── Language options for quick-insert prompts ────────────────────────────
const LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Java", "Rust"] as const;
type Language = (typeof LANGUAGES)[number];
const AGENT_CHAT_THREADS_KEY = "dynamoStudio.agentChat.threads.v1";
const AGENT_CHAT_VISUALIZER_THREADS_KEY = "dynamoStudio.agentChat.visualizerThreads.v1";
const AGENT_CHAT_VISUALIZER_LEGACY_KEY = "dynamoStudio.agentChat.visualizer";
const MAX_THREADS = 25;

const sanitizeMessages = (value: unknown): UIMessage[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((message): message is UIMessage => {
    if (!message || typeof message !== "object") return false;
    const candidate = message as Partial<UIMessage>;
    return typeof candidate.id === "string" && (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system") && Array.isArray(candidate.parts);
  });
};

const makeThreadId = (): string => `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const threadDefaultTitle = (mode: ThreadMode, tableName: string): string => (mode === "visualizer" ? "Visualizer chat" : `New chat (${tableName || "no table"})`);

const deriveThreadTitleFromMessages = (thread: ChatThread): string => {
  const firstUser = thread.messages.find((message) => message.role === "user");
  if (!firstUser) return threadDefaultTitle(thread.mode, thread.tableName);
  const text = firstUser.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
  if (!text) return threadDefaultTitle(thread.mode, thread.tableName);
  return text.length > 42 ? `${text.slice(0, 42)}...` : text;
};

const sanitizeThreads = (value: unknown): ChatThread[] => {
  if (!Array.isArray(value)) return [];
  const threads: ChatThread[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<ChatThread>;
    if (typeof candidate.id !== "string") continue;
    if (candidate.mode !== "table" && candidate.mode !== "visualizer") continue;
    if (typeof candidate.tableName !== "string") continue;
    if (typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") continue;
    const messages = sanitizeMessages(candidate.messages);
    const thread: ChatThread = {
      id: candidate.id,
      title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : threadDefaultTitle(candidate.mode, candidate.tableName),
      mode: candidate.mode,
      tableName: candidate.tableName,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      messages,
    };
    threads.push({ ...thread, title: deriveThreadTitleFromMessages(thread) });
  }
  return threads
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, MAX_THREADS);
};

const readPersistedThreads = (): ChatThread[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AGENT_CHAT_THREADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedAgentChatState>;
    return sanitizeThreads(parsed.threads);
  } catch {
    return [];
  }
};

const readPersistedVisualizerThreads = (): ChatThread[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AGENT_CHAT_VISUALIZER_THREADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedAgentChatState>;
    return sanitizeThreads(parsed.threads).filter((thread) => thread.mode === "visualizer");
  } catch {
    return [];
  }
};

const readLegacyVisualizerThread = (): ChatThread[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AGENT_CHAT_VISUALIZER_LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<LegacyVisualizerChatState>;
    const messages = sanitizeMessages(parsed.messages);
    if (messages.length === 0) return [];
    const migrated: ChatThread = {
      id: "legacy-visualizer-history",
      title: "Visualizer chat",
      mode: "visualizer",
      tableName: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages,
    };
    return [{ ...migrated, title: deriveThreadTitleFromMessages(migrated) }];
  } catch {
    return [];
  }
};

const writePersistedThreads = (threads: ChatThread[]): void => {
  if (typeof window === "undefined") return;
  const payload: PersistedAgentChatState = { threads: sanitizeThreads(threads) };
  window.localStorage.setItem(AGENT_CHAT_THREADS_KEY, JSON.stringify(payload));
};

const writePersistedVisualizerThreads = (threads: ChatThread[]): void => {
  if (typeof window === "undefined") return;
  const payload: PersistedAgentChatState = { threads: sanitizeThreads(threads).filter((thread) => thread.mode === "visualizer") };
  window.localStorage.setItem(AGENT_CHAT_VISUALIZER_THREADS_KEY, JSON.stringify(payload));
};

const areMessagesEqual = (left: UIMessage[], right: UIMessage[]): boolean => {
  if (left.length !== right.length) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const hasTextContent = (message: UIMessage): boolean =>
  message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);

const shouldPersistThread = (thread: ChatThread): boolean => {
  const hasUserPrompt = thread.messages.some((message) => message.role === "user" && hasTextContent(message));
  const hasAssistantResponse = thread.messages.some((message) => message.role === "assistant" && hasTextContent(message));
  return hasUserPrompt && hasAssistantResponse;
};

// ─── Quick prompt starters ────────────────────────────────────────────────
const STARTERS = [
  { label: "Explain this table", prompt: "Explain this table's schema and what access patterns it supports." },
  { label: "Suggest optimizations", prompt: "Analyze this table and suggest any GSI, billing mode, or key design improvements." },
  { label: "Generate a query", prompt: "Generate a TypeScript query to get all items by the partition key." },
  { label: "What indexes should I add?", prompt: "Based on common access patterns, what indexes should I consider adding to this table?" },
];

// Pull explicit `dynamo-exec` payloads out of fenced blocks in assistant text.
function parseExecPayloads(content: string): ExecPayload[] {
  const blockRe = /```([\w-]*)\n([\s\S]*?)```/g;
  const payloads: ExecPayload[] = [];
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(content)) !== null) {
    const lang = match[1].trim().toLowerCase();
    const code = match[2].trim();
    if (lang !== "dynamo-exec" && lang !== "dynamoexec" && lang !== "json") continue;

    try {
      const parsed = JSON.parse(code);
      if (parsed && parsed.type === "dynamo-exec" && parsed.operation && parsed.params && typeof parsed.params === "object") {
        payloads.push(parsed as ExecPayload);
      }
    } catch {
      continue;
    }
  }

  return payloads;
}

// Find the boundaries of the first object literal after a command constructor call.
function inferObjectLiteralBounds(source: string, startAt: number): { start: number; end: number } | null {
  const start = source.indexOf("{", startAt);
  if (start < 0) return null;

  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }

  return null;
}

// Split top-level object entries while respecting nested objects/arrays/strings.
function parseSimpleObjectEntries(objectLiteral: string): Array<{ key: string; value: string }> {
  const body = objectLiteral.trim().replace(/^\{/, "").replace(/\}$/, "");
  const entries: Array<{ key: string; value: string }> = [];
  let current = "";
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const chunk = current.trim();
    current = "";
    if (!chunk) return;
    let idx = -1;
    let localDepth = 0;
    let localInString: '"' | "'" | "`" | null = null;
    let localEscaped = false;
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (localInString) {
        if (localEscaped) {
          localEscaped = false;
          continue;
        }
        if (ch === "\\") {
          localEscaped = true;
          continue;
        }
        if (ch === localInString) localInString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        localInString = ch;
        continue;
      }
      if (ch === "{" || ch === "[" || ch === "(") localDepth += 1;
      if (ch === "}" || ch === "]" || ch === ")") localDepth -= 1;
      if (ch === ":" && localDepth === 0) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const key = chunk.slice(0, idx).trim().replace(/^["']|["']$/g, "");
    const value = chunk.slice(idx + 1).trim();
    if (!key) return;
    entries.push({ key, value });
  };

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      current += char;
      continue;
    }

    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;

    if (char === "," && depth === 0) {
      pushCurrent();
      continue;
    }

    current += char;
  }

  pushCurrent();
  return entries;
}

// Parse `ExpressionAttributeNames` object literals into JSON-safe maps.
function parseExpressionAttributeNames(value: string): Record<string, string> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const entries = parseSimpleObjectEntries(trimmed);
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const match = entry.value.match(/^["']([\s\S]*)["']$/);
    if (!match) continue;
    result[entry.key] = match[1];
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Parse `ExpressionAttributeValues`, converting literals directly and unresolved tokens into runtime inputs.
function parseExpressionAttributeValues(
  value: string,
): { values: Record<string, unknown> | null; inputs: ExecInputSchema[] } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { values: null, inputs: [] };
  const entries = parseSimpleObjectEntries(trimmed);
  const result: Record<string, unknown> = {};
  const inputs: ExecInputSchema[] = [];

  for (const entry of entries) {
    const raw = entry.value.trim();
    if (/^["'][\s\S]*["']$/.test(raw)) {
      result[entry.key] = raw.slice(1, -1);
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      result[entry.key] = Number(raw);
      continue;
    }
    if (raw === "true" || raw === "false") {
      result[entry.key] = raw === "true";
      continue;
    }

    const inputName = raw.replace(/[^a-zA-Z0-9_]/g, "") || entry.key.replace(/[^a-zA-Z0-9_]/g, "");
    result[entry.key] = `{{${inputName}}}`;
    inputs.push({
      name: inputName,
      type: "string",
      required: true,
      description: `Value for ${entry.key}`,
    });
  }

  return { values: Object.keys(result).length > 0 ? result : null, inputs };
}

// Convert a Python token into a value or an input placeholder for runtime prompting.
function parsePythonLiteralOrInput(token: string, fallbackName: string): { value: unknown; input: ExecInputSchema | null } {
  const trimmed = token.trim();

  if (/^["'][\s\S]*["']$/.test(trimmed)) {
    return { value: trimmed.slice(1, -1), input: null };
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { value: Number(trimmed), input: null };
  }
  if (trimmed === "True" || trimmed === "False") {
    return { value: trimmed === "True", input: null };
  }

  const inputName = trimmed.replace(/[^a-zA-Z0-9_]/g, "") || fallbackName;
  return {
    value: `{{${inputName}}}`,
    input: {
      name: inputName,
      type: "string",
      required: true,
      description: `Value for ${fallbackName}`,
    },
  };
}

// Infer executable payloads from common boto3 patterns in Python code blocks.
function inferExecPayloadsFromPython(content: string, activeTable: string): ExecPayload[] {
  const payloads: ExecPayload[] = [];
  const pythonBlockRe = /```python\n([\s\S]*?)```/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = pythonBlockRe.exec(content)) !== null) {
    const code = blockMatch[1];
    const tableNameMatch = code.match(/dynamodb\.Table\(\s*["']([^"']+)["']\s*\)/);
    const tableName = tableNameMatch?.[1] || activeTable;
    if (!tableName) continue;

    const betweenMatch = code.match(/Attr\(\s*["']([^"']+)["']\s*\)\.between\(\s*([^)]+?)\s*,\s*([^)]+?)\s*\)/);
    if (betweenMatch) {
      const [, attrName, startToken, endToken] = betweenMatch;
      const start = parsePythonLiteralOrInput(startToken, `${attrName}Start`);
      const end = parsePythonLiteralOrInput(endToken, `${attrName}End`);
      const inputs: ExecInputSchema[] = [];
      if (start.input) inputs.push(start.input);
      if (end.input) inputs.push(end.input);

      payloads.push({
        type: "dynamo-exec",
        operation: "Scan",
        tableName,
        inputSchema: inputs.length > 0 ? inputs : undefined,
        params: {
          TableName: tableName,
          FilterExpression: "#attr BETWEEN :start AND :end",
          ExpressionAttributeNames: { "#attr": attrName },
          ExpressionAttributeValues: {
            ":start": start.value,
            ":end": end.value,
          },
        },
      });
      continue;
    }

    const containsMatch = code.match(/Attr\(\s*["']([^"']+)["']\s*\)\.contains\(\s*([^)]+?)\s*\)/);
    if (containsMatch) {
      const [, attrName, valueToken] = containsMatch;
      const value = parsePythonLiteralOrInput(valueToken, `${attrName}Value`);
      payloads.push({
        type: "dynamo-exec",
        operation: "Scan",
        tableName,
        inputSchema: value.input ? [value.input] : undefined,
        params: {
          TableName: tableName,
          FilterExpression: "contains(#attr, :value)",
          ExpressionAttributeNames: { "#attr": attrName },
          ExpressionAttributeValues: {
            ":value": value.value,
          },
        },
      });
    }
  }

  return payloads;
}

// Infer executable payloads from AWS SDK v3 command usage in JS/TS code blocks.
function inferExecPayloadsFromCode(content: string, activeTable: string): ExecPayload[] {
  const payloads: ExecPayload[] = [];
  const commandRe = /new\s+(ScanCommand|QueryCommand|GetCommand|PutCommand|UpdateCommand|DeleteCommand)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = commandRe.exec(content)) !== null) {
    const commandName = match[1];
    const bounds = inferObjectLiteralBounds(content, match.index);
    if (!bounds) continue;

    const objectLiteral = content.slice(bounds.start, bounds.end);
    const topLevel = parseSimpleObjectEntries(objectLiteral);
    const params: Record<string, unknown> = {};
    const inputSchema: ExecInputSchema[] = [];

    for (const entry of topLevel) {
      if (entry.key === "TableName") {
        const tableMatch = entry.value.match(/^["']([\s\S]*)["']$/);
        if (tableMatch) params.TableName = tableMatch[1];
        continue;
      }

      if (entry.key === "ExpressionAttributeNames") {
        const names = parseExpressionAttributeNames(entry.value);
        if (names) params.ExpressionAttributeNames = names;
        continue;
      }

      if (entry.key === "ExpressionAttributeValues") {
        const parsed = parseExpressionAttributeValues(entry.value);
        if (parsed.values) params.ExpressionAttributeValues = parsed.values;
        if (parsed.inputs.length > 0) inputSchema.push(...parsed.inputs);
        continue;
      }

      const stringMatch = entry.value.match(/^["']([\s\S]*)["']$/);
      if (stringMatch) {
        params[entry.key] = stringMatch[1];
        continue;
      }

      if (/^-?\d+(\.\d+)?$/.test(entry.value)) {
        params[entry.key] = Number(entry.value);
        continue;
      }

      if (entry.value === "true" || entry.value === "false") {
        params[entry.key] = entry.value === "true";
      }
    }

    const operationMap: Record<string, ExecOperation> = {
      QueryCommand: "Query",
      ScanCommand: "Scan",
      GetCommand: "GetItem",
      PutCommand: "PutItem",
      UpdateCommand: "UpdateItem",
      DeleteCommand: "DeleteItem",
    };

    const operation = operationMap[commandName];
    if (!operation) continue;

    payloads.push({
      type: "dynamo-exec",
      operation,
      tableName: typeof params.TableName === "string" ? params.TableName : activeTable,
      inputSchema: inputSchema.length > 0 ? inputSchema : undefined,
      params,
    });
  }

  if (payloads.length > 0) return payloads;

  return inferExecPayloadsFromPython(content, activeTable);
}

// Hide machine-readable exec payload blocks from user-facing assistant message text.
function stripExecBlocks(content: string): string {
  return content.replace(/```([\w-]*)\n([\s\S]*?)```/g, (full, lang: string, code: string) => {
    const normalized = String(lang).trim().toLowerCase();
    if (normalized === "dynamo-exec" || normalized === "dynamoexec") return "";
    if (normalized !== "json") return full;
    try {
      const parsed = JSON.parse(code.trim());
      return parsed?.type === "dynamo-exec" ? "" : full;
    } catch {
      return full;
    }
  });
}

// Minimal inline markdown renderer for bold/code/newlines used in chat bubbles.
function renderInlineMarkdown(part: string, partKey: string) {
  const inline = part.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <span key={partKey}>
      {inline.map((chunk, j) => {
        if (chunk.startsWith("**") && chunk.endsWith("**"))
          return (
            <strong key={`${partKey}:b:${j}`} style={{ color: "#f0f0f0" }}>
              {chunk.slice(2, -2)}
            </strong>
          );
        if (chunk.startsWith("`") && chunk.endsWith("`"))
          return (
            <code key={`${partKey}:c:${j}`} style={cs.inlineCode}>
              {chunk.slice(1, -1)}
            </code>
          );
        return chunk.split("\n").map((line, k, arr) => (
          <span key={`${partKey}:l:${j}:${k}`}>
            {line}
            {k < arr.length - 1 && <br />}
          </span>
        ));
      })}
    </span>
  );
}

// ─── Markdown-like renderer ───────────────────────────────────────────────
// Renders assistant messages with syntax-highlighted code blocks and basic
// markdown (bold, inline code) without pulling in a full markdown library.
function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div style={{ lineHeight: 1.65, fontSize: 13 }}>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.slice(3, -3).split("\n");
          const lang = lines[0].trim();
          const code = lines.slice(1).join("\n");
          return (
            <div key={i} style={cs.codeBlock}>
              {lang && <div style={cs.codeLang}>{lang}</div>}
              <pre style={cs.codePre}>
                <code>{code}</code>
              </pre>
            </div>
          );
        }
        return renderInlineMarkdown(part, `part:${i}`);
      })}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────
export default function AgentChat({ activeTable, schema, queuedPrompt, onQueuedPromptHandled, onClose }: AgentChatProps) {
  // UI state for language preference, panel mode, chat input, and per-card execution state.
  const [selectedLang, setSelectedLang] = useState<Language>("TypeScript");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [execStates, setExecStates] = useState<Record<string, ExecutionState>>({});
  const hasInitializedThreadsRef = useRef(false);
  const isInitializingThreadsRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queuedHandledRef = useRef<Set<string>>(new Set());
  const queuedInFlightRef = useRef<string | null>(null);
  const activeThread = useMemo(() => threads.find((thread) => thread.id === activeThreadId) ?? null, [threads, activeThreadId]);
  const isVisualizerSession = activeThread?.mode === "visualizer";
  const isTableSession = !isVisualizerSession;
  const recentThreads = useMemo(() => threads.slice(0, 6), [threads]);

  // Transport carries table/schema context so responses stay scoped to current data model.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent",
        body: {
          activeTable: isTableSession ? activeTable : "",
          schema: isTableSession ? schema : null,
          contextMode: isVisualizerSession ? "visualizer" : "table",
        },
      }),
    [activeTable, schema, isTableSession, isVisualizerSession],
  );

  const { messages, setMessages, sendMessage, status } = useChat({
    transport,
  });
  const isLoading = status === "submitted" || status === "streaming";

  const extractTextContent = (message: UIMessage): string =>
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");

  // Ensure every inferred payload card has deterministic local state.
  const ensureExecState = (key: string): ExecutionState =>
    execStates[key] ?? {
      prompted: false,
      isRunning: false,
      expanded: false,
      error: null,
      result: null,
      inputValues: {},
    };

  // Shared state update helper for payload execution cards.
  const updateExecState = (key: string, updater: (prev: ExecutionState) => ExecutionState) => {
    setExecStates((prev) => {
      const current = prev[key] ?? {
        prompted: false,
        isRunning: false,
        expanded: false,
        error: null,
        result: null,
        inputValues: {},
      };
      return { ...prev, [key]: updater(current) };
    });
  };

  // Capture user-provided values for placeholders inferred from code examples.
  const setExecInputValue = (key: string, inputName: string, value: string) => {
    updateExecState(key, (prev) => ({
      ...prev,
      prompted: true,
      inputValues: { ...prev.inputValues, [inputName]: value },
    }));
  };

  // Guard execution until every required runtime input is present.
  const hasMissingRequiredInputs = (payload: ExecPayload, state: ExecutionState): boolean =>
    (payload.inputSchema ?? []).some((field) => field.required && !(state.inputValues[field.name] ?? "").toString().trim());

  // Execute assistant-generated DynamoDB operations via backend API and persist result in card state.
  const executePayload = async (stateKey: string, payload: ExecPayload) => {
    const current = ensureExecState(stateKey);
    if (hasMissingRequiredInputs(payload, current)) {
      updateExecState(stateKey, (prev) => ({
        ...prev,
        prompted: true,
        error: "Fill in all required inputs before running.",
      }));
      return;
    }

    updateExecState(stateKey, (prev) => ({
      ...prev,
      prompted: true,
      isRunning: true,
      error: null,
    }));

    try {
      const res = await fetch("/api/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activeTable: isTableSession ? activeTable : "",
          payload,
          inputs: ensureExecState(stateKey).inputValues,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Execution failed");
      }

      updateExecState(stateKey, (prev) => ({
        ...prev,
        isRunning: false,
        error: null,
        expanded: true,
        result: data as ExecuteResponse,
      }));
    } catch (error) {
      updateExecState(stateKey, (prev) => ({
        ...prev,
        isRunning: false,
        error: error instanceof Error ? error.message : "Execution failed",
      }));
    }
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const selectThread = (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    setActiveThreadId(threadId);
    setMessages(thread.messages);
    setExecStates({});
  };

  const createThread = (mode: ThreadMode, tableName: string, initialMessages: UIMessage[] = []): ChatThread => {
    const now = new Date().toISOString();
    const next: ChatThread = {
      id: makeThreadId(),
      title: threadDefaultTitle(mode, tableName),
      mode,
      tableName,
      createdAt: now,
      updatedAt: now,
      messages: initialMessages,
    };
    return { ...next, title: deriveThreadTitleFromMessages(next) };
  };

  // On each chat open (component mount), start a new thread and show recents.
  useEffect(() => {
    isInitializingThreadsRef.current = true;
    hasInitializedThreadsRef.current = false;
    const storedThreads = readPersistedThreads();
    const storedVisualizerThreads = readPersistedVisualizerThreads();
    const legacyVisualizerThread = readLegacyVisualizerThread();
    const mergedById = new Map<string, ChatThread>();
    [...storedThreads, ...storedVisualizerThreads, ...legacyVisualizerThread].forEach((thread) => mergedById.set(thread.id, thread));
    const mergedThreads = Array.from(mergedById.values()).sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    const newThread = createThread("table", activeTable);
    const nextThreads = [newThread, ...mergedThreads].slice(0, MAX_THREADS);
    setThreads(nextThreads);
    setActiveThreadId(newThread.id);
    setMessages([]);
    setExecStates({});
  }, [setMessages, activeTable]);

  // Mark initialization complete only after restored/new threads are committed.
  useEffect(() => {
    if (!isInitializingThreadsRef.current) return;
    if (!activeThreadId) return;
    hasInitializedThreadsRef.current = true;
    isInitializingThreadsRef.current = false;
  }, [threads, activeThreadId]);

  // Persist thread list whenever it changes.
  useEffect(() => {
    if (!hasInitializedThreadsRef.current) return;
    const persistedThreads = threads.filter(shouldPersistThread);
    writePersistedThreads(persistedThreads);
    writePersistedVisualizerThreads(persistedThreads);
  }, [threads]);

  // Keep active thread content in sync with useChat messages.
  useEffect(() => {
    if (!activeThreadId) return;
    setThreads((prev) =>
      prev
        .map((thread) => {
          if (thread.id !== activeThreadId) return thread;
          if (areMessagesEqual(thread.messages, messages)) return thread;
          const updated: ChatThread = {
            ...thread,
            messages,
            updatedAt: new Date().toISOString(),
          };
          return { ...updated, title: deriveThreadTitleFromMessages(updated) };
        })
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        .slice(0, MAX_THREADS),
    );
  }, [messages, activeThreadId]);

  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Lock page scroll while chat is fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

  // Allow exiting fullscreen with Escape
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen]);

  // One-click canned prompts shown in the empty chat state.
  const submitStarter = async (prompt: string) => {
    if (!prompt.trim() || isLoading) return;
    await sendMessage({ text: prompt.trim() });
    setInput("");
  };

  // Submits custom input and appends preferred language when the request appears code-oriented.
  const submitWithLang = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    if (!input.trim()) return;
    // If the message mentions "generate" or "code", append the preferred language
    const lower = input.toLowerCase();
    const mentionsCode = lower.includes("generat") || lower.includes("code") || lower.includes("query") || lower.includes("scan");
    const hasLang = LANGUAGES.some((l) => lower.includes(l.toLowerCase()));
    const finalPrompt = mentionsCode && !hasLang ? `${input.trim()} (in ${selectedLang})` : input.trim();
    await sendMessage({ text: finalPrompt });
    setInput("");
  };

  // Auto-submit prompts passed from the visualizer while deduplicating by prompt id.
  useEffect(() => {
    if (!queuedPrompt) return;
    if (queuedHandledRef.current.has(queuedPrompt.id)) return;
    if (queuedInFlightRef.current === queuedPrompt.id) return;
    if (isLoading) return;
    if (!activeThreadId) return;

    const isVisualizerPrompt = queuedPrompt.id.startsWith("visualizer-");
    if (isVisualizerPrompt && !isVisualizerSession) {
      const mostRecentVisualizerThread = threads.find((thread) => thread.mode === "visualizer");
      if (mostRecentVisualizerThread) {
        selectThread(mostRecentVisualizerThread.id);
        return;
      }
      const newVisualizerThread = createThread("visualizer", "");
      setThreads((prev) => [newVisualizerThread, ...prev].slice(0, MAX_THREADS));
      setActiveThreadId(newVisualizerThread.id);
      setMessages([]);
      setExecStates({});
      return;
    }

    let canceled = false;
    const run = async () => {
      queuedInFlightRef.current = queuedPrompt.id;
      try {
        if (!queuedPrompt.text.trim()) {
          queuedHandledRef.current.add(queuedPrompt.id);
          if (!canceled) onQueuedPromptHandled?.();
          return;
        }
        await sendMessage({ text: queuedPrompt.text });
        queuedHandledRef.current.add(queuedPrompt.id);
        if (!canceled) onQueuedPromptHandled?.();
      } finally {
        if (queuedInFlightRef.current === queuedPrompt.id) queuedInFlightRef.current = null;
      }
    };
    run().catch(() => {});

    return () => {
      canceled = true;
    };
  }, [queuedPrompt, isLoading, sendMessage, onQueuedPromptHandled, activeThreadId, isVisualizerSession, setMessages, threads]);

  return (
    <div style={{ ...cs.panel, ...(isFullscreen ? cs.panelFullscreen : {}) }}>
      {/* ── Header ── */}
      <div style={cs.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Animated orb */}
          <div style={cs.orb}>
            <div style={{ ...cs.orbInner, ...(isLoading ? cs.orbPulsing : {}) }} />
          </div>
          <div>
            <div style={cs.headerTitle}>DynamoDB Studio Assistant</div>
            <div style={cs.headerSub}>
              {isVisualizerSession ? (
                <span style={{ color: "#67e8f9" }}>Table Visualizer Chat · schema snapshot mode</span>
              ) : activeTable ? (
                <>
                  <span style={{ color: "#80FF00" }}>{activeTable}</span> · {schema?.pk}
                  {schema?.sk ? ` / ${schema.sk}` : ""}
                </>
              ) : (
                "No table selected"
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button style={cs.iconBtn} onClick={() => setIsFullscreen((v) => !v)} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}>
            {isFullscreen ? <Minimize size={14} /> : <Expand size={14} />}
          </button>
          <button style={cs.iconBtn} onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      <div style={cs.threadBar}>
        <button
          style={cs.newThreadBtn}
          onClick={() => {
            const next = createThread(isVisualizerSession ? "visualizer" : "table", isVisualizerSession ? "" : activeTable);
            setThreads((prev) => [next, ...prev].slice(0, MAX_THREADS));
            setActiveThreadId(next.id);
            setMessages([]);
            setExecStates({});
          }}
        >
          + New Chat
        </button>
        {recentThreads.length > 0 && <span style={cs.threadLabel}>Recent:</span>}
        {recentThreads.map((thread) => (
          <button
            key={thread.id}
            style={{ ...cs.threadChip, ...(thread.id === activeThreadId ? cs.threadChipActive : {}) }}
            onClick={() => selectThread(thread.id)}
            title={thread.title}
          >
            {thread.mode === "visualizer" ? "Visualizer" : thread.tableName || "No table"} · {thread.title}
          </button>
        ))}
      </div>

      {/* ── Messages ── */}
      <div style={cs.messages}>
        {messages.length === 0 ? (
          <div style={cs.empty}>
            <div style={cs.emptyIcon}>
              <Bot size={28} color="#80FF00" />
            </div>
            <div style={cs.emptyTitle}>Ask me anything about</div>
            <div style={{ ...cs.emptyTitle, color: "#80FF00" }}>{isVisualizerSession ? "your table visualizer snapshot" : activeTable || "your DynamoDB tables"}</div>
            <div style={cs.emptyStarters}>
              {STARTERS.map((s) => (
                <button key={s.label} style={cs.starterBtn} onClick={() => submitStarter(s.prompt)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, msgIndex) => {
            const rawContent = extractTextContent(msg);
            const structuredExecPayloads = msg.role === "assistant" ? parseExecPayloads(rawContent) : [];
            const execPayloads =
              msg.role === "assistant" && structuredExecPayloads.length === 0
                ? inferExecPayloadsFromCode(rawContent, isTableSession ? activeTable : "")
                : structuredExecPayloads;
            const displayContent = msg.role === "assistant" ? stripExecBlocks(rawContent) : rawContent;
            const renderExecCard = (payload: ExecPayload, index: number) => {
              const stateKey = `${msg.id}:${msgIndex}:${index}`;
              const state = ensureExecState(stateKey);
              const requiredMissing = hasMissingRequiredInputs(payload, state);
              const inputSchema = payload.inputSchema ?? [];
              const showInputs = inputSchema.length > 0 && (state.prompted || Boolean(state.result));

              return (
                <div key={stateKey} style={cs.execCard}>
                  <div style={cs.execMetaRow}>
                    <span style={cs.execTag}>{payload.operation}</span>
                    <span style={cs.execTable}>
                      Table: {payload.tableName || (isTableSession ? activeTable || "current table" : "visualizer snapshot")}
                    </span>
                  </div>

                  {showInputs && (
                    <div style={cs.execInputs}>
                      {inputSchema.map((field) => (
                        <label key={field.name} style={cs.execInputLabel}>
                          <span>
                            {field.name} ({field.type}){field.required ? " *" : ""}
                          </span>
                          <input
                            style={cs.execInput}
                            value={state.inputValues[field.name] ?? ""}
                            onChange={(e) => setExecInputValue(stateKey, field.name, e.target.value)}
                            placeholder={field.description || `Enter ${field.name}`}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  <div style={cs.execActionRow}>
                    <button
                      style={{ ...cs.execBtn, ...(state.isRunning ? cs.execBtnDisabled : {}) }}
                      onClick={() => {
                        if (inputSchema.length > 0 && !state.prompted) {
                          updateExecState(stateKey, (prev) => ({ ...prev, prompted: true, error: null }));
                          return;
                        }
                        executePayload(stateKey, payload);
                      }}
                      disabled={state.isRunning}
                    >
                      {state.isRunning ? "Running..." : requiredMissing ? "Enter inputs to run" : "Run query"}
                    </button>

                    {state.result && (
                      <button style={cs.execToggle} onClick={() => updateExecState(stateKey, (prev) => ({ ...prev, expanded: !prev.expanded }))}>
                        {state.expanded ? "Hide rows" : `Show rows (${state.result.rowCount})`}
                      </button>
                    )}
                  </div>

                  {state.error && <div style={cs.execError}>{state.error}</div>}

                  {state.result && (
                    <div style={cs.execSummary}>
                      Returned {state.result.rowCount} row{state.result.rowCount === 1 ? "" : "s"} from {state.result.tableName}.
                    </div>
                  )}

                  {state.result && state.expanded && (
                    <pre style={cs.execRows}>
                      <code>{JSON.stringify(state.result.rows, null, 2)}</code>
                    </pre>
                  )}
                </div>
              );
            };

            return (
              <div key={`${msg.id}:${msgIndex}`} style={{ ...cs.message, ...(msg.role === "user" ? cs.messageUser : cs.messageAssistant) }}>
                <div style={{ ...cs.avatar, ...(msg.role === "user" ? cs.avatarUser : cs.avatarAssistant) }}>{msg.role === "user" ? "U" : "AI"}</div>
                <div style={cs.messageBody}>
                  {msg.role === "assistant" ? (
                    <>
                      {(() => {
                        const contentParts = displayContent.split(/(```[\s\S]*?```)/g);
                        let codeBlockIndex = 0;
                        const usedExecIndexes = new Set<number>();

                        return (
                          <>
                            {contentParts.map((part, i) => {
                              if (part.startsWith("```")) {
                                const lines = part.slice(3, -3).split("\n");
                                const lang = lines[0].trim();
                                const code = lines.slice(1).join("\n");
                                const maybeExec = execPayloads[codeBlockIndex];
                                const localIndex = codeBlockIndex;
                                codeBlockIndex += 1;

                                return (
                                  <div key={`block:${msg.id}:${i}`}>
                                    <div style={cs.codeBlock}>
                                      {lang && <div style={cs.codeLang}>{lang}</div>}
                                      <pre style={cs.codePre}>
                                        <code>{code}</code>
                                      </pre>
                                    </div>
                                    {maybeExec && (
                                      <>
                                        {(() => {
                                          usedExecIndexes.add(localIndex);
                                          return renderExecCard(maybeExec, localIndex);
                                        })()}
                                      </>
                                    )}
                                  </div>
                                );
                              }
                              return <span key={`text:${msg.id}:${i}`}>{renderInlineMarkdown(part, `inline:${msg.id}:${i}`)}</span>;
                            })}
                            {execPayloads.map((payload, index) => (usedExecIndexes.has(index) ? null : renderExecCard(payload, index)))}
                          </>
                        );
                      })()}
                    </>
                  ) : (
                    <span style={{ fontSize: 13, lineHeight: 1.65 }}>{displayContent}</span>
                  )}
                </div>
              </div>
            );
          })
        )}
        {isLoading && (
          <div style={{ ...cs.message, ...cs.messageAssistant }}>
            <div style={{ ...cs.avatar, ...cs.avatarAssistant }}>AI</div>
            <div style={cs.typingDots}>
              <span style={{ ...cs.dot, animationDelay: "0ms" }} />
              <span style={{ ...cs.dot, animationDelay: "160ms" }} />
              <span style={{ ...cs.dot, animationDelay: "320ms" }} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Footer ── */}
      <div style={cs.footer}>
        {/* Language selector — shown as a small pill row */}
        <div style={cs.langRow}>
          <span style={cs.langLabel}>Code lang:</span>
          {LANGUAGES.map((lang) => (
            <button key={lang} style={{ ...cs.langBtn, ...(selectedLang === lang ? cs.langBtnActive : {}) }} onClick={() => setSelectedLang(lang)}>
              {lang}
            </button>
          ))}
        </div>

        {/* Input */}
        <form id="agent-chat-form" onSubmit={submitWithLang} style={cs.inputRow}>
          <input
            ref={inputRef}
            style={cs.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isVisualizerSession ? "Ask about the visualizer snapshot..." : `Ask about ${activeTable || "your table"}...`}
            disabled={isLoading}
            autoComplete="off"
          />
          <button
            type="submit"
            style={{ ...cs.sendBtn, ...(isLoading || !input.trim() ? cs.sendBtnDisabled : {}) }}
            disabled={isLoading || !input.trim()}
          >
            {isLoading ? (
              <div style={cs.spinner} />
            ) : (
              <SendHorizontal size={14} />
            )}
          </button>
        </form>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
        @keyframes dotBounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-5px); opacity: 1; }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
// Inline style tokens for the floating/fullscreen chat panel and message cards.
const cs: Record<string, CSSProperties> = {
  panel: {
    position: "fixed",
    bottom: 24,
    right: 24,
    width: 420,
    height: 580,
    background: "#0d0d0d",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#2a2a2a",
    borderRadius: 12,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(249,115,22,0.08)",
    zIndex: 300,
    animation: "slideUp 0.25s ease",
    fontFamily: "'JetBrains Mono', monospace",
  },
  panelFullscreen: {
    width: "100vw",
    height: "100vh",
    bottom: 0,
    right: 0,
    borderRadius: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px",
    borderBottom: "1px solid #1a1a1a",
    background: "#0a0a0a",
    flexShrink: 0,
  },
  headerTitle: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    color: "#f0f0f0",
    letterSpacing: "-0.2px",
  },
  headerSub: {
    fontSize: 10,
    color: "#555",
    marginTop: 1,
  },
  threadBar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 10px",
    borderBottom: "1px solid #1a1a1a",
    background: "#0a0f0a",
    overflowX: "auto",
    flexShrink: 0,
  },
  newThreadBtn: {
    border: "1px solid #304f17",
    background: "#13220a",
    color: "#b7f37d",
    borderRadius: 999,
    fontSize: 11,
    padding: "5px 10px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  threadLabel: {
    fontSize: 10,
    color: "#6e7d69",
    marginLeft: 2,
    whiteSpace: "nowrap",
  },
  threadChip: {
    border: "1px solid #273227",
    background: "#111711",
    color: "#c7d2c4",
    borderRadius: 999,
    fontSize: 10,
    padding: "5px 9px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  threadChipActive: {
    border: "1px solid #67e8f9",
    background: "#0e1f24",
    color: "#bff4ff",
  },
  orb: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    background: "#001c0b",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#002a0a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  orbInner: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#80FF00",
    boxShadow: "0 0 8px rgba(249,115,22,0.6)",
    transition: "all 0.3s",
  },
  orbPulsing: {
    animation: "pulse 1.2s ease-in-out infinite",
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    padding: "5px 6px",
    borderRadius: 5,
    display: "flex",
    alignItems: "center",
    transition: "color 0.15s",
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: 6,
    paddingTop: 24,
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: "50%",
    background: "#001c0b",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#002a0a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 13,
    color: "#888",
    fontFamily: "'Syne', sans-serif",
    fontWeight: 600,
  },
  emptyStarters: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "center",
    marginTop: 16,
    padding: "0 8px",
  },
  starterBtn: {
    fontSize: 11,
    color: "#888",
    background: "#141414",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 20,
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 12,
    paddingRight: 12,
    cursor: "pointer",
    transition: "all 0.15s",
    fontFamily: "inherit",
  },
  message: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
  },
  messageUser: {
    flexDirection: "row-reverse",
  },
  messageAssistant: {
    flexDirection: "row",
  },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.5px",
    flexShrink: 0,
  },
  avatarUser: {
    background: "#001c0b",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#002a0a",
    color: "#80FF00",
  },
  avatarAssistant: {
    background: "#111",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    color: "#666",
  },
  messageBody: {
    maxWidth: "82%",
    color: "#ccc",
    lineHeight: 1.65,
  },
  typingDots: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "10px 0",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#80FF00",
    display: "inline-block",
    animation: "dotBounce 1.2s ease-in-out infinite",
  },
  footer: {
    borderTop: "1px solid #1a1a1a",
    background: "#0a0a0a",
    flexShrink: 0,
  },
  langRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "8px 14px 6px",
    overflowX: "auto",
  },
  langLabel: {
    fontSize: 9,
    color: "#3a3a3a",
    letterSpacing: "0.8px",
    fontWeight: 600,
    flexShrink: 0,
    marginRight: 2,
  },
  langBtn: {
    fontSize: 10,
    color: "#444",
    background: "transparent",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#1e1e1e",
    borderRadius: 4,
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 7,
    paddingRight: 7,
    cursor: "pointer",
    transition: "all 0.15s",
    fontFamily: "inherit",
    flexShrink: 0,
    whiteSpace: "nowrap",
  },
  langBtnActive: {
    color: "#80FF00",
    borderColor: "#002a0a",
    background: "#001c0b",
  },
  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px 14px",
  },
  input: {
    flex: 1,
    padding: "9px 12px",
    background: "#111",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#222",
    borderRadius: 8,
    color: "#e0e0e0",
    fontSize: 12,
    fontFamily: "inherit",
    outline: "none",
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    background: "#80FF00",
    border: "none",
    color: "#000",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "all 0.15s",
  },
  sendBtnDisabled: {
    background: "#1a1a1a",
    color: "#333",
    cursor: "not-allowed",
  },
  spinner: {
    width: 12,
    height: 12,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "#333",
    borderTop: "2px solid #80FF00",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  codeBlock: {
    background: "#080808",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#1f1f1f",
    borderRadius: 6,
    overflow: "hidden",
    marginTop: 8,
    marginBottom: 8,
  },
  codeLang: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "1px",
    color: "#80FF00",
    background: "#111",
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 12,
    paddingRight: 12,
    borderBottom: "1px solid #1a1a1a",
    textTransform: "uppercase",
  },
  codePre: {
    margin: 0,
    padding: "12px",
    fontSize: 11,
    lineHeight: 1.7,
    color: "#d1d5db",
    overflowX: "auto",
    fontFamily: "'JetBrains Mono', monospace",
    whiteSpace: "pre",
  },
  inlineCode: {
    fontSize: 11,
    color: "#a7f3d0",
    background: "#0d1f18",
    borderRadius: 3,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 4,
    paddingRight: 4,
    fontFamily: "'JetBrains Mono', monospace",
  },
  execCard: {
    marginTop: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#1b2c14",
    borderRadius: 8,
    background: "#0a1208",
    padding: "10px 10px 9px",
  },
  execMetaRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  execTag: {
    fontSize: 10,
    color: "#80FF00",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#264d12",
    borderRadius: 10,
    padding: "2px 7px",
    background: "#0b1a06",
    fontWeight: 700,
  },
  execTable: {
    fontSize: 10,
    color: "#6b8a5f",
  },
  execInputs: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
    marginBottom: 8,
  },
  execInputLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 10,
    color: "#8da08a",
  },
  execInput: {
    background: "#0f1a0c",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#24381c",
    borderRadius: 6,
    color: "#d8e4d1",
    fontSize: 11,
    padding: "6px 8px",
    outline: "none",
    fontFamily: "inherit",
  },
  execActionRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  execBtn: {
    background: "#80FF00",
    color: "#051002",
    border: "none",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  execBtnDisabled: {
    opacity: 0.6,
    cursor: "wait",
  },
  execToggle: {
    background: "transparent",
    color: "#80FF00",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#23401a",
    borderRadius: 6,
    padding: "5px 9px",
    fontSize: 10,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  execError: {
    marginTop: 8,
    color: "#f87171",
    fontSize: 11,
  },
  execSummary: {
    marginTop: 8,
    fontSize: 11,
    color: "#9bcf84",
  },
  execRows: {
    marginTop: 8,
    background: "#050805",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#192b14",
    borderRadius: 6,
    padding: "9px",
    maxHeight: 230,
    overflow: "auto",
    fontSize: 10,
    lineHeight: 1.5,
    color: "#cfe5bf",
    whiteSpace: "pre",
  },
};
