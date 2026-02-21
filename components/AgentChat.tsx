"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import { useState, useRef, useEffect, useMemo, CSSProperties } from "react";

// ─── Types ─────────────────────────────────────────────────────────────────
interface AgentChatProps {
  activeTable: string;
  schema: {
    pk: string;
    sk: string | null;
    gsi: string[];
  } | null;
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

// ─── Language options for quick-insert prompts ────────────────────────────
const LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Java", "Rust"] as const;
type Language = (typeof LANGUAGES)[number];

// ─── Quick prompt starters ────────────────────────────────────────────────
const STARTERS = [
  { label: "Explain this table", prompt: "Explain this table's schema and what access patterns it supports." },
  { label: "Suggest optimizations", prompt: "Analyze this table and suggest any GSI, billing mode, or key design improvements." },
  { label: "Generate a query", prompt: "Generate a TypeScript query to get all items by the partition key." },
  { label: "What indexes should I add?", prompt: "Based on common access patterns, what indexes should I consider adding to this table?" },
];

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

  return payloads;
}

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
        // Render inline markdown: **bold** and `code`
        const inline = part.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
        return (
          <span key={i}>
            {inline.map((chunk, j) => {
              if (chunk.startsWith("**") && chunk.endsWith("**"))
                return (
                  <strong key={j} style={{ color: "#f0f0f0" }}>
                    {chunk.slice(2, -2)}
                  </strong>
                );
              if (chunk.startsWith("`") && chunk.endsWith("`"))
                return (
                  <code key={j} style={cs.inlineCode}>
                    {chunk.slice(1, -1)}
                  </code>
                );
              // Render newlines as <br>
              return chunk.split("\n").map((line, k, arr) => (
                <span key={k}>
                  {line}
                  {k < arr.length - 1 && <br />}
                </span>
              ));
            })}
          </span>
        );
      })}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────
export default function AgentChat({ activeTable, schema, onClose }: AgentChatProps) {
  const [selectedLang, setSelectedLang] = useState<Language>("TypeScript");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [input, setInput] = useState("");
  const [execStates, setExecStates] = useState<Record<string, ExecutionState>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent",
        body: { activeTable, schema },
      }),
    [activeTable, schema],
  );

  const { messages, sendMessage, status } = useChat({
    transport,
  });
  const isLoading = status === "submitted" || status === "streaming";

  const extractTextContent = (message: UIMessage): string =>
    message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");

  const ensureExecState = (key: string): ExecutionState =>
    execStates[key] ?? {
      prompted: false,
      isRunning: false,
      expanded: false,
      error: null,
      result: null,
      inputValues: {},
    };

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

  const setExecInputValue = (key: string, inputName: string, value: string) => {
    updateExecState(key, (prev) => ({
      ...prev,
      prompted: true,
      inputValues: { ...prev.inputValues, [inputName]: value },
    }));
  };

  const hasMissingRequiredInputs = (payload: ExecPayload, state: ExecutionState): boolean =>
    (payload.inputSchema ?? []).some((field) => field.required && !(state.inputValues[field.name] ?? "").toString().trim());

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
          activeTable,
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

  const submitStarter = async (prompt: string) => {
    if (!prompt.trim() || isLoading) return;
    await sendMessage({ text: prompt.trim() });
    setInput("");
  };

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
              {activeTable ? (
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isFullscreen ? (
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              ) : (
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              )}
            </svg>
          </button>
          <button style={cs.iconBtn} onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Messages ── */}
      <div style={cs.messages}>
        {messages.length === 0 ? (
          <div style={cs.empty}>
            <div style={cs.emptyIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#80FF00" strokeWidth="1.5">
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            </div>
            <div style={cs.emptyTitle}>Ask me anything about</div>
            <div style={{ ...cs.emptyTitle, color: "#80FF00" }}>{activeTable || "your DynamoDB tables"}</div>
            <div style={cs.emptyStarters}>
              {STARTERS.map((s) => (
                <button key={s.label} style={cs.starterBtn} onClick={() => submitStarter(s.prompt)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const rawContent = extractTextContent(msg);
            const structuredExecPayloads = msg.role === "assistant" ? parseExecPayloads(rawContent) : [];
            const execPayloads =
              msg.role === "assistant" && structuredExecPayloads.length === 0
                ? inferExecPayloadsFromCode(rawContent, activeTable)
                : structuredExecPayloads;
            const displayContent = msg.role === "assistant" ? stripExecBlocks(rawContent) : rawContent;

            return (
              <div key={msg.id} style={{ ...cs.message, ...(msg.role === "user" ? cs.messageUser : cs.messageAssistant) }}>
                <div style={{ ...cs.avatar, ...(msg.role === "user" ? cs.avatarUser : cs.avatarAssistant) }}>{msg.role === "user" ? "U" : "AI"}</div>
                <div style={cs.messageBody}>
                  {msg.role === "assistant" ? (
                    <>
                      <MessageContent content={displayContent} />
                      {execPayloads.map((payload, index) => {
                        const stateKey = `${msg.id}:${index}`;
                        const state = ensureExecState(stateKey);
                        const requiredMissing = hasMissingRequiredInputs(payload, state);
                        const inputSchema = payload.inputSchema ?? [];
                        const showInputs = inputSchema.length > 0 && (state.prompted || Boolean(state.result));

                        return (
                          <div key={stateKey} style={cs.execCard}>
                            <div style={cs.execMetaRow}>
                              <span style={cs.execTag}>{payload.operation}</span>
                              <span style={cs.execTable}>Table: {payload.tableName || activeTable || "current table"}</span>
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
                                <button
                                  style={cs.execToggle}
                                  onClick={() => updateExecState(stateKey, (prev) => ({ ...prev, expanded: !prev.expanded }))}
                                >
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
                      })}
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
            placeholder={`Ask about ${activeTable || "your table"}...`}
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
              </svg>
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
