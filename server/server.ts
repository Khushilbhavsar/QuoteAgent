/**
 * HTTP API — `npm run serve` starts a web server that wraps the same agent
 * loop the CLI uses. It is the backend for the React chat widget.
 *
 * Endpoints:
 *   GET  /api/health   → { ok: true }                    (hosting health check)
 *   POST /api/chat     { sessionId, message }            → { sessionId, state, reply, quoteDraft? }
 *   POST /api/approve  { sessionId, approved: boolean }  → { sessionId, state, reply }
 *
 * The agent's human-in-the-loop approval can't block an HTTP request, so a
 * run that reaches create_quote_request PAUSES: /api/chat returns
 * state:"pending_approval" with the draft, we stash a resumable snapshot in
 * the session, and /api/approve resumes it with the customer's decision.
 *
 * Sessions live in an in-memory Map. That is a deliberate free-tier choice —
 * production would use Redis or a database so sessions survive restarts and
 * scale across instances. See the comments on `sessions` below.
 */
import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Content } from "@google/genai";
import { runAgentTurn, resumeAgentTurn, type PausedRun } from "./agent/loop";
import { withinLastHour } from "./ratelimit";

dotenv.config({ quiet: true });
// This machine has a placeholder GOOGLE_API_KEY in the system environment;
// remove it so the SDK never gets confused (we always pass GEMINI_API_KEY).
delete process.env.GOOGLE_API_KEY;

// ------------------------------------------------------------ configuration

const PORT = Number(process.env.PORT ?? 8787);
// The widget's origin, e.g. https://quoteagent.vercel.app. Only this origin
// may call the API from a browser (CORS). Defaults to the Vite dev server.
const WIDGET_ORIGIN = process.env.WIDGET_ORIGIN ?? "http://localhost:5173";

const SESSION_TTL_MS = 30 * 60 * 1000; // sessions expire after 30 min idle
const MAX_MESSAGE_LENGTH = 500;
const MAX_MESSAGES_PER_SESSION_PER_HOUR = 20;
const MAX_SESSIONS_PER_IP_PER_HOUR = 5;

// ------------------------------------------------------------ session store

/**
 * One conversation. In-memory only: a server restart drops every session,
 * and this does NOT scale beyond a single instance. Production would persist
 * this in Redis/a DB keyed by sessionId. Fine for a free-tier single-instance
 * demo, and honest about the trade-off.
 */
interface Session {
  history: Content[];
  /** Set when a run is paused awaiting quote approval; null otherwise. */
  paused: PausedRun | null;
  /** Epoch ms of the last activity — used for the 30-min expiry. */
  lastActivity: number;
  /** Epoch ms of recent messages — used for the per-session rate limit. */
  messageTimes: number[];
}

const sessions = new Map<string, Session>();
/** Per-IP timestamps of NEW sessions created — for the per-IP rate limit. */
const ipNewSessions = new Map<string, number[]>();

/** Drop sessions idle for longer than the TTL. Called on every request. */
function sweepExpiredSessions(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

/** Best-effort client IP behind a proxy (Render/Vercel set x-forwarded-for). */
function clientIp(headerValue: string | undefined): string {
  if (headerValue === undefined) return "unknown";
  return headerValue.split(",")[0]?.trim() || "unknown";
}

// ------------------------------------------------------------ app

const app = new Hono();

// CORS: only the widget's origin may call us from a browser. The API key
// never leaves the server, so the browser only ever talks to THIS API.
app.use(
  "/api/*",
  cors({
    origin: WIDGET_ORIGIN,
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/chat", async (c) => {
  const now = Date.now();
  sweepExpiredSessions(now);

  let body: { sessionId?: unknown; message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (sessionId === "") {
    return c.json({ error: "A sessionId is required." }, 400);
  }
  if (message === "") {
    return c.json({ error: "Message cannot be empty." }, 400);
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return c.json(
      {
        sessionId,
        state: "error",
        reply: `That message is too long (${message.length} characters). Please keep it under ${MAX_MESSAGE_LENGTH} characters.`,
      },
      400,
    );
  }

  // Find or create the session.
  let session = sessions.get(sessionId);
  if (session === undefined) {
    // New session → charge it against the per-IP session-creation limit.
    const ip = clientIp(c.req.header("x-forwarded-for"));
    const recent = withinLastHour(ipNewSessions.get(ip) ?? [], now);
    if (recent.length >= MAX_SESSIONS_PER_IP_PER_HOUR) {
      return c.json(
        {
          sessionId,
          state: "rate_limited",
          reply: "Too many new chats from your network in the last hour. Please try again later.",
        },
        429,
      );
    }
    recent.push(now);
    ipNewSessions.set(ip, recent);
    session = { history: [], paused: null, lastActivity: now, messageTimes: [] };
    sessions.set(sessionId, session);
  }

  // Per-session message rate limit.
  session.messageTimes = withinLastHour(session.messageTimes, now);
  if (session.messageTimes.length >= MAX_MESSAGES_PER_SESSION_PER_HOUR) {
    return c.json(
      {
        sessionId,
        state: "rate_limited",
        reply: `You've reached the limit of ${MAX_MESSAGES_PER_SESSION_PER_HOUR} messages per hour. Please try again later.`,
      },
      429,
    );
  }
  session.messageTimes.push(now);
  session.lastActivity = now;

  // If a quote is already awaiting approval, steer the user to decide first.
  if (session.paused !== null) {
    return c.json({
      sessionId,
      state: "pending_approval",
      reply: "You have a quote awaiting your approval. Please approve or decline it first.",
      quoteDraft: (session.paused.draftEnvelope as { quoteDraft?: unknown }).quoteDraft,
    });
  }

  try {
    const outcome = await runAgentTurn(message, session.history, { pauseOnApproval: true });
    session.lastActivity = Date.now();

    if (outcome.status === "pending_approval") {
      session.paused = outcome.paused;
      return c.json({
        sessionId,
        state: "pending_approval",
        reply: "Please review the quote below and approve or decline it.",
        quoteDraft: outcome.pending.quoteDraft,
      });
    }

    return c.json({ sessionId, state: "done", reply: outcome.result.finalText });
  } catch (error) {
    console.error("[/api/chat] agent error:", error);
    return c.json(
      {
        sessionId,
        state: "error",
        reply:
          "Sorry — something went wrong on our side. Please try again, or email support@ductstore.example.",
      },
      500,
    );
  }
});

app.post("/api/approve", async (c) => {
  const now = Date.now();
  sweepExpiredSessions(now);

  let body: { sessionId?: unknown; approved?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (sessionId === "") {
    return c.json({ error: "A sessionId is required." }, 400);
  }
  if (typeof body.approved !== "boolean") {
    return c.json({ error: "`approved` must be true or false." }, 400);
  }

  const session = sessions.get(sessionId);
  if (session === undefined) {
    return c.json(
      {
        sessionId,
        state: "error",
        reply: "Your session has expired. Please start a new chat.",
      },
      404,
    );
  }
  if (session.paused === null) {
    return c.json(
      { sessionId, state: "error", reply: "There is no quote awaiting approval." },
      400,
    );
  }

  session.lastActivity = now;
  const paused = session.paused;
  session.paused = null; // consume it; resume may set a new one below

  try {
    const outcome = await resumeAgentTurn(paused, body.approved, { pauseOnApproval: true });
    session.lastActivity = Date.now();

    if (outcome.status === "pending_approval") {
      session.paused = outcome.paused;
      return c.json({
        sessionId,
        state: "pending_approval",
        reply: "Please review the updated quote and approve or decline it.",
        quoteDraft: outcome.pending.quoteDraft,
      });
    }

    return c.json({ sessionId, state: "done", reply: outcome.result.finalText });
  } catch (error) {
    console.error("[/api/approve] agent error:", error);
    return c.json(
      {
        sessionId,
        state: "error",
        reply: "Sorry — something went wrong finishing that quote. Please try again.",
      },
      500,
    );
  }
});

// ------------------------------------------------------------ start

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "Warning: GEMINI_API_KEY is not set — the agent will error on first message.\n" +
      "Copy .env.example to .env and add your key from https://aistudio.google.com/apikey\n",
  );
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`QuoteAgent API listening on http://localhost:${info.port}`);
  console.log(`CORS allowed origin: ${WIDGET_ORIGIN}`);
});

export { app };
