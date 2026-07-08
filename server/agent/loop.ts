/**
 * The agent loop — the heart of QuoteAgent.
 *
 * One "run" = one user message. The loop:
 *   1. sends the conversation + tool functionDeclarations to Gemini
 *   2. if the reply contains functionCall parts, executes each tool
 *      (with guardrails), sends back matching functionResponse parts,
 *      and calls Gemini again
 *   3. repeats until the model returns plain text
 *      (or MAX_ITERATIONS is hit, which throws a clear error)
 *
 * Every run is appended to server/db/runs.jsonl by the logger.
 */
import {
  GoogleGenAI,
  ApiError,
  type Content,
  type Part,
  type FunctionDeclaration,
  type GenerateContentResponse,
} from "@google/genai";
import { agentTools, toGeminiFunctionDeclarations, type AgentTool } from "../tools/index";
import { SYSTEM_PROMPT } from "./prompts";
import {
  MAX_ITERATIONS,
  MAX_MODEL_CALLS_PER_RUN,
  MaxIterationsError,
  BudgetExceededError,
  runToolWithGuardrails,
  trackUsage,
  sleep,
  detectInjectionAttempt,
  auditAnswerPrices,
  type TokenUsage,
  type ToolOutcome,
  type GuardrailIncident,
} from "./guardrails";
import { logRun } from "../db/logger";

/**
 * Default is gemini-2.5-flash: new free-tier keys have NO quota for the
 * older gemini-2.0-flash (the API returns 429 with "limit: 0" for it).
 * Override with GEMINI_MODEL in .env if your key differs.
 */
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const MAX_OUTPUT_TOKENS = 8192;

// The @google/genai SDK does not retry failed requests itself, so we do:
// rate-limit (429) and server/overload (5xx) errors are retried with
// exponential backoff before we give up with a friendly message.
const MAX_API_ATTEMPTS = 3;
const API_RETRY_BASE_MS = 1000;

/** A record of one tool call the model made during a run. */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
}

/** What runAgent returns — the Phase 1 shape plus guardrail incidents. */
export interface AgentRunResult {
  finalText: string;
  toolCallsMade: ToolCallRecord[];
  tokensUsed: TokenUsage;
  iterations: number;
  incidents: GuardrailIncident[];
}

/** Everything a human needs to review a paused, approval-gated tool call. */
export interface ApprovalRequest {
  toolName: string;
  /** The question to put to the human, e.g. "Approve this quote request? (y/n)" */
  prompt: string;
  /** Pretty-printed draft (what will happen if they approve) */
  draft: string;
}

export interface RunAgentOptions {
  /**
   * Called when a requiresApproval tool has produced a draft. The loop is
   * paused (awaiting this promise) until it resolves: true = approve and
   * commit, false = decline. If no handler is provided, drafts are declined
   * automatically — the safe default.
   */
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean>;
  /**
   * Eval mode: auto-approve every pending_approval draft so eval runs are
   * non-interactive. NEVER set this in the real chat/API path.
   */
  evalMode?: boolean;
}

// The client is created lazily so a missing API key produces a friendly
// error at chat time instead of a crash the moment this file is imported.
let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (cachedClient === null) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not set. Copy .env.example to .env and paste your key from https://aistudio.google.com/apikey",
      );
    }
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

/**
 * Call Gemini once, retrying transient failures and translating raw API
 * errors into friendly messages.
 */
async function callGemini(
  contents: Content[],
  functionDeclarations: FunctionDeclaration[],
  budget: { used: number },
): Promise<GenerateContentResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
    // Budget guardrail: every attempt (retries included) counts. When the
    // budget is gone the run stops gracefully instead of burning money.
    if (budget.used >= MAX_MODEL_CALLS_PER_RUN) {
      throw new BudgetExceededError(MAX_MODEL_CALLS_PER_RUN);
    }
    budget.used += 1;
    try {
      return await getClient().models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations }],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // 2.5-series models "think" before answering by default, which is
          // slower and burns free-tier tokens; a support agent doesn't need it.
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
    } catch (error) {
      lastError = error;
      const status = error instanceof ApiError ? error.status : undefined;
      const retryable = status === 429 || (status !== undefined && status >= 500);
      if (retryable && attempt < MAX_API_ATTEMPTS) {
        const delayMs = API_RETRY_BASE_MS * 2 ** (attempt - 1);
        console.error(
          `  [api] Gemini returned ${status} (attempt ${attempt}/${MAX_API_ATTEMPTS}), retrying in ${delayMs}ms...`,
        );
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }

  if (lastError instanceof ApiError) {
    if (lastError.status === 429) {
      throw new Error(
        "Gemini API rate limit reached (even after retries). Wait a minute and try again.",
        { cause: lastError },
      );
    }
    if (lastError.status >= 500) {
      throw new Error(
        "The Gemini API is overloaded or having a temporary issue. Please try again in a moment.",
        { cause: lastError },
      );
    }
    if (
      lastError.status === 401 ||
      lastError.status === 403 ||
      (lastError.status === 400 && /api key/i.test(lastError.message))
    ) {
      throw new Error(
        "Gemini rejected the API key. Check that GEMINI_API_KEY is set correctly in your .env file.",
        { cause: lastError },
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * The human-in-the-loop pause. If an approval-gated tool returned a
 * { status: "pending_approval" } draft, show it to the human and either
 * commit the real action (y) or report the decline (n) back to the model.
 * Any other result (e.g. invalid SKUs) passes through untouched so the
 * model can self-correct without bothering the human.
 */
async function resolveApproval(
  tool: AgentTool,
  outcome: ToolOutcome,
  options: RunAgentOptions | undefined,
): Promise<ToolOutcome> {
  let draftEnvelope: unknown;
  try {
    draftEnvelope = JSON.parse(outcome.content);
  } catch {
    return outcome; // not JSON — treat as a normal result
  }
  const isPending =
    draftEnvelope !== null &&
    typeof draftEnvelope === "object" &&
    (draftEnvelope as { status?: unknown }).status === "pending_approval";
  if (!isPending) {
    return outcome;
  }

  // The loop genuinely pauses here: we await the human's answer.
  // In eval mode there is no human, so drafts are auto-approved to keep
  // eval runs non-interactive.
  const approved =
    options?.evalMode === true
      ? true
      : options?.onApprovalRequired !== undefined
        ? await options.onApprovalRequired({
            toolName: tool.name,
            prompt: tool.approvalPrompt ?? `Approve this "${tool.name}" action? (y/n)`,
            draft: JSON.stringify(draftEnvelope, null, 2),
          })
        : false; // no approval channel → decline (the safe default)

  if (!approved) {
    return {
      content: JSON.stringify({
        status: "declined",
        message:
          options?.onApprovalRequired !== undefined
            ? "The user reviewed the draft and DECLINED it. Acknowledge politely; do not retry unless they explicitly ask again."
            : "No human approval channel is available, so the action was cancelled for safety.",
      }),
      isError: false,
    };
  }

  if (tool.commitApproved === undefined) {
    return {
      content: `Tool "${tool.name}" requires approval but has no commitApproved handler — this is a bug in the tool definition.`,
      isError: true,
    };
  }
  try {
    return { content: await tool.commitApproved(draftEnvelope), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `The draft was approved but saving it failed: ${message}`, isError: true };
  }
}

/**
 * Run the agent for one user message.
 *
 * `history` is the ongoing conversation; this function appends the new user
 * message, every intermediate model/functionResponse turn, and the final
 * answer to it in place — so the caller can just keep passing the same array.
 */
export async function runAgent(
  userMessage: string,
  history: Content[],
  options?: RunAgentOptions,
): Promise<AgentRunResult> {
  history.push({ role: "user", parts: [{ text: userMessage }] });

  const toolCallsMade: ToolCallRecord[] = [];
  const tokensUsed: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const incidents: GuardrailIncident[] = [];
  const budget = { used: 0 };
  const functionDeclarations = toGeminiFunctionDeclarations(agentTools);

  // Record (but don't block) suspected prompt-injection attempts — the
  // system prompt handles the refusal; this makes the attempt auditable.
  if (detectInjectionAttempt(userMessage)) {
    incidents.push("injection_attempt_suspected");
    console.warn("  [guardrails] possible prompt-injection attempt recorded");
  }

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let response: GenerateContentResponse;
    try {
      response = await callGemini(history, functionDeclarations, budget);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return await stopForBudget(userMessage, toolCallsMade, tokensUsed, incidents, iteration);
      }
      throw error;
    }
    trackUsage(tokensUsed, response.usageMetadata);

    // Always append the model's full reply (including functionCall parts)
    // so the API sees a complete conversation on the next call.
    const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
    history.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });

    const functionCalls = parts
      .map((part) => part.functionCall)
      .filter((call): call is NonNullable<typeof call> => call != null);

    if (functionCalls.length > 0) {
      // Execute every requested tool; ALL functionResponse parts go back
      // in ONE user turn, in the same order as the calls.
      const responseParts: Part[] = [];
      for (const call of functionCalls) {
        const toolName = call.name ?? "(unnamed)";
        const toolInput = call.args ?? {};
        console.log(`  [tool] ${toolName} ${JSON.stringify(toolInput)}`);

        const tool = agentTools.find((t) => t.name === toolName);
        let outcome: ToolOutcome = tool
          ? await runToolWithGuardrails(tool, toolInput)
          : { content: `Unknown tool "${toolName}".`, isError: true };

        // Approval-gated tools pause the run for a human decision here.
        if (tool !== undefined && tool.requiresApproval === true && !outcome.isError) {
          outcome = await resolveApproval(tool, outcome, options);
        }

        toolCallsMade.push({
          name: toolName,
          input: toolInput,
          result: outcome.content,
          isError: outcome.isError,
        });
        responseParts.push({
          functionResponse: {
            ...(call.id !== undefined ? { id: call.id } : {}),
            name: toolName,
            // Gemini convention: "output" key for success, "error" for failure.
            response: outcome.isError
              ? { error: outcome.content }
              : { output: outcome.content },
          },
        });
      }
      history.push({ role: "user", parts: responseParts });
      continue; // back to Gemini with the tool results
    }

    // No more function calls — collect the final text answer.
    let rawFinalText = parts
      .map((part) => part.text)
      .filter((text): text is string => typeof text === "string")
      .join("")
      .trim();

    // Robustness: the model occasionally returns an empty candidate (seen in
    // baseline eval ps-06). Never hand the customer a blank reply.
    if (rawFinalText.length === 0) {
      rawFinalText =
        "Sorry — I didn't manage to put together a reply there. Could you rephrase your question, or ask me again?";
    }

    // Output guard: any £price in the answer that can't be grounded in
    // this run's tool results (or the catalogue) gets replaced.
    const audit = auditAnswerPrices(
      rawFinalText,
      toolCallsMade.map((call) => call.result),
    );
    if (audit.hallucinated) {
      incidents.push("hallucinated_price");
      console.warn("  [guardrails] unverified price removed from the answer");
    }
    const finalText = audit.answer;

    const result: AgentRunResult = {
      finalText,
      toolCallsMade,
      tokensUsed,
      iterations: iteration,
      incidents,
    };
    logRun({
      userMessage,
      toolCalls: toolCallsMade,
      iterations: iteration,
      tokens: tokensUsed,
      finalAnswer: finalText,
      incidents,
    });
    return result;
  }

  // Log what we have before failing so the run is still traceable.
  incidents.push("max_iterations_hit");
  logRun({
    userMessage,
    toolCalls: toolCallsMade,
    iterations: MAX_ITERATIONS,
    tokens: tokensUsed,
    finalAnswer: "[aborted: max iterations exceeded]",
    incidents,
  });
  throw new MaxIterationsError(MAX_ITERATIONS);
}

/**
 * Graceful stop when the model-call budget runs out: record the incident,
 * open an escalation ticket, and return a polite handoff message instead
 * of crashing the conversation.
 */
async function stopForBudget(
  userMessage: string,
  toolCallsMade: ToolCallRecord[],
  tokensUsed: TokenUsage,
  incidents: GuardrailIncident[],
  iterations: number,
): Promise<AgentRunResult> {
  incidents.push("budget_exceeded");
  console.warn(
    `  [guardrails] model-call budget (${MAX_MODEL_CALLS_PER_RUN}) exceeded — stopping gracefully`,
  );

  let ticketId = "unavailable";
  const escalate = agentTools.find((tool) => tool.name === "escalate_to_human");
  if (escalate !== undefined) {
    try {
      const parsed = JSON.parse(
        await escalate.execute({
          reason: "Agent run exceeded its model-call budget",
          conversationSummary: `The run for "${userMessage}" hit the ${MAX_MODEL_CALLS_PER_RUN}-call budget and was stopped before completing.`,
        }),
      ) as { ticketId?: string };
      ticketId = parsed.ticketId ?? ticketId;
    } catch (error) {
      console.error("  [guardrails] failed to log budget escalation:", error);
    }
  }

  const finalText =
    "I'm sorry — this request needed more processing than I'm allowed to use in one go, so I've stopped and " +
    `passed it to a human colleague (ticket ${ticketId}). They will follow up with you shortly.`;

  const result: AgentRunResult = { finalText, toolCallsMade, tokensUsed, iterations, incidents };
  logRun({
    userMessage,
    toolCalls: toolCallsMade,
    iterations,
    tokens: tokensUsed,
    finalAnswer: finalText,
    incidents,
  });
  return result;
}
