/**
 * Run logger — appends one JSON line per agent run to runs.jsonl
 * (JSONL = one JSON object per line, easy to grep and easy to load later
 * for evals). Logging failures never crash the agent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(here, "runs.jsonl");

export interface RunLogEntry {
  timestamp: string;
  userMessage: string;
  toolCalls: { name: string; input: unknown; result: string; isError: boolean }[];
  iterations: number;
  tokens: { inputTokens: number; outputTokens: number };
  finalAnswer: string;
  /** Guardrail incidents raised during the run (empty when all was clean). */
  incidents: string[];
}

export function logRun(entry: Omit<RunLogEntry, "timestamp">): void {
  const line: RunLogEntry = { timestamp: new Date().toISOString(), ...entry };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(line) + "\n", "utf8");
  } catch (error) {
    // Never let logging take the agent down — just report it.
    console.error("[logger] failed to write runs.jsonl:", error);
  }
}
