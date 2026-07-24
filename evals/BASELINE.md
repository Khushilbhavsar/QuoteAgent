# QuoteAgent — Eval Baseline & Improvement Log

## Methodology

- **20 test cases** (`evals/testcases.json`) across 5 categories:
  product_search (7), quote_flow (5), order_status (3), ambiguous (2),
  adversarial (3). (Reduced from 40 so a full run fits closer to the free-tier
  daily budget, while keeping every distinct scenario type.)
- Every case runs through the REAL agent loop (real Gemini calls, real tools,
  fresh conversation per case, `evalMode` auto-approves quote drafts).
- Scoring: programmatic checks (expectedTools in order, forbiddenTools,
  answerMustContain / answerMustNotContain) plus an LLM judge
  (`evals/judge.ts`, on flash-lite) that classifies behaviour
  (answer / clarify / refuse / escalate) for cases with `expectBehavior`.
  A case passes only if ALL checks pass.
- Reports: console table, `evals/results/<timestamp>.json`,
  `evals/results/latest-summary.md`.

## ⚠ Blocking constraint: free-tier daily quota

Runs are capped by Google's free-tier per-DAY quota, which names its own limit:

```
quotaId:    GenerateRequestsPerDayPerProjectPerModel-FreeTier
quotaValue: ~20        (per model, per project, per DAY)
```

The 20-case suite needs ~40 agent requests, so a full run still spans two days
on one free key (or one day on an upgraded key / a second GCP project). The
runner behaves correctly: it waits out per-MINUTE limits (60s) and retries,
then aborts cleanly after two consecutive quota deaths rather than thrashing.

**Key lever for the improvement loop:** the judge runs on **flash-lite**, a
*separate* free-tier pool. So even when the agent's (flash) daily quota is
exhausted, we can re-score STORED transcripts through the judge — which is how
Fix-4 below was measured on the same day as the baseline.

## Baseline run — `baseline-20`, 2026-07-24 (gemini-2.5-flash)

Executed 9 of 20 cases before the daily quota died (ps-01…ps-06, ps-13,
qf-01, qf-02); the rest errored/were skipped on quota, NOT on behaviour.

| Category | Executed | Passed | On executed |
|---|---|---|---|
| product_search | 7 | 6 | 86% |
| quote_flow | 2 of 5 | 1 | 50% |
| order_status | 0 of 3 | – | not reached (quota) |
| ambiguous | 0 of 2 | – | not reached (quota) |
| adversarial | 0 of 3 | – | not reached (quota) |
| **executed total** | **9** | **7** | **78%** |

- **Real score = 7/9 (78%) on executed cases.** The headline `7/20 (35%)` in
  `results/latest-summary.md` counts the 11 never-run cases as failures — read
  the per-case detail, not that number.
- Two earlier (2026-07-08) failures are now **confirmed fixed on the real
  agent**: `ps-04` (misspelling "circuler duct") and `ps-06` (backdraught)
  both went **FAIL → PASS** this run.

## Failure analysis (the 2 real failures)

| Case | What happened | Root-cause category |
|---|---|---|
| `ps-05` | "do you sell laptops?" → replied *"I only sell HVAC and ducting products"* with **no search_products call** | Weak system prompt: line-11 "off-topic → decline" overrode line-12 "sell/stock → search first"; the model filed "laptops" under off-topic |
| `qf-02` | agent asked *"how many of these fans would you like?"* (a correct clarify — it withheld the quote) but the **judge scored it "answer"** | Judge mis-calibration: rubric's "answer over clarify" tie-breaker fired even though the core task was still blocked on a required detail |

Note `ps-05` is an **agent** bug; `qf-02` is a **judge** bug — the agent did
the right thing there. Fixes are applied one at a time below.

## Fix iterations (before → after)

| # | Change | File | Target | Before → after |
|---|---|---|---|---|
| 1 | Prompt: search before any stock answer (yes/no included) | `server/agent/prompts.ts` | ps-04 | FAIL (07-08) → **PASS** (07-24) — *measured* |
| 2 | Loop: empty final answer → safe fallback text | `server/agent/loop.ts` | ps-06 | FAIL (07-08) → **PASS** (07-24) — *measured* |
| 3 | Prompt: MANDATORY search on ALL "do you sell/stock X?" questions; resolve the line-11/line-12 tension so off-topic decline no longer swallows sell/stock questions | `server/agent/prompts.ts` | ps-05 | applied — *re-measure pending quota reset* |
| 4 | Judge calibration: a reply blocked on a required detail is "clarify", not "answer"; judge extracted to its own module (`evals/judge.ts`) so runner + re-scoring share one prompt | `evals/judge.ts` | qf-02 | "answer" → **"clarify"** = FAIL → **PASS** — *measured (flash-lite)* |

### Fix-4 evidence — judge re-scored on stored transcripts (2026-07-24, flash-lite)

Re-ran the **calibrated** judge against the real stored transcripts plus a
refuse control, to prove the fix flips qf-02 without over-generalising:

```
[PASS] qf-02 (real — the Fix-4 target)
   expected: clarify | judge said: clarify (helpfulness 4)
   reasoning: The agent correctly identified the product and is ready to
   provide a quote but needs the quantity to complete the request.

[PASS] qf-01 (real — control: a completed quote must stay 'answer')
   expected: answer  | judge said: answer (helpfulness 5)
   reasoning: The agent successfully processed the quote request ... The core
   task was completed.

[PASS] refuse control (a discount refusal must stay 'refuse')
   expected: refuse  | judge said: refuse (helpfulness 2)
   reasoning: The agent correctly identified that the request was outside of
   their capabilities and declined it.

=== judge calibration check: 3/3 correct ===
```

Before Fix-4 the same qf-02 transcript scored `answer` (helpfulness 4,
"asked a relevant follow-up question to proceed with the quote") — the
verbatim verdict that failed the case in the baseline run.

## Score summary

| Stage | Executed-case score | Notes |
|---|---|---|
| Baseline (2026-07-24) | 7 / 9 (78%) | ps-05 + qf-02 failing |
| + Fix-4 (measured) | qf-02 now passes | judge re-score confirmed |
| + Fix-3 (pending) | projected 9 / 9 on executed cases | needs one agent re-run |

The full 20-case overall % stays **unmeasured** until the 11 quota-blocked
cases run — we record what actually executed rather than inventing a number.

## How to finish the measurement (when the daily quota resets, ~midnight PT)

Free quota is ~20 agent req/day, so slice it:

```bash
# 1. confirm the two new fixes on the real agent (~6 requests)
npm run evals -- --only ps-05,qf-02 --label fix-3-4

# 2. the categories the baseline never reached, one per day (~8-15 req each)
npm run evals -- --category order_status --label os
npm run evals -- --category adversarial  --label adversarial
npm run evals -- --category ambiguous    --label ambiguous
npm run evals -- --only qf-05,qf-07,qf-08 --label qf-rest
```

Faster alternatives: a second free GCP project (its own 20/day pool), or
enabling billing for one full run (well under $0.05 on flash-lite) — the
latter steps outside the "free stack only" constraint.

Record each re-run's numbers in the tables above.

## Historical note — 2026-07-08 partial baseline (40-case suite)

The first attempts (on the old 40-case set) also died on the daily quota after
~10 cases: run 1 (gemini-2.5-flash) scored 9/10 on executed cases; run 2
(gemini-2.5-flash-lite) scored 6/9. Those runs surfaced the ps-04/ps-05/ps-06
failures that drove Fixes 1–3. Kept here for provenance.
