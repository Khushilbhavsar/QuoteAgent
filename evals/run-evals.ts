/**
 * Eval runner — quota-aware and resumable, built for a ~20-request/day key.
 *
 * `npm run evals`                      run the suite under the default budget (18)
 * `npm run evals -- --budget 12`       stop cleanly before making >12 API calls
 * `npm run evals -- --resume`          continue yesterday's stopped run, merge results
 * `npm run evals -- --dry-run`         re-score the LAST recorded answers, ZERO API calls
 * `npm run evals -- --category quote_flow`   only one category
 * `npm run evals -- --id ps-04`        one case (repeatable / comma-list)
 * `npm run evals -- --only ps-04,ps-05`      several cases
 *
 * Scoring:
 * 1. PROGRAMMATIC (free, deterministic): expectedTools in order, forbiddenTools,
 *    answerMustContain / answerMustNotContain.
 * 2. LLM-AS-JUDGE (one call, ONLY for cases with `expectBehavior`): classifies
 *    behaviour (answer/clarify/refuse/escalate). Verdicts are CACHED by
 *    case-id + answer-hash so re-runs never re-judge an unchanged answer.
 *
 * Cost controls: each case is capped at 5 agent iterations; the runner tracks
 * every Gemini call and stops BEFORE it would exceed --budget, writing a
 * checkpoint after every case so `--resume` can finish the run another day.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { type Content } from "@google/genai";
import { runAgent } from "../server/agent/loop";
import { sleep } from "../server/agent/guardrails";
import { judgeBehavior, isTransient, type Behavior, type JudgeVerdict } from "./judge";

dotenv.config({ quiet: true });
// This machine has a placeholder GOOGLE_API_KEY in the system environment;
// remove it so the SDK never gets confused about which key to use.
delete process.env.GOOGLE_API_KEY;

// ---------------------------------------------------------------- types

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

interface CaseResult {
  id: string;
  category: string;
  passed: boolean;
  failures: string[];
  judge?: JudgeVerdict;
  finalAnswer: string;
  toolCalls: string[];
  incidents: string[];
  modelCalls: number;
  answerHash: string;
  durationMs: number;
  error?: string;
}

interface Checkpoint {
  label: string;
  startedAt: string;
  updatedAt: string;
  apiCallsUsed: number;
  results: CaseResult[];
}

type JudgeCache = Record<string, JudgeVerdict>;

// ---------------------------------------------------------------- config

const EVAL_MAX_ITERATIONS = 5; // cap agent iterations per case to bound API cost
const DEFAULT_BUDGET = 18; // leave headroom under the ~20/day free-tier quota
const PER_CASE_MAX_CALLS = EVAL_MAX_ITERATIONS + 1; // worst case: 5 agent + 1 judge
const CASE_DELAY_MS = 8000; // pacing between cases for the ~10 req/min free tier
const RATE_LIMIT_WAIT_MS = 60_000;
const MAX_CASE_ATTEMPTS = 3;

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(here, "results");
const CHECKPOINT_PATH = path.join(RESULTS_DIR, "checkpoint.json");
const JUDGE_CACHE_PATH = path.join(RESULTS_DIR, "judge-cache.json");

// ---------------------------------------------------------------- small helpers

const sha1 = (text: string): string => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);

/** expectedTools must appear IN ORDER within the actual calls (a subsequence). */
function isOrderedSubsequence(expected: string[], actual: string[]): boolean {
  let matched = 0;
  for (const name of actual) {
    if (matched < expected.length && name === expected[matched]) matched++;
  }
  return matched >= expected.length;
}

/** The deterministic, API-free part of scoring — shared by live runs and --dry-run. */
function programmaticFailures(testCase: EvalCase, toolCalls: string[], finalAnswer: string): string[] {
  const failures: string[] = [];
  const exp = testCase.expectations;
  const answerLower = finalAnswer.toLowerCase();

  if (exp.expectedTools !== undefined && !isOrderedSubsequence(exp.expectedTools, toolCalls)) {
    failures.push(`expected tools [${exp.expectedTools.join(", ")}] (in order); actual: [${toolCalls.join(", ") || "none"}]`);
  }
  for (const tool of exp.forbiddenTools ?? []) {
    if (toolCalls.includes(tool)) failures.push(`forbidden tool "${tool}" was called`);
  }
  for (const needle of exp.answerMustContain ?? []) {
    if (!answerLower.includes(needle.toLowerCase())) failures.push(`answer missing required text "${needle}"`);
  }
  for (const needle of exp.answerMustNotContain ?? []) {
    if (answerLower.includes(needle.toLowerCase())) failures.push(`answer contains forbidden text "${needle}"`);
  }
  return failures;
}

function loadJudgeCache(): JudgeCache {
  try {
    return JSON.parse(fs.readFileSync(JUDGE_CACHE_PATH, "utf8")) as JudgeCache;
  } catch {
    return {};
  }
}
function saveJudgeCache(cache: JudgeCache): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(JUDGE_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function loadCheckpoint(): Checkpoint | null {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}
function saveCheckpoint(cp: Checkpoint): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  cp.updatedAt = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2), "utf8");
}

// ---------------------------------------------------------------- one case (LIVE)

/** Run a case through the real agent + judge. Returns the result and how many
    API calls it actually spent (agent model calls + judge calls). */
async function runCase(testCase: EvalCase, judgeCache: JudgeCache): Promise<{ result: CaseResult; apiCalls: number }> {
  const started = Date.now();
  const turns = testCase.messages ?? (testCase.userMessage !== undefined ? [testCase.userMessage] : []);
  if (turns.length === 0) throw new Error(`case ${testCase.id} has neither userMessage nor messages`);

  const history: Content[] = [];
  const toolCalls: string[] = [];
  const incidents: string[] = [];
  let finalAnswer = "";
  let modelCalls = 0;

  for (const turn of turns) {
    const result = await runAgent(turn, history, { evalMode: true, maxIterations: EVAL_MAX_ITERATIONS });
    toolCalls.push(...result.toolCallsMade.map((call) => call.name));
    incidents.push(...result.incidents);
    finalAnswer = result.finalText; // checks apply to the LAST turn's answer
    modelCalls += result.modelCalls;
  }

  const failures = programmaticFailures(testCase, toolCalls, finalAnswer);
  const answerHash = sha1(finalAnswer);

  let judge: JudgeVerdict | undefined;
  let judgeCalls = 0;
  if (testCase.expectations.expectBehavior !== undefined) {
    const key = `${testCase.id}:${answerHash}`;
    if (judgeCache[key] !== undefined) {
      judge = judgeCache[key]; // cache hit — no API call
    } else {
      await sleep(2000); // brief pause before the extra judge request
      judge = await judgeBehavior(turns, toolCalls, finalAnswer);
      judgeCalls = 1;
      judgeCache[key] = judge;
      saveJudgeCache(judgeCache);
    }
    if (judge.behavior !== testCase.expectations.expectBehavior) {
      failures.push(`expected behavior "${testCase.expectations.expectBehavior}" but judge classified "${judge.behavior}" (${judge.reasoning})`);
    }
  }

  const result: CaseResult = {
    id: testCase.id,
    category: testCase.category,
    passed: failures.length === 0,
    failures,
    ...(judge !== undefined ? { judge } : {}),
    finalAnswer,
    toolCalls,
    incidents,
    modelCalls,
    answerHash,
    durationMs: Date.now() - started,
  };
  return { result, apiCalls: modelCalls + judgeCalls };
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
  const pct = (p: number, t: number): string => (t === 0 ? "-" : `${Math.round((p / t) * 100)}%`);
  console.log("\n" + "Category".padEnd(18) + "Passed".padStart(8) + "Total".padStart(8) + "Rate".padStart(8));
  console.log("-".repeat(42));
  for (const s of scores) {
    console.log(s.category.padEnd(18) + String(s.passed).padStart(8) + String(s.total).padStart(8) + pct(s.passed, s.total).padStart(8));
  }
  const passed = results.filter((r) => r.passed).length;
  console.log("-".repeat(42));
  console.log("OVERALL".padEnd(18) + String(passed).padStart(8) + String(results.length).padStart(8) + pct(passed, results.length).padStart(8));
}

function writeReports(label: string, results: CaseResult[], dryRun: boolean): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const passed = results.filter((r) => r.passed).length;
  const overallPct = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;
  const scores = aggregate(results);

  if (!dryRun) {
    const jsonPath = path.join(RESULTS_DIR, `${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ label, timestamp, overallPct, scores, results }, null, 2), "utf8");
    console.log(`\nReport: ${jsonPath}`);
  }

  const failed = results.filter((r) => !r.passed);
  const lines: string[] = [
    `# Eval results — ${label}${dryRun ? " (dry-run)" : ""}`,
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
    if (result.error !== undefined) lines.push(`- ERROR: ${result.error}`);
    for (const failure of result.failures) lines.push(`- ${failure}`);
    if (result.judge !== undefined) lines.push(`- judge: behavior=${result.judge.behavior}, helpfulness=${result.judge.helpfulness} — ${result.judge.reasoning}`);
    lines.push(`- final answer: ${result.finalAnswer.slice(0, 300).replace(/\n/g, " ")}`);
    lines.push("");
  }
  fs.writeFileSync(path.join(RESULTS_DIR, "latest-summary.md"), lines.join("\n"), "utf8");
  console.log(`Summary: ${path.join(RESULTS_DIR, "latest-summary.md")}`);
}

// ---------------------------------------------------------------- dry-run (ZERO API)

/** Find the most recent recorded answers: the checkpoint first, else the latest
    timestamped results JSON. */
function loadRecordedResults(): CaseResult[] {
  const checkpoint = loadCheckpoint();
  if (checkpoint !== null && checkpoint.results.length > 0) return checkpoint.results;
  try {
    const files = fs
      .readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".json") && f !== "checkpoint.json" && f !== "judge-cache.json")
      .sort();
    const latest = files.at(-1);
    if (latest === undefined) return [];
    const parsed = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, latest), "utf8")) as { results?: CaseResult[] };
    return parsed.results ?? [];
  } catch {
    return [];
  }
}

function dryRun(cases: EvalCase[], label: string): void {
  console.log("DRY RUN — re-scoring the last recorded answers, ZERO API calls.\n");
  const recorded = new Map(loadRecordedResults().map((r) => [r.id, r]));
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    const prior = recorded.get(testCase.id);
    if (prior === undefined) {
      console.log(`[skip] ${testCase.id.padEnd(6)} — no recorded answer to score`);
      continue;
    }
    const failures = programmaticFailures(testCase, prior.toolCalls, prior.finalAnswer);
    // Behaviour is re-checked against the RECORDED judge verdict (no new API call).
    if (testCase.expectations.expectBehavior !== undefined) {
      if (prior.judge === undefined) {
        failures.push(`expectBehavior "${testCase.expectations.expectBehavior}" — no recorded judge verdict (run live once)`);
      } else if (prior.judge.behavior !== testCase.expectations.expectBehavior) {
        failures.push(`expected behavior "${testCase.expectations.expectBehavior}" but recorded judge was "${prior.judge.behavior}"`);
      }
    }
    const result: CaseResult = { ...prior, passed: failures.length === 0, failures };
    results.push(result);
    console.log(`[${result.passed ? "PASS" : "FAIL"}] ${testCase.id.padEnd(6)}${result.passed ? "" : ` — ${failures[0]}`}`);
  }

  printTable(aggregate(results), results);
  if (results.length > 0) writeReports(label, results, true);
}

// ---------------------------------------------------------------- main

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

function selectCases(all: EvalCase[]): EvalCase[] {
  let cases = all;
  const ids = new Set<string>();
  for (const raw of [argValue("--only"), argValue("--id")]) {
    if (raw !== undefined) raw.split(",").forEach((id) => ids.add(id.trim()));
  }
  if (ids.size > 0) cases = cases.filter((c) => ids.has(c.id));
  const category = argValue("--category");
  if (category !== undefined) cases = cases.filter((c) => c.category === category);
  return cases;
}

async function main(): Promise<void> {
  const label = argValue("--label") ?? "run";
  const budget = Number(argValue("--budget") ?? DEFAULT_BUDGET);
  const resume = hasFlag("--resume");
  const isDryRun = hasFlag("--dry-run");

  const allCases = JSON.parse(fs.readFileSync(path.join(here, "testcases.json"), "utf8")) as EvalCase[];
  const cases = selectCases(allCases);
  if (cases.length === 0) {
    console.error("No test cases match the given --only/--id/--category filter.");
    process.exit(1);
  }

  // --dry-run needs no key and no network.
  if (isDryRun) {
    dryRun(cases, label);
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set — copy .env.example to .env and add your key (or use --dry-run).");
    process.exit(1);
  }

  // Checkpoint: --resume continues a prior run; otherwise start fresh.
  const existing = loadCheckpoint();
  const checkpoint: Checkpoint =
    resume && existing !== null
      ? existing
      : { label, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), apiCallsUsed: 0, results: [] };
  if (resume && existing !== null) {
    console.log(`Resuming "${existing.label}" — ${existing.results.length} case(s) already done, ${existing.apiCallsUsed} API calls used.\n`);
  }

  const doneIds = new Set(checkpoint.results.map((r) => r.id));
  const remaining = cases.filter((c) => !doneIds.has(c.id));
  const judgeCache = loadJudgeCache();

  console.log(`Budget: ${budget} API calls. ${remaining.length} case(s) to run (${doneIds.size} already done).\n`);

  let stoppedForBudget = false;
  let consecutiveQuotaErrors = 0;

  for (let i = 0; i < remaining.length; i++) {
    const testCase = remaining[i];

    // Stop cleanly BEFORE we could exceed the budget.
    if (checkpoint.apiCallsUsed + PER_CASE_MAX_CALLS > budget) {
      stoppedForBudget = true;
      console.log(`\nStopping before ${testCase.id}: ${checkpoint.apiCallsUsed}/${budget} API calls used; a case can cost up to ${PER_CASE_MAX_CALLS}.`);
      break;
    }
    if (consecutiveQuotaErrors >= 2) {
      console.error("\nTwo cases failed on rate limits even after 60s waits — daily quota is likely exhausted. Stopping.\n");
      break;
    }

    let outcome: { result: CaseResult; apiCalls: number } | null = null;
    for (let attempt = 1; attempt <= MAX_CASE_ATTEMPTS && outcome === null; attempt++) {
      try {
        outcome = await runCase(testCase, judgeCache);
      } catch (error) {
        if (isTransient(error) && attempt < MAX_CASE_ATTEMPTS) {
          console.log(`  [${testCase.id}] transient API error — waiting ${RATE_LIMIT_WAIT_MS / 1000}s, retry ${attempt}/${MAX_CASE_ATTEMPTS}...`);
          await sleep(RATE_LIMIT_WAIT_MS);
          continue;
        }
        outcome = {
          result: {
            id: testCase.id, category: testCase.category, passed: false, failures: [],
            finalAnswer: "", toolCalls: [], incidents: [], modelCalls: 0, answerHash: "", durationMs: 0,
            error: error instanceof Error ? error.message : String(error),
          },
          apiCalls: PER_CASE_MAX_CALLS, // conservative charge for a failed case
        };
      }
    }

    const final = outcome!;
    checkpoint.results.push(final.result);
    checkpoint.apiCallsUsed += final.apiCalls;
    saveCheckpoint(checkpoint); // checkpoint after EVERY case

    const status = final.result.passed ? "PASS" : final.result.error !== undefined ? "ERROR" : "FAIL";
    const detail = final.result.passed ? "" : ` — ${final.result.error ?? final.result.failures[0] ?? ""}`;
    console.log(`[${String(doneIds.size + i + 1).padStart(2)}/${cases.length}] ${testCase.id.padEnd(6)} ${status} (${final.apiCalls} calls, ${checkpoint.apiCallsUsed}/${budget})${detail}`);

    if (final.result.error !== undefined && isTransient(new Error(final.result.error))) {
      consecutiveQuotaErrors += 1;
    } else if (final.result.error === undefined) {
      consecutiveQuotaErrors = 0;
    }

    if (i < remaining.length - 1) await sleep(CASE_DELAY_MS);
  }

  // Report on everything done so far (merged across resumes).
  const results = checkpoint.results;
  printTable(aggregate(results), results);
  console.log(`\nAPI calls used: ${checkpoint.apiCallsUsed}/${budget}`);
  writeReports(checkpoint.label, results, false);

  const allDone = results.length >= cases.length;
  if (allDone) {
    fs.rmSync(CHECKPOINT_PATH, { force: true }); // run complete — clear the checkpoint
    console.log(`\nAll ${cases.length} selected case(s) complete.`);
  } else {
    console.log(
      `\n${results.length}/${cases.length} done` +
        (stoppedForBudget ? " (budget reached)" : "") +
        `. Continue tomorrow with:\n  npm run evals -- --resume` +
        (argValue("--budget") !== undefined ? ` --budget ${budget}` : ""),
    );
  }
}

void main();
