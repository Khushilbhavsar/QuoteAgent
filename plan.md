Continue building "QuoteAgent" — Phase 4 (final). Phases 1–3 complete: 
Gemini agent loop (function calling), local semantic search 
(@xenova/transformers), 5 tools with human-approval flow on 
create_quote_request, hardened guardrails (injection resistance, price 
output guard, budgets, incident logging), full eval suite (40 cases, 
programmatic + LLM-judge scoring, BASELINE.md with improvement history), 
CLI chat. I am a beginner — briefly explain each new concept.

PHASE 4 SCOPE — HTTP API + React chat widget + free deployment.

1. HTTP API (convert CLI to a web server):
   - Use Hono or Express in server/index.ts. Endpoints:
     - POST /api/chat { sessionId, message } → runs the agent loop, 
       returns { reply, state: "done" | "pending_approval", 
       quoteDraft?, sessionId }
     - POST /api/approve { sessionId, approved: boolean } → resumes a 
       paused run, returns the agent's final confirmation
     - GET /api/health → { ok: true } (needed for hosting checks)
   - In-memory session store: Map<sessionId, conversationHistory + 
     pendingApprovalState>. Sessions expire after 30 min of inactivity. 
     Comment honestly that production would use Redis/DB — in-memory is 
     a deliberate free-tier choice
   - The Phase 2 CLI approval (readline y/n) must be refactored: the 
     loop PAUSES, persists pending state in the session, and resumes 
     when /api/approve is called. evalMode auto-approve must still work
   - Security & stability:
     - GEMINI_API_KEY stays server-side ONLY — never sent to the client
     - CORS restricted to the widget's origin (env var WIDGET_ORIGIN)
     - Simple rate limiting: max 20 messages per sessionId per hour, 
       max 5 sessions per IP per hour (in-memory, comment the 
       production alternative)
     - Message length cap (500 chars) with a friendly error
   - Keep `npm run chat` (CLI) working alongside the server

2. REACT CHAT WIDGET (widget/ — Vite + React + TypeScript):
   - Clean chat UI: header ("Ducting Direct assistant"), scrollable 
     message list, input box, send button, typing indicator while 
     waiting
   - Session: generate a sessionId (crypto.randomUUID) on load, keep in 
     memory (per requirements: NO localStorage — state in React only)
   - Approval UI: when state === "pending_approval", render the quote 
     draft as a card (items, quantities, prices, total) with Approve / 
     Decline buttons that call /api/approve and render the agent's 
     confirmation
   - Error states: rate-limited (show wait message), server cold-start 
     (show "waking up the server, ~30s" if a request takes >5s), 
     network failure (retry button)
   - Styling: plain CSS or CSS modules, mobile-friendly, no UI library 
     needed. Server URL from VITE_API_URL env var

3. FREE DEPLOYMENT:
   - Server → Render free tier (web service):
     - Add render.yaml + a build script; document env vars 
       (GEMINI_API_KEY, WIDGET_ORIGIN)
     - IMPORTANT: precompute the embeddings index locally (npm run 
       build-index) and COMMIT db/product-index.json so the server 
       never builds embeddings at boot. Pin the Xenova model download 
       at build time if possible; document cold-start behavior 
       (free tier sleeps after 15 min idle, ~30-60s wake)
   - Widget → Vercel free tier: set VITE_API_URL to the Render URL; 
     add vercel.json if needed
   - Write DEPLOYMENT.md: exact click-by-click steps for both, 
     including where to paste env vars, and how to test the live URL
   - Add root package.json scripts: dev (server + widget concurrently), 
     build, evals, build-index

4. PORTFOLIO POLISH (this is the hiring artifact):
   - Rewrite README.md as the front page of the project:
     a. One-paragraph pitch: what it does, for whom, and the headline 
        eval numbers (baseline → final from BASELINE.md)
     b. Architecture section: an ASCII or mermaid diagram of 
        widget → API → agent loop → tools, plus the approval flow
     c. Features table: 5 tools, guardrails list, eval methodology
     d. "Engineering decisions" section: provider-agnostic LLM client, 
        free-tier constraints (in-memory sessions, precomputed index, 
        rate limits), similarity threshold, human-in-the-loop design — 
        each with a one-line WHY
     e. "Failure cases & fixes" section: pull 3 real examples from 
        BASELINE.md (what failed, why, the fix, score impact)
     f. Live demo link + 30-second usage GIF placeholder + local setup
   - Add LICENSE (MIT) and .env.example files

REQUIREMENTS:
- Complete, self-contained files; TypeScript strict; no `any`
- Nothing paid, no credit card: Render free + Vercel free + Gemini free

ACCEPTANCE TESTS:
- Local: `npm run dev` → widget on localhost talks to server on 
  localhost; full chat + quote approval flow works end-to-end in the 
  browser (Approve saves to quotes.jsonl, Decline saves nothing)
- Rate limit: 21st message in an hour → friendly rate-limit reply
- Message over 500 chars → friendly error, no crash
- `npm run evals` still passes at the Phase 3 score (refactor must not 
  regress it) — run it and show me the summary
- Deployed: live Vercel URL chats with live Render URL; cold-start 
  message appears correctly after idle; approval flow works in 
  production
- README renders correctly on GitHub with all sections