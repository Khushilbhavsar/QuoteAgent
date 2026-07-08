/**
 * Guardrails — the safety rails around the agent loop:
 *  - MAX_ITERATIONS caps how many times we call the model per user message
 *  - every tool input is validated with Zod BEFORE the tool runs
 *  - tool execution is retried up to 3 times with exponential backoff
 *  - token usage is tracked so every run can be logged and costed
 */
import type { AgentTool } from "../tools/index";
import { loadProducts } from "../db/catalog";

export const MAX_ITERATIONS = 10;
export const MAX_TOOL_ATTEMPTS = 3;
/** Hard cap on Gemini calls (incl. retries) in ONE run — a cost guardrail. */
export const MAX_MODEL_CALLS_PER_RUN = 15;
const BASE_RETRY_DELAY_MS = 500;

/**
 * Guardrail incidents — things that went wrong (or looked suspicious)
 * during a run. They are recorded in every runs.jsonl entry so you can
 * audit how often each guardrail fires.
 */
export type GuardrailIncident =
  | "injection_attempt_suspected"
  | "hallucinated_price"
  | "budget_exceeded"
  | "max_iterations_hit";

/** Thrown when a run tries to make more Gemini calls than the budget allows. */
export class BudgetExceededError extends Error {
  constructor(max: number) {
    super(`Run exceeded the budget of ${max} model calls.`);
    this.name = "BudgetExceededError";
  }
}

// Cheap heuristic for prompt-injection attempts. This does NOT block the
// message (the system prompt handles the refusal) — it only records an
// incident so injection attempts show up in the run log.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|your\s+|the\s+|previous\s+|prior\s+)*(instructions|rules|prompts?)/i,
  /disregard\s+(your|the|all|previous|prior)/i,
  /system\s*prompt/i,
  /you\s+are\s+now\s+/i,
  /pretend\s+(to\s+be|you\s+are)/i,
  /developer\s+mode/i,
  /jailbreak/i,
  /override\s+(your|the|all)/i,
  /reveal\s+your\s+(instructions|prompt|rules)/i,
];

export function detectInjectionAttempt(userMessage: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(userMessage));
}

/**
 * Output guard against hallucinated prices. After the model writes its final
 * answer, every "£amount" in it is checked against a "grounded" set of
 * numbers: real catalogue prices plus every number that appeared in this
 * run's tool results (quote totals, order totals, etc.). Whole multiples of
 * a grounded price are also allowed (e.g. "10 × £6.40 = £64.00").
 * Any price we can't ground is replaced with a safe placeholder and the run
 * is flagged with a "hallucinated_price" incident.
 */
export function auditAnswerPrices(
  answer: string,
  toolResults: string[],
): { answer: string; hallucinated: boolean } {
  const grounded = new Set<string>(loadProducts().map((p) => p.price_gbp.toFixed(2)));
  for (const result of toolResults) {
    for (const match of result.match(/\d+(?:\.\d+)?/g) ?? []) {
      grounded.add(Number(match).toFixed(2));
    }
  }
  const groundedValues = [...grounded].map(Number).filter((value) => value > 0);

  let hallucinated = false;
  const priceRegex = /£\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  const audited = answer.replace(priceRegex, (fullMatch, amount: string) => {
    const value = Number(amount.replace(/,/g, ""));
    if (grounded.has(value.toFixed(2))) {
      return fullMatch;
    }
    const isMultipleOfGroundedPrice = groundedValues.some((price) => {
      const ratio = value / price;
      return ratio >= 1 && Math.abs(ratio - Math.round(ratio)) < 0.001;
    });
    if (isMultipleOfGroundedPrice) {
      return fullMatch;
    }
    hallucinated = true;
    return "£[unverified]";
  });

  if (!hallucinated) {
    return { answer, hallucinated: false };
  }
  return {
    answer:
      audited +
      "\n\n(Note: an unverified price was removed from this answer. Please rely on the exact prices shown in our catalogue.)",
    hallucinated: true,
  };
}

/** Thrown when the agent loop runs too long without producing a final answer. */
export class MaxIterationsError extends Error {
  constructor(max: number) {
    super(
      `Agent exceeded the maximum of ${max} iterations without reaching a final answer. ` +
        `This usually means the model is stuck in a tool-calling loop — check runs.jsonl for details.`,
    );
    this.name = "MaxIterationsError";
  }
}

/**
 * Throw this from a tool when retrying cannot possibly help (e.g. a missing
 * index file, invalid configuration). The retry loop fails fast instead of
 * wasting 3 attempts on an error that will never go away by itself.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** Running total of tokens used across all model calls in one run. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Add one API response's usage numbers onto the run's running total. */
export function trackUsage(
  total: TokenUsage,
  usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined,
): void {
  total.inputTokens += usage?.promptTokenCount ?? 0;
  total.outputTokens += usage?.candidatesTokenCount ?? 0;
}

/** What a tool call produced — either a real result or an error message. */
export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** Shared by the tool retries here and the API retries in loop.ts. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one tool call with all guardrails applied:
 * 1. Validate the input the model produced against the tool's Zod schema.
 *    On failure we do NOT retry — we return the validation error as the
 *    tool result so the model can read it and correct its own input.
 * 2. Execute the tool, retrying up to MAX_TOOL_ATTEMPTS times with
 *    exponential backoff (500ms, 1s, ...) for transient failures.
 * 3. If every attempt fails, return the error as the tool result
 *    (isError: true) so the model can apologise and recover gracefully.
 */
export async function runToolWithGuardrails(
  tool: AgentTool,
  rawInput: unknown,
): Promise<ToolOutcome> {
  const parsed = tool.zodInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      content: `Invalid input for tool "${tool.name}": ${details}. Fix the input and call the tool again.`,
      isError: true,
    };
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TOOL_ATTEMPTS; attempt++) {
    try {
      const result = await tool.execute(parsed.data);
      return { content: result, isError: false };
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableError) {
        break; // retrying can't fix this — fail fast with the message below
      }
      if (attempt < MAX_TOOL_ATTEMPTS) {
        const delayMs = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
        console.error(
          `  [guardrails] tool "${tool.name}" failed (attempt ${attempt}/${MAX_TOOL_ATTEMPTS}), retrying in ${delayMs}ms...`,
        );
        await sleep(delayMs);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    content: `Tool "${tool.name}" failed after ${MAX_TOOL_ATTEMPTS} attempts: ${message}`,
    isError: true,
  };
}
