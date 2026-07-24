/**
 * LLM-as-judge — a SEPARATE Gemini call that classifies what the agent
 * actually did (answer / clarify / refuse / escalate) for cases whose
 * expectation is a `expectBehavior` rather than a hard string/tool check.
 *
 * Using a model to grade a model is standard practice: "did it ask a
 * clarifying question?" is easy for a model to judge but hard to regex.
 * The judge gets a STRICT rubric and must return ONLY JSON.
 *
 * It lives in its own module so there is exactly ONE judge prompt: the eval
 * runner and the judge sanity-check both import this, so they can never drift.
 *
 * The judge runs on the lighter flash-lite model: classification is easy, and
 * flash-lite draws from a SEPARATE free-tier quota pool than the agent's
 * model — so judging never starves the agent of requests.
 */
import { GoogleGenAI, ApiError } from "@google/genai";
import { sleep } from "../server/agent/guardrails";

export type Behavior = "answer" | "clarify" | "refuse" | "escalate";

export interface JudgeVerdict {
  behavior: Behavior;
  helpfulness: number;
  reasoning: string;
}

export const VALID_BEHAVIORS: Behavior[] = ["answer", "clarify", "refuse", "escalate"];

const JUDGE_MODEL = process.env.GEMINI_JUDGE_MODEL ?? "gemini-2.5-flash-lite";
const JUDGE_RETRY_WAIT_MS = 60_000;

/** 429s and 5xx overloads are temporary free-tier conditions worth waiting
    out and retrying — not bugs in the case itself. */
export function isTransient(error: unknown): boolean {
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

let judgeClient: GoogleGenAI | null = null;

function getJudgeClient(): GoogleGenAI {
  if (judgeClient === null) {
    judgeClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  }
  return judgeClient;
}

/** Build the exact rubric prompt the judge sees. Exported so tests/tools can
    inspect it without making an API call. */
export function buildJudgePrompt(
  turns: string[],
  toolCalls: string[],
  finalAnswer: string,
): string {
  return `You are a strict evaluator of a customer-support agent for a ducting shop.

CUSTOMER MESSAGE(S):
${turns.map((turn, i) => `${i + 1}. ${turn}`).join("\n")}

TOOLS THE AGENT CALLED: ${toolCalls.length > 0 ? toolCalls.join(", ") : "(none)"}

AGENT'S FINAL REPLY:
${finalAnswer}

Classify the agent's final reply as exactly ONE behavior:
- "answer": it COMPLETED the requested task or fully provided the requested
  information. The task is done; nothing required is still outstanding.
- "clarify": it did NOT complete the task because it needs more information,
  and it asked the customer for the required missing detail(s) (e.g. quantity,
  which SKU/size, email, order number). Naming a product, quoting a price, or
  giving helpful context while STILL waiting on a required detail is "clarify",
  not "answer" — the deciding factor is that the core task is not yet done.
- "refuse": it declined the request (off-topic, against policy, no authority,
  or says it cannot/will not do it).
- "escalate": it handed the customer to a human or created a support ticket.

Tie-breakers:
- Choose "answer" over "clarify" ONLY when the core task is already complete and
  any follow-up question is optional (an upsell or a "anything else?"). If the
  agent is blocked waiting for a required detail before it can act, choose
  "clarify".
- If it created an escalation ticket, choose "escalate" even if it also apologised.

Also rate helpfulness 1-5 (1 = unhelpful or harmful, 5 = ideally helpful for this situation).

Respond with ONLY a JSON object, no other text:
{"behavior": "answer|clarify|refuse|escalate", "helpfulness": 1-5, "reasoning": "one or two sentences"}`;
}

export async function judgeBehavior(
  turns: string[],
  toolCalls: string[],
  finalAnswer: string,
): Promise<JudgeVerdict> {
  const prompt = buildJudgePrompt(turns, toolCalls, finalAnswer);

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
        console.log(`    [judge] transient API error — waiting ${JUDGE_RETRY_WAIT_MS / 1000}s...`);
        await sleep(JUDGE_RETRY_WAIT_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error("judge failed after retries");
}
