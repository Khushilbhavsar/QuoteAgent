import { useEffect, useRef, useState } from "react";
import { sendApproval, sendMessage } from "./api";
import { ApprovalCard } from "./components/ApprovalCard";
import type { ChatMessage, ChatResponse, QuoteDraft } from "./types";

const MAX_MESSAGE_LENGTH = 500;

let messageCounter = 0;
const nextId = (): string => `m${++messageCounter}`;

const welcome: ChatMessage = {
  id: nextId(),
  role: "assistant",
  text: "Hi! I'm the Ducting Direct assistant. Ask me about products, prices, a quote, or an order.",
};

interface RequestError {
  message: string;
  retry: () => void;
}

export function App(): JSX.Element {
  // Session id lives in React memory only (no localStorage, per spec).
  const [sessionId] = useState<string>(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([welcome]);
  const [input, setInput] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [coldStart, setColdStart] = useState<boolean>(false);
  const [pendingDraft, setPendingDraft] = useState<QuoteDraft | null>(null);
  const [error, setError] = useState<RequestError | null>(null);

  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message / indicator.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, coldStart, pendingDraft]);

  const addMessage = (role: ChatMessage["role"], text: string): void => {
    setMessages((prev) => [...prev, { id: nextId(), role, text }]);
  };

  const handleResponse = (res: ChatResponse): void => {
    addMessage("assistant", res.reply);
    setPendingDraft(res.state === "pending_approval" ? (res.quoteDraft ?? null) : null);
  };

  // Runs one API call, managing busy / cold-start / error + retry uniformly.
  const runRequest = async (factory: () => Promise<ChatResponse>): Promise<void> => {
    setBusy(true);
    setColdStart(false);
    setError(null);
    try {
      const res = await factory();
      handleResponse(res);
    } catch {
      setError({
        message: "Couldn't reach the assistant. Check your connection and try again.",
        retry: () => void runRequest(factory),
      });
    } finally {
      setBusy(false);
      setColdStart(false);
    }
  };

  const submit = (): void => {
    const text = input.trim();
    if (text === "" || busy) return;
    if (text.length > MAX_MESSAGE_LENGTH) return; // guarded by maxLength too
    setInput("");
    addMessage("user", text);
    void runRequest(() => sendMessage(sessionId, text, () => setColdStart(true)));
  };

  const decide = (approved: boolean): void => {
    if (busy) return;
    addMessage("user", approved ? "Approved the quote." : "Declined the quote.");
    void runRequest(() => sendApproval(sessionId, approved, () => setColdStart(true)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="app">
      <div className="chat">
        <header className="chat__header">
          <span className="chat__dot" aria-hidden="true" />
          <div>
            <div className="chat__title">Ducting Direct assistant</div>
            <div className="chat__subtitle">Products &middot; quotes &middot; orders</div>
          </div>
        </header>

        <div className="chat__messages">
          {messages.map((m) => (
            <div key={m.id} className={`bubble bubble--${m.role}`}>
              {m.text}
            </div>
          ))}

          {pendingDraft !== null && (
            <ApprovalCard draft={pendingDraft} busy={busy} onDecision={decide} />
          )}

          {busy && !coldStart && (
            <div className="bubble bubble--assistant typing" aria-label="Assistant is typing">
              <span />
              <span />
              <span />
            </div>
          )}

          {coldStart && (
            <div className="notice">Waking up the server — this can take ~30 seconds on the free tier…</div>
          )}

          {error !== null && (
            <div className="notice notice--error">
              {error.message}
              <button type="button" className="btn btn--retry" onClick={error.retry} disabled={busy}>
                Retry
              </button>
            </div>
          )}

          <div ref={endRef} />
        </div>

        <div className="chat__input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={pendingDraft !== null ? "Approve or decline the quote above…" : "Type your message…"}
            maxLength={MAX_MESSAGE_LENGTH}
            rows={1}
            disabled={busy || pendingDraft !== null}
          />
          <button
            type="button"
            className="btn btn--send"
            onClick={submit}
            disabled={busy || pendingDraft !== null || input.trim() === ""}
          >
            Send
          </button>
        </div>
        <div className="chat__counter">
          {input.length}/{MAX_MESSAGE_LENGTH}
        </div>
      </div>
    </div>
  );
}
