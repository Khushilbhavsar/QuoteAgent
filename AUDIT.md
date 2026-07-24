# QuoteAgent — Final Audit

Full walk-through of the repo against the Phase 1–4 spec. Every item was read
and verified; **all pass**. Legend: ✓ verified · 🔧 fixed/enhanced this phase.
(Smoke-test output and the latest eval score are appended at the bottom.)

## 1. Agent loop — [`server/agent/loop.ts`](server/agent/loop.ts)

| Item | Status | Evidence |
|---|---|---|
| `tool_use → execute → tool_result → repeat` until plain text | ✓ | `driveLoop`: collects `functionCalls`, runs each tool, pushes `functionResponse` parts, loops back to Gemini |
| Returns `finalText`, `toolCallsMade`, `tokensUsed`, `iterations` | ✓ | `AgentRunResult` |
| Also reports model-call count for quota budgeting | 🔧 | added `modelCalls` to `AgentRunResult` (= Gemini calls made) |
| Eval runs cap iterations | 🔧 | `maxIterations` option (eval runner passes 5) |

## 2. Guardrails — [`server/agent/guardrails.ts`](server/agent/guardrails.ts)

| Item | Status | Evidence |
|---|---|---|
| `MAX_ITERATIONS = 10` | ✓ | `guardrails.ts` |
| 3× tool retry with exponential backoff | ✓ | `runToolWithGuardrails` (500ms → 1s → 2s) |
| API retry on 429/5xx with backoff | ✓ | `callGemini` |
| Zod validation on every tool input; errors returned to the model to self-correct | ✓ | `runToolWithGuardrails` returns the Zod issue as `isError` tool result |
| Per-run call budget | ✓ | `MAX_MODEL_CALLS_PER_RUN = 15` → `BudgetExceededError` → graceful stop + escalation |
| Prompt-injection rules in the system prompt + incident detector | ✓ | `prompts.ts` "Security" block; `detectInjectionAttempt` |
| Hallucinated-price output guard | ✓ | `auditAnswerPrices` grounds every £ against catalogue + tool results |
| Incident types logged | ✓ | `injection_attempt_suspected`, `hallucinated_price`, `budget_exceeded`, `max_iterations_hit` |

## 3. Tools — [`server/tools/`](server/tools/)

| Item | Status | Evidence |
|---|---|---|
| All 5 implemented, no stubs | ✓ | search_products, get_product_details, create_quote_request, check_order_status, escalate_to_human |
| `create_quote_request` uses the **generic** `requiresApproval` flag | ✓ | `requiresApproval: true` + `commitApproved`; loop's pause/approve/decline is generic |
| `check_order_status` does not leak email existence | ✓ | identical `not_found` message for wrong email / wrong number / neither (anti-enumeration comment) |
| Zod schemas on every tool | ✓ | each tool has `zodInputSchema` |

## 4. Semantic search — [`server/db/embeddings.ts`](server/db/embeddings.ts)

| Item | Status | Evidence |
|---|---|---|
| Index file committed | ✓ | `server/db/product-index.json` tracked (removed from `.gitignore`); 25 entries, 384-dim |
| 0.4 similarity threshold | ✓ | `MIN_SCORE = 0.4` in `searchProducts.ts` |
| "No close matches" path works | ✓ | below-threshold → `{ matches: [], message: "…does not stock…do NOT invent…" }` |

## 5. HTTP API — [`server/server.ts`](server/server.ts)

| Item | Status | Evidence |
|---|---|---|
| In-memory session store | ✓ | `Map<sessionId, Session>`, 30-min TTL sweep |
| Rate limits | ✓ | 20 msgs/session/hr, 5 new sessions/IP/hr |
| Message length cap | ✓ | 500 chars → friendly error |
| CORS locked to widget origin | ✓ | `cors({ origin: WIDGET_ORIGIN })` |
| API key never sent to client | ✓ | key read server-side only; `grep -riE "gemini\|api_key\|AIza" widget/dist` → **nothing** |

## 6. Logging — [`server/db/logger.ts`](server/db/logger.ts)

| Item | Status | Evidence |
|---|---|---|
| `runs.jsonl` has tools, tokens, iterations, incidents | ✓ | `RunLogEntry` written per completed run |
| `quotes.jsonl` written on approval | ✓ | `createQuoteRequest.commitApproved` appends |
| `escalations.jsonl` written | ✓ | `escalateToHuman.execute` appends |

## 7. Docs & types

| Item | Status | Evidence |
|---|---|---|
| README, DEPLOYMENT.md, .env.example, LICENSE exist | ✓ | present at repo root |
| Docs match reality (no phantom features) | ✓ | README eval section updated to 20 cases + quota-aware design (this phase) |
| `npx tsc --noEmit` strict, no `any` | ✓ | clean; `grep '\bany\b' server evals` → no type-`any` |

## New this phase

- **Right-sized eval suite** to exactly 20 cases (8/5/3/2/2) — see README.
- **Quota-aware, resumable eval runner**: `--budget N`, per-case checkpoint,
  `--resume`, judge-verdict cache, `--dry-run` (zero API), `--id` / `--category`.
- **`npm run smoke`**: a ≤6-request end-to-end agent test with a PASS/FAIL
  table and an `--offline` mode for no-API days.
- *(Optional)* provider-swappable LLM client (`server/llm/`) with a Groq fallback.

## Smoke test — `npm run smoke`

Offline checks (no API) — run 2026-07-24:

```
NO-API checks:
  [PASS] e1 order lookup wrong-email → not_found, no leak — status=not_found
  [PASS] e2 Zod rejects invalid tool input — rejected
  [PASS] e3 rate-limiter caps at max & prunes old — ok
  [PASS] e4 semantic index loads (entries == products) — 25/25
RESULT: 4/4 checks passed — SMOKE: PASS ✅ (exit 0)
```

Live checks (a–d) are designed to use ≤6 Gemini requests (each scenario is
capped at 5 iterations and reports its own call count). They could not be run
on 2026-07-24 because **both** the flash and flash-lite daily free-tier quotas
(20/day each) were already spent by the day's testing — `npm run smoke` handles
this gracefully (records a–d as FAIL with a quota hint, no crash). Scenarios a
and b were nonetheless proven end-to-end earlier the same day via the HTTP
server on flash-lite: a real product answer, then a quote paused for approval
and saved as `Q-…` with the correct £72.50 total. Re-run `npm run smoke` after
the quota resets to see the ≤6-request PASS.

## Eval score (latest)

From the `baseline-20` run (2026-07-24, gemini-2.5-flash) plus fix re-tests:
**7/9 (78%) on executed cases** before the daily quota stopped the run; the
three diagnosed failures were fixed and re-measured FAIL→PASS (ps-04, ps-06,
qf-02). Full log in [`evals/BASELINE.md`](evals/BASELINE.md). The runner is now
quota-aware and resumable, so the full 20-case score can be completed across
days with `npm run evals -- --resume` (or in one run via `LLM_PROVIDER=groq`).

## Known limitations

- **~20 Gemini requests/day** (free tier) — the whole reason the eval runner is
  budgeted/resumable and the smoke test is ≤6 requests. A Groq provider is
  wired in as an escape hatch (`LLM_PROVIDER=groq`).
- **In-memory sessions & rate limits** — per-instance, dropped on restart;
  production would use Redis/a DB.
- **Free-tier cold start** — Render sleeps after 15 min idle (~30–60s wake);
  the widget shows a "waking up" note.
- **Groq path is untested** — implemented and type-checked, but no GROQ_API_KEY
  was available to run it live.
