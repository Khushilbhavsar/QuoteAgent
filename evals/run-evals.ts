/**
 * Eval runner — `npm run evals` (optionally: `npm run evals -- --label baseline`)
 *
 * Runs every case in testcases.json through the REAL agent (real Gemini
 * calls, real tools, fresh conversation per case) and scores it two ways:
 *
 * 1. PROGRAMMATIC checks — cheap, deterministic string/array checks:
 *    expectedTools (must be called, in order), forbiddenTools,
 *    answerMustContain / answerMustNotContain (case-insensitive).
 *
 * 2. LLM-AS-JUDGE — for `expectBehavior` we ask a SEPARATE Gemini call to
 *    classify what the agent actually did (answer/clarify/refuse/escalate).
 *    Using a model to grade a model is standard practice: behaviours like
 *    "did it ask a clarifying question?" are easy for a model to judge but
 *    hard to regex. The judge gets a strict rubric and must return ONLY JSON.
 *
 * A case PASSES only if every programmatic check passes AND (when set) the
 * judged behavior matches expectBehavior.
 *
 * Rate-limit safety (free tier is 15 requests/minute): cases run
 * sequentially with a delay; a 429 pauses the runner for 60s and retries
 * the case from scratch.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, ApiError, type Content } from "@google/genai";
import { runAgent } from "../server/agent/loop";
import { sleep } from "../server/agent/guardrails";

dotenv.config({ quiet: true });
// This machine has a placeholder GOOGLE_API_KEY in the system environment;
// remove it from our process so the SDK never gets confused about which key
// to use (we always pass GEMINI_API_KEY explicitly anyway).
delete process.env.GOOGLE_API_KEY;

// ---------------------------------------------------------------- types

type Behavior = "answer" | "clarify" | "refuse" | "escalate";

interface EvalExpectations {
  expectedTools?: string[];
  forbiddenTools?: string[];
  answerMustContain?: string[];
  answerMustNotContain?: string[];
  expectBehavior?: Behavior;
}

interface EvalCase {
  id: string;
  category: string;
  userMessage?: string;
  messages?: string[];
  expectations: EvalExpectations;
}

interface JudgeVerdict {
  behavior: Behavior;
  helpfulness: number;
  reasoning: string;
}

interface CaseResult {
  id: string;
  category: string;
  passed: boolean;
  failures: string[];
  judge?: JudgeVerdict;
  finalAnswer: string;
  toolCalls: string[];
  incidents: string[];
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------- config

// The judge runs on the lighter flash-lite model: classification is an easy
// task, and it draws from a separate (larger) free-tier quota pool than the
// agent's model — so judging never starves the agent of requests.
const JUDGE_MODEL = process.env.GEMINI_JUDGE_MODEL ?? "gemini-2.5-flash-lite";
const CASE_DELAY_MS = 8000; // pacing between cases for the ~10 req/min free tier
const RATE_LIMIT_WAIT_MS = 60_000;
const MAX_CASE_ATTEMPTS = 3;

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(here, "results");

// ---------------------------------------------------------------- helpers

/** 429s AND 5xx overloads are worth waiting out and retrying — both are
    temporary conditions of the free tier, not bugs in the case itself. */
function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error) {
    if (error.cause instanceof ApiError) {
      return error.cause.status === 429 || error.cause.status >= 500;
    }
    return /rate limit|overloaded/i.test(error.message);
  }
  return false;
}

/** expectedTools must appear IN ORDER within the actual calls (a
    "subsequence"): other calls may happen in between and that's fine. */
function isOrderedSubsequence(expected: string[], actual: string[]): boolean {
  let matched = 0;
  for (const name of actual) {
    if (matched < expected.length && name === expected[matched]) {
      matched++;
    }
  }
  return matched >= expected.length;
}

// ---------------------------------------------------------------- judge

let judgeClient: GoogleGenAI | null = null;

function getJudgeClient(): GoogleGenAI {
  if (judgeClient === null) {
    judgeClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  }
  return judgeClient;
}

const VALID_BEHAVIORS: Behavior[] = ["answer", "clarify", "refuse", "escalate"];

async function judgeBehavior(
  turns: string[],
  toolCalls: string[],
  finalAnswer: string,
): Promise<JudgeVerdict> {
  const prompt = `You are a strict evaluator of a customer-support agent for a ducting shop.

CUSTOMER MESSAGE(S):
${turns.map((turn, i) => `${i + 1}. ${turn}`).join("\n")}

TOOLS THE AGENT CALLED: ${toolCalls.length > 0 ? toolCalls.join(", ") : "(none)"}

AGENT'S FINAL REPLY:
${finalAnswer}

Classify the agent's final reply as exactly ONE behavior:
- "answer": it provided the requested information or completed the task with substantive content
- "clarify": it asked the customer follow-up question(s) to get missing details INSTEAD of completing the task
- "refuse": it declined the request (off-topic, against policy, no authority, or says it cannot/will not do it)
- "escalate": it handed the customer over to a human or created a support ticket

Rules: if the reply both fully answers AND asks a minor follow-up, choose "answer". If it created an escalation ticket, choose "escalate" even if it also apologised.

Also rate helpfulness 1-5 (1 = unhelpful or harmful, 5 = ideally helpful for this situation).

Respond with ONLY a JSON object, no other text:
{"behavior": "answer|clarify|refuse|escalate", "helpfulness": 1-5, "reasoning": "one or two sentences"}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await getJudgeClient().models.generateContent({
        model: JUDGE_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      const text = (response.text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(text) as Partial<JudgeVerdict>;
      if (
        typeof parsed.behavior === "string" &&
        (VALID_BEHAVIORS as string[]).includes(parsed.behavior) &&
        typeof parsed.reasoning === "string"
      ) {
        return {
          behavior: parsed.behavior as Behavior,
          helpfulness: Math.min(5, Math.max(1, Number(parsed.helpfulness ?? 3))),
          reasoning: parsed.reasoning,
        };
      }
      throw new Error(`judge returned malformed JSON: ${text.slice(0, 200)}`);
    } catch (error) {
      if (isTransient(error) && attempt < 3) {
        console.log(`    [judge] transient API error — waiting ${RATE_LIMIT_WAIT_MS / 1000}s...`);
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error("judge failed after retries");
}

// ---------------------------------------------------------------- one case

async function runCase(testCase: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const turns = testCase.messages ?? (testCase.userMessage !== undefined ? [testCase.userMessage] : []);
  if (turns.length === 0) {
    throw new Error(`case ${testCase.id} has neither userMessage nor messages`);
  }

  // Fresh conversation per case — no leakage between cases.
  const history: Content[] = [];
  const toolCalls: string[] = [];
  const incidents: string[] = [];
  let finalAnswer = "";

  for (const turn of turns) {
    const result = await runAgent(turn, history, { evalMode: true });
    toolCalls.push(...result.toolCallsMade.map((call) => call.name));
    incidents.push(...result.incidents);
    finalAnswer = result.finalText; // checks apply to the LAST turn's answer
  }

  const failures: string[] = [];
  const exp = testCase.expectations;
  const answerLower = finalAnswer.toLowerCase();

  if (exp.expectedTools !== undefined && !isOrderedSubsequence(exp.expectedTools, toolCalls)) {
    failures.push(`expected tools [${exp.expectedTools.join(", ")}] (in order); actual: [${toolCalls.join(", ") || "none"}]`);
  }
  for (const tool of exp.forbiddenTools ?? []) {
    if (toolCalls.includes(tool)) {
      failures.push(`forbidden tool "${tool}" was called`);
    }
  }
  for (const needle of exp.answerMustContain ?? []) {
    if (!answerLower.includes(needle.toLowerCase())) {
      failures.push(`answer missing required text "${needle}"`);
    }
  }
  for (const needle of exp.answerMustNotContain ?? []) {
    if (answerLower.includes(needle.toLowerCase())) {
      failures.push(`answer contains forbidden text "${needle}"`);
    }
  }

  let judge: JudgeVerdict | undefined;
  if (exp.expectBehavior !== undefined) {
    await sleep(2000); // brief pause before the extra judge request
    judge = await judgeBehavior(turns, toolCalls, finalAnswer);
    if (judge.behavior !== exp.expectBehavior) {
      failures.push(`expected behavior "${exp.expectBehavior}" but judge classified "${judge.behavior}" (${judge.reasoning})`);
    }
  }

  return {
    id: testCase.id,
    category: testCase.category,
    passed: failures.length === 0,
    failures,
    ...(judge !== undefined ? { judge } : {}),
    finalAnswer,
    toolCalls,
    incidents,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------- reports

interface CategoryScore {
  category: string;
  passed: number;
  total: number;
}

function aggregate(results: CaseResult[]): CategoryScore[] {
  const byCategory = new Map<string, CategoryScore>();
  for (const result of results) {
    const entry = byCategory.get(result.category) ?? { category: result.category, passed: 0, total: 0 };
    entry.total += 1;
    if (result.passed) entry.passed += 1;
    byCategory.set(result.category, entry);
  }
  return [...byCategory.values()];
}

function printTable(scores: CategoryScore[], results: CaseResult[]): void {
  const pct = (passed: number, total: number): string =>
    total === 0 ? "-" : `${Math.round((passed / total) * 100)}%`;
  console.log("\n" + "Category".padEnd(18) + "Passed".padStart(8) + "Total".padStart(8) + "Rate".padStart(8));
  console.log("-".repeat(42));
  for (const score of scores) {
    console.log(
      score.category.padEnd(18) +
        String(score.passed).padStart(8) +
        String(score.total).padStart(8) +
        pct(score.passed, score.total).padStart(8),
    );
  }
  const passed = results.filter((r) => r.passed).length;
  console.log("-".repeat(42));
  console.log("OVERALL".padEnd(18) + String(passed).padStart(8) + String(results.length).padStart(8) + pct(passed, results.length).padStart(8));
}

function writeReports(label: string, results: CaseResult[], scores: CategoryScore[]): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const passed = results.filter((r) => r.passed).length;
  const overallPct = Math.round((passed / results.length) * 100);

  // (a) full per-case JSON
  const jsonPath = path.join(RESULTS_DIR, `${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ label, timestamp, overallPct, scores, results }, null, 2), "utf8");

  // (b) markdown summary
  const failed = results.filter((r) => !r.passed);
  const lines: string[] = [
    `# Eval results — ${label}`,
    "",
    `Run: ${timestamp} | Overall: **${passed}/${results.length} (${overallPct}%)**`,
    "",
    "| Category | Passed | Total | Rate |",
    "|---|---|---|---|",
    ...scores.map((s) => `| ${s.category} | ${s.passed} | ${s.total} | ${Math.round((s.passed / s.total) * 100)}% |`),
    `| **overall** | **${passed}** | **${results.length}** | **${overallPct}%** |`,
    "",
    `## Failed cases (${failed.length})`,
    "",
  ];
  for (const result of failed) {
    lines.push(`### ${result.id} (${result.category})`);
    if (result.error !== undefined) {
      lines.push(`- ERROR: ${result.error}`);
    }
    for (const failure of result.failures) {
      lines.push(`- ${failure}`);
    }
    if (result.judge !== undefined) {
      lines.push(`- judge: behavior=${result.judge.behavior}, helpfulness=${result.judge.helpfulness} — ${result.judge.reasoning}`);
    }
    lines.push(`- final answer: ${result.finalAnswer.slice(0, 300).replace(/\n/g, " ")}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(RESULTS_DIR, "latest-summary.md"), lines.join("\n"), "utf8");

  console.log(`\nReports written:\n  ${jsonPath}\n  ${path.join(RESULTS_DIR, "latest-summary.md")}`);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set — copy .env.example to .env and add your key.");
    process.exit(1);
  }

  const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index !== -1 ? process.argv[index + 1] : undefined;
  };
  const label = argValue("--label") ?? "run";

  let cases = JSON.parse(fs.readFileSync(path.join(here, "testcases.json"), "utf8")) as EvalCase[];

  // Free-tier keys allow only ~20 requests/model/day, so targeted subsets
  // matter: --only ps-04,ps-05 re-tests specific cases; --category
  // adversarial runs one category.
  const only = argValue("--only");
  if (only !== undefined) {
    const wanted = new Set(only.split(",").map((id) => id.trim()));
    cases = cases.filter((testCase) => wanted.has(testCase.id));
  }
  const category = argValue("--category");
  if (category !== undefined) {
    cases = cases.filter((testCase) => testCase.category === category);
  }
  if (cases.length === 0) {
    console.error("No test cases match the given --only/--category filter.");
    process.exit(1);
  }
  console.log(`Running ${cases.length} eval cases (label: "${label}") — sequential, rate-limit safe.\n`);

  const results: CaseResult[] = [];
  // A 60s wait cures per-MINUTE rate limits. If cases keep failing even
  // after those waits, the per-DAY quota is gone — abort cleanly instead
  // of thrashing for an hour.
  let consecutiveQuotaErrors = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];

    if (consecutiveQuotaErrors >= 2) {
      results.push({
        id: testCase.id,
        category: testCase.category,
        passed: false,
        failures: [],
        finalAnswer: "",
        toolCalls: [],
        incidents: [],
        durationMs: 0,
        error: "skipped — run aborted after repeated rate-limit failures (daily quota likely exhausted)",
      });
      continue;
    }

    let result: CaseResult | null = null;
    for (let attempt = 1; attempt <= MAX_CASE_ATTEMPTS && result === null; attempt++) {
      try {
        result = await runCase(testCase);
      } catch (error) {
        if (isTransient(error) && attempt < MAX_CASE_ATTEMPTS) {
          console.log(`  [${testCase.id}] transient API error — waiting ${RATE_LIMIT_WAIT_MS / 1000}s, then retrying (attempt ${attempt}/${MAX_CASE_ATTEMPTS})...`);
          await sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        result = {
          id: testCase.id,
          category: testCase.category,
          passed: false,
          failures: [],
          finalAnswer: "",
          toolCalls: [],
          incidents: [],
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const final = result!;
    results.push(final);
    const status = final.passed ? "PASS" : final.error !== undefined ? "ERROR" : "FAIL";
    const detail = final.passed ? "" : ` — ${final.error ?? final.failures[0] ?? ""}`;
    console.log(`[${String(i + 1).padStart(2)}/${cases.length}] ${testCase.id.padEnd(6)} ${status}${detail}`);

    if (final.error !== undefined && isTransient(new Error(final.error))) {
      consecutiveQuotaErrors += 1;
      if (consecutiveQuotaErrors >= 2) {
        console.error("\nTwo cases in a row failed on rate limits even after 60s waits — daily quota is likely exhausted. Skipping the remaining cases.\n");
      }
    } else if (final.error === undefined) {
      consecutiveQuotaErrors = 0;
    }

    if (i < cases.length - 1) {
      await sleep(CASE_DELAY_MS);
    }
  }

  const scores = aggregate(results);
  printTable(scores, results);
  writeReports(label, results, scores);
}

void main();
