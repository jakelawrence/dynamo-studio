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
          messages.map((msg) => (
            <div key={msg.id} style={{ ...cs.message, ...(msg.role === "user" ? cs.messageUser : cs.messageAssistant) }}>
              <div style={{ ...cs.avatar, ...(msg.role === "user" ? cs.avatarUser : cs.avatarAssistant) }}>{msg.role === "user" ? "U" : "AI"}</div>
              <div style={cs.messageBody}>
                {msg.role === "assistant" ? (
                  <MessageContent content={extractTextContent(msg)} />
                ) : (
                  <span style={{ fontSize: 13, lineHeight: 1.65 }}>{extractTextContent(msg)}</span>
                )}
              </div>
            </div>
          ))
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
};
