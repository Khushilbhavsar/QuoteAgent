# QuoteAgent — Eval Baseline & Improvement Log

## Methodology

- 40 test cases (`evals/testcases.json`) across 5 categories: product_search (15),
  quote_flow (10), order_status (5), ambiguous (5), adversarial (5).
- Every case runs through the REAL agent loop (real Gemini calls, real tools,
  fresh conversation per case, `evalMode` auto-approves quote drafts).
- Scoring: programmatic checks (expectedTools in order, forbiddenTools,
  answerMustContain/answerMustNotContain) plus an LLM judge that classifies
  behaviour (answer/clarify/refuse/escalate) for cases with `expectBehavior`.
  A case passes only if ALL checks pass.
- Reports: console table, `evals/results/<timestamp>.json`,
  `evals/results/latest-summary.md`.

## ⚠ Blocking constraint discovered: free-tier daily quota

Both baseline attempts (2026-07-08) were killed mid-run by Google's free-tier
quota. The API error names the exact limit:

```
quotaId:    GenerateRequestsPerDayPerProjectPerModel-FreeTier
quotaValue: 20        (per model, per project, per DAY)
```

A full 40-case run needs ~110 requests, so a complete run does not fit in one
day on this key (gemini-2.0-flash has quota 0; gemini-2.5-flash and
gemini-2.5-flash-lite have 20/day each). The runner itself behaved correctly:
it waited out per-minute limits, retried, and aborted cleanly after two
consecutive quota deaths rather than thrashing.

## Partial baseline — what actually ran (2026-07-08)

| Run | Agent model | Cases executed | Passed | Failed | Killed by |
|---|---|---|---|---|---|
| 1 | gemini-2.5-flash | 10 (ps-01..10) | 9 | 1 (ps-05) | daily quota after case 10 |
| 2 | gemini-2.5-flash-lite | 9 scored (ps-01..09) | 6 | 3 (ps-04, ps-05, ps-06) | daily quota after case 9 |

**Score on executed cases: run 1 = 9/10 (90%), run 2 = 6/9 (67%).**
The 15% "overall" in `results/latest-summary.md` counts the 28 never-executed
cases as failures — read the per-case detail, not that headline number.

## Failure analysis (real failures, not quota errors)

| Case | What happened | Root cause category |
|---|---|---|
| ps-04 (lite) | "do you sell circuler duct?" → agent said **"Yes, we do. What size are you looking for?"** with NO search | Weak system prompt: yes/no stock questions answered from memory |
| ps-05 (flash AND lite) | "do you sell laptops?" → refused as off-topic without searching, instead of searching → honest "we don't stock that" | Weak system prompt: stock questions about unlikely items misread as off-topic |
| ps-06 (lite) | agent called search_products, then returned a completely **empty final answer** | Loop robustness: empty model candidate passed through to the customer |

Top 3 fixes identified:
1. Prompt: force a search before ANY "do we sell/stock X?" answer, including
   unlikely items — and clarify that stock questions are store questions, not
   off-topic. (Addresses ps-04 + ps-05; ps-05 failed on both models.)
2. Loop: never return an empty final answer — substitute a safe fallback
   message. (Addresses ps-06.)
3. Re-measure before touching anything else — quote_flow / order_status /
   ambiguous / adversarial never executed, so no evidence to fix them yet.

## Fix iterations

| # | Change | Files | Executed-case score before → after |
|---|---|---|---|
| 1 | Prompt: search-before-stock-answers rule (yes/no questions included; "do you sell X" is a store question) | `server/agent/prompts.ts` | **ps-04: FAIL → PASS** (fix-1 run, 2026-07-08 — agent now calls search_products before answering); ps-05 re-test still pending quota: `npm run evals -- --only ps-05 --label fix-1b` |
| 2 | Loop: empty final answer → safe fallback text | `server/agent/loop.ts` | pending quota — re-test with `npm run evals -- --only ps-06 --label fix-1b` |

## How to complete this improvement loop (when quota resets, midnight PT)

The 20/day/model cap means full 40-case runs don't fit in a day. Practical
options, best first:

1. **Targeted slices (free, fits the quota):** re-test yesterday's failures
   first, then one category per day:
   ```bash
   npm run evals -- --only ps-04,ps-05,ps-06 --label fix-1     # ~8 requests
   npm run evals -- --category adversarial --label adversarial # ~15 requests
   ```
2. **Second free project:** an additional Google Cloud project has its own
   20/day/model pool (AI Studio → create key in a new project). Doubles capacity.
3. **Paid tier:** enabling billing lifts the caps entirely (a full run on
   flash-lite costs well under $0.05) — but Phase 3 specified free-only.

Record each re-run's numbers in the Fix iterations table above.
