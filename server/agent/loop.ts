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
 * Human-in-the-loop approval works three ways, chosen by the caller:
 *   - evalMode:        auto-approve drafts (non-interactive eval runs)
 *   - onApprovalRequired: await a callback in place (the CLI's y/n prompt)
 *   - pauseOnApproval: RETURN the draft + a resumable snapshot so an HTTP
 *                      server can answer request 1 now and finish the run in
 *                      request 2 (/api/approve). See runAgentTurn / resumeAgentTurn.
 *
 * Every completed run is appended to server/db/runs.jsonl by the logger.
 */
import {
  GoogleGenAI,
  ApiError,
  type Content,
  type Part,
  type FunctionDeclaration,
  type FunctionCall,
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

/** What a completed run returns — the Phase 1 shape plus guardrail incidents. */
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
   * commit, false = decline. Used by the CLI.
   */
  onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean>;
  /**
   * Eval mode: auto-approve every pending_approval draft so eval runs are
   * non-interactive. NEVER set this in the real chat/API path.
   */
  evalMode?: boolean;
  /**
   * HTTP mode: instead of blocking, the loop RETURNS a { status:
   * "pending_approval" } outcome carrying a resumable snapshot. The server
   * stores it and later calls resumeAgentTurn() with the human's decision.
   */
  pauseOnApproval?: boolean;
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

// ---------------------------------------------------------------- approval helpers

/** True if a tool result is an unresolved { status: "pending_approval" } draft. */
function isPendingApproval(content: string): unknown | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    return null;
  }
  const pending =
    envelope !== null &&
    typeof envelope === "object" &&
    (envelope as { status?: unknown }).status === "pending_approval";
  return pending ? envelope : null;
}

/** Run a tool's real side effect after approval, translating failures. */
async function commitApproved(tool: AgentTool, draftEnvelope: unknown): Promise<ToolOutcome> {
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

/** The tool result to feed back when a draft is declined. */
function declineOutcome(hasHumanChannel: boolean): ToolOutcome {
  return {
    content: JSON.stringify({
      status: "declined",
      message: hasHumanChannel
        ? "The user reviewed the draft and DECLINED it. Acknowledge politely; do not retry unless they explicitly ask again."
        : "No human approval channel is available, so the action was cancelled for safety.",
    }),
    isError: false,
  };
}

/** Build the Gemini functionResponse part for one tool call's outcome. */
function toResponsePart(name: string, callId: string | undefined, outcome: ToolOutcome): Part {
  return {
    functionResponse: {
      ...(callId !== undefined ? { id: callId } : {}),
      name,
      // Gemini convention: "output" key for success, "error" for failure.
      response: outcome.isError ? { error: outcome.content } : { output: outcome.content },
    },
  };
}

// ---------------------------------------------------------------- run state

/** Mutable state of one run — the part that must survive an approval pause. */
interface RunContext {
  history: Content[];
  toolCallsMade: ToolCallRecord[];
  tokensUsed: TokenUsage;
  incidents: GuardrailIncident[];
  budget: { used: number };
  /** First user message of the run, kept for the log entry. */
  userMessage: string;
  /** How many Gemini turns we have taken (for the MAX_ITERATIONS cap). */
  iteration: number;
}

/** What the caller shows a human when a run pauses for approval. */
export interface PendingApprovalInfo {
  toolName: string;
  approvalPrompt: string;
  /** Pretty-printed draft envelope. */
  draft: string;
  /** Structured draft (e.g. the quote), for rendering an approval card. */
  quoteDraft?: unknown;
}

/**
 * A frozen, resumable snapshot of a run paused at an approval. Stored in the
 * server's session and passed back to resumeAgentTurn() with the decision.
 */
export interface PausedRun {
  context: RunContext;
  /** Tool responses for the paused turn; the approval slot is a null hole. */
  responseParts: (Part | null)[];
  approvalIndex: number;
  toolName: string;
  callId?: string;
  draftEnvelope: unknown;
}

/** A run either finishes, or pauses waiting for a human approval. */
export type RunOutcome =
  | { status: "done"; result: AgentRunResult }
  | { status: "pending_approval"; pending: PendingApprovalInfo; paused: PausedRun };

// ---------------------------------------------------------------- the loop

const functionCallsOf = (parts: Part[]): FunctionCall[] =>
  parts.map((part) => part.functionCall).filter((call): call is FunctionCall => call != null);

/**
 * Drive the Gemini <-> tools loop over a run context until it produces a
 * final answer, pauses for approval (pauseOnApproval), or hits a cap.
 *
 * `resumeParts`, when given, are the completed tool responses of a
 * previously-paused turn: we push them as the next user turn and carry on.
 */
async function driveLoop(
  ctx: RunContext,
  options: RunAgentOptions | undefined,
  resumeParts: Part[] | undefined,
): Promise<RunOutcome> {
  const functionDeclarations = toGeminiFunctionDeclarations(agentTools);

  if (resumeParts !== undefined) {
    ctx.history.push({ role: "user", parts: resumeParts });
    ctx.iteration += 1; // the approval turn is done; the next Gemini call is a new turn
  }

  while (ctx.iteration <= MAX_ITERATIONS) {
    let response: GenerateContentResponse;
    try {
      response = await callGemini(ctx.history, functionDeclarations, ctx.budget);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return { status: "done", result: await stopForBudget(ctx) };
      }
      throw error;
    }
    trackUsage(ctx.tokensUsed, response.usageMetadata);

    // Always append the model's full reply (including functionCall parts)
    // so the API sees a complete conversation on the next call.
    const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
    ctx.history.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });

    const functionCalls = functionCallsOf(parts);

    if (functionCalls.length > 0) {
      // Execute every requested tool; ALL functionResponse parts go back in
      // ONE user turn, in the same order as the calls.
      const responseParts: (Part | null)[] = [];
      let pause: { index: number; toolName: string; callId?: string; draftEnvelope: unknown } | null = null;

      for (let i = 0; i < functionCalls.length; i++) {
        const call = functionCalls[i];
        const toolName = call.name ?? "(unnamed)";
        const toolInput = call.args ?? {};
        console.log(`  [tool] ${toolName} ${JSON.stringify(toolInput)}`);

        const tool = agentTools.find((t) => t.name === toolName);
        let outcome: ToolOutcome = tool
          ? await runToolWithGuardrails(tool, toolInput)
          : { content: `Unknown tool "${toolName}".`, isError: true };

        const draftEnvelope =
          tool?.requiresApproval === true && !outcome.isError ? isPendingApproval(outcome.content) : null;

        if (draftEnvelope !== null && tool !== undefined) {
          if (options?.evalMode === true) {
            outcome = await commitApproved(tool, draftEnvelope);
          } else if (options?.pauseOnApproval === true && pause === null) {
            // Defer this call: remember the hole, and pause AFTER finishing
            // the rest of the turn so every call still gets a response.
            pause = {
              index: i,
              toolName,
              ...(call.id !== undefined ? { callId: call.id } : {}),
              draftEnvelope,
            };
            responseParts.push(null); // placeholder, filled on resume
            continue;
          } else if (options?.onApprovalRequired !== undefined) {
            const approved = await options.onApprovalRequired({
              toolName,
              prompt: tool.approvalPrompt ?? `Approve this "${toolName}" action? (y/n)`,
              draft: JSON.stringify(draftEnvelope, null, 2),
            });
            outcome = approved ? await commitApproved(tool, draftEnvelope) : declineOutcome(true);
          } else {
            outcome = declineOutcome(false); // no channel → decline (safe default)
          }
        }

        ctx.toolCallsMade.push({
          name: toolName,
          input: toolInput,
          result: outcome.content,
          isError: outcome.isError,
        });
        responseParts.push(toResponsePart(toolName, call.id, outcome));
      }

      if (pause !== null) {
        const envelope = pause.draftEnvelope as { quoteDraft?: unknown };
        const tool = agentTools.find((t) => t.name === pause!.toolName);
        return {
          status: "pending_approval",
          pending: {
            toolName: pause.toolName,
            approvalPrompt: tool?.approvalPrompt ?? `Approve this "${pause.toolName}" action?`,
            draft: JSON.stringify(pause.draftEnvelope, null, 2),
            quoteDraft: envelope.quoteDraft,
          },
          paused: {
            context: ctx,
            responseParts,
            approvalIndex: pause.index,
            toolName: pause.toolName,
            ...(pause.callId !== undefined ? { callId: pause.callId } : {}),
            draftEnvelope: pause.draftEnvelope,
          },
        };
      }

      ctx.history.push({ role: "user", parts: responseParts.filter((p): p is Part => p !== null) });
      ctx.iteration += 1;
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

    // Output guard: any £price in the answer that can't be grounded in this
    // run's tool results (or the catalogue) gets replaced.
    const audit = auditAnswerPrices(
      rawFinalText,
      ctx.toolCallsMade.map((call) => call.result),
    );
    if (audit.hallucinated) {
      ctx.incidents.push("hallucinated_price");
      console.warn("  [guardrails] unverified price removed from the answer");
    }

    const result: AgentRunResult = {
      finalText: audit.answer,
      toolCallsMade: ctx.toolCallsMade,
      tokensUsed: ctx.tokensUsed,
      iterations: ctx.iteration,
      incidents: ctx.incidents,
    };
    logRun({
      userMessage: ctx.userMessage,
      toolCalls: ctx.toolCallsMade,
      iterations: ctx.iteration,
      tokens: ctx.tokensUsed,
      finalAnswer: audit.answer,
      incidents: ctx.incidents,
    });
    return { status: "done", result };
  }

  // Log what we have before failing so the run is still traceable.
  ctx.incidents.push("max_iterations_hit");
  logRun({
    userMessage: ctx.userMessage,
    toolCalls: ctx.toolCallsMade,
    iterations: MAX_ITERATIONS,
    tokens: ctx.tokensUsed,
    finalAnswer: "[aborted: max iterations exceeded]",
    incidents: ctx.incidents,
  });
  throw new MaxIterationsError(MAX_ITERATIONS);
}

// ---------------------------------------------------------------- public API

/**
 * Start a run for one user message. Returns either a finished result or a
 * pending-approval snapshot (only possible when pauseOnApproval is set).
 *
 * `history` is the ongoing conversation; this function appends the new user
 * message and every intermediate turn to it in place.
 */
export async function runAgentTurn(
  userMessage: string,
  history: Content[],
  options?: RunAgentOptions,
): Promise<RunOutcome> {
  history.push({ role: "user", parts: [{ text: userMessage }] });

  const ctx: RunContext = {
    history,
    toolCallsMade: [],
    tokensUsed: { inputTokens: 0, outputTokens: 0 },
    incidents: [],
    budget: { used: 0 },
    userMessage,
    iteration: 1,
  };

  // Record (but don't block) suspected prompt-injection attempts — the system
  // prompt handles the refusal; this makes the attempt auditable.
  if (detectInjectionAttempt(userMessage)) {
    ctx.incidents.push("injection_attempt_suspected");
    console.warn("  [guardrails] possible prompt-injection attempt recorded");
  }

  return driveLoop(ctx, options, undefined);
}

/**
 * Resume a run that paused for approval. `approved` = the human's decision.
 * Commits or declines the draft, then drives the loop to a final answer.
 */
export async function resumeAgentTurn(
  paused: PausedRun,
  approved: boolean,
  options?: RunAgentOptions,
): Promise<RunOutcome> {
  const tool = agentTools.find((t) => t.name === paused.toolName);
  let outcome: ToolOutcome;
  if (tool === undefined) {
    outcome = { content: `Tool "${paused.toolName}" not found on resume.`, isError: true };
  } else if (approved) {
    outcome = await commitApproved(tool, paused.draftEnvelope);
  } else {
    outcome = declineOutcome(true);
  }

  paused.context.toolCallsMade.push({
    name: paused.toolName,
    input: paused.draftEnvelope,
    result: outcome.content,
    isError: outcome.isError,
  });

  // Fill the null hole with the decided response, then continue the turn.
  const filled = [...paused.responseParts];
  filled[paused.approvalIndex] = toResponsePart(paused.toolName, paused.callId, outcome);
  const completeParts = filled.filter((part): part is Part => part !== null);

  return driveLoop(paused.context, options, completeParts);
}

/**
 * Convenience wrapper for callers that never pause (CLI with
 * onApprovalRequired, or evals with evalMode): returns the finished result
 * directly. Throws if a pause was somehow requested without a pause handler.
 */
export async function runAgent(
  userMessage: string,
  history: Content[],
  options?: RunAgentOptions,
): Promise<AgentRunResult> {
  const outcome = await runAgentTurn(userMessage, history, options);
  if (outcome.status === "pending_approval") {
    throw new Error(
      "runAgent() reached a pending approval but no approval channel was provided. " +
        "Use runAgentTurn()/resumeAgentTurn() for the HTTP pause flow, or pass onApprovalRequired/evalMode.",
    );
  }
  return outcome.result;
}

/**
 * Graceful stop when the model-call budget runs out: record the incident,
 * open an escalation ticket, and return a polite handoff message instead of
 * crashing the conversation.
 */
async function stopForBudget(ctx: RunContext): Promise<AgentRunResult> {
  ctx.incidents.push("budget_exceeded");
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
          conversationSummary: `The run for "${ctx.userMessage}" hit the ${MAX_MODEL_CALLS_PER_RUN}-call budget and was stopped before completing.`,
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

  const result: AgentRunResult = {
    finalText,
    toolCallsMade: ctx.toolCallsMade,
    tokensUsed: ctx.tokensUsed,
    iterations: ctx.iteration,
    incidents: ctx.incidents,
  };
  logRun({
    userMessage: ctx.userMessage,
    toolCalls: ctx.toolCallsMade,
    iterations: ctx.iteration,
    tokens: ctx.tokensUsed,
    finalAnswer: finalText,
    incidents: ctx.incidents,
  });
  return result;
}
