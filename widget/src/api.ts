/**
 * Tiny API client for the QuoteAgent server. Handles three real-world
 * conditions the widget must survive on a free host:
 *   - cold start: Render's free tier sleeps after 15 min idle and takes
 *     ~30-60s to wake. If a request is still pending after SLOW_MS, we call
 *     onSlow() so the UI can show a "waking the server" note.
 *   - hard timeout: give up after TIMEOUT_MS instead of hanging forever.
 *   - network failure: throw so the caller can offer a Retry button.
 */
import type { ChatResponse, ChatState, QuoteDraft } from "./types";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8787";
const SLOW_MS = 5000;
const TIMEOUT_MS = 90_000;

const VALID_STATES: ChatState[] = ["done", "pending_approval", "rate_limited", "error"];

/** Coerce whatever the server returned into a well-formed ChatResponse. */
function normalise(data: unknown, sessionId: string): ChatResponse {
  const obj = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const state =
    typeof obj.state === "string" && (VALID_STATES as string[]).includes(obj.state)
      ? (obj.state as ChatState)
      : "error";
  const reply =
    typeof obj.reply === "string"
      ? obj.reply
      : typeof obj.error === "string"
        ? obj.error
        : "Sorry — the assistant returned an unexpected response.";
  return {
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : sessionId,
    state,
    reply,
    quoteDraft: obj.quoteDraft as QuoteDraft | undefined,
  };
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  onSlow?: () => void,
): Promise<ChatResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const slowId = onSlow ? setTimeout(onSlow, SLOW_MS) : undefined;
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data: unknown = await res.json().catch(() => ({}));
    return normalise(data, typeof body.sessionId === "string" ? body.sessionId : "");
  } finally {
    clearTimeout(timeoutId);
    if (slowId !== undefined) clearTimeout(slowId);
  }
}

export function sendMessage(
  sessionId: string,
  message: string,
  onSlow?: () => void,
): Promise<ChatResponse> {
  return postJson("/api/chat", { sessionId, message }, onSlow);
}

export function sendApproval(
  sessionId: string,
  approved: boolean,
  onSlow?: () => void,
): Promise<ChatResponse> {
  return postJson("/api/approve", { sessionId, approved }, onSlow);
}
