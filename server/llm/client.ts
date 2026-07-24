/**
 * Provider-swappable LLM client. The agent loop talks to THIS module, never to
 * a vendor SDK directly, so switching model/provider is a one-env-var change:
 *
 *   LLM_PROVIDER=gemini   (default) — gemini-2.5-flash via @google/genai
 *   LLM_PROVIDER=groq                — llama-3.3-70b-versatile via Groq's
 *                                      OpenAI-compatible API (GROQ_API_KEY)
 *
 * Why Groq is here: Groq's free tier is far more generous than Gemini's
 * ~20 requests/day, so you can run bulk evals on Groq and keep the scarce
 * Gemini quota for real customer chats.
 *
 * Both providers return the same neutral `ModelTurn` (Gemini-style parts), so
 * the loop's code is identical whichever provider is active.
 *
 * NOTE: the Gemini path is the tested default. The Groq path is a complete,
 * type-checked implementation but is UNTESTED here (no GROQ_API_KEY was
 * available) — treat it as opt-in until you've run it with your own key.
 */
import {
  GoogleGenAI,
  type Content,
  type Part,
  type FunctionDeclaration,
} from "@google/genai";
import { SYSTEM_PROMPT } from "../agent/prompts";

/** The neutral shape every provider returns — Gemini-style parts + token usage. */
export interface ModelTurn {
  parts: Part[];
  usage: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const PROVIDER = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const MAX_OUTPUT_TOKENS = 8192;

export function providerName(): string {
  return PROVIDER;
}

// ------------------------------------------------------------ Gemini (default)

let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (geminiClient === null) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not set. Copy .env.example to .env and paste your key from https://aistudio.google.com/apikey",
      );
    }
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

async function generateGemini(contents: Content[], functionDeclarations: FunctionDeclaration[]): Promise<ModelTurn> {
  const res = await getGemini().models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // 2.5-series models "think" before answering by default; a support agent
      // doesn't need it, and it burns free-tier tokens.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return {
    parts: res.candidates?.[0]?.content?.parts ?? [],
    usage: {
      promptTokenCount: res.usageMetadata?.promptTokenCount,
      candidatesTokenCount: res.usageMetadata?.candidatesTokenCount,
    },
  };
}

// ------------------------------------------------------------ Groq (opt-in)

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}
interface GroqResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Read the `output`/`error` value out of a Gemini functionResponse. */
function functionResponseText(response: unknown): string {
  if (response !== null && typeof response === "object") {
    const obj = response as { output?: unknown; error?: unknown };
    const value = obj.output ?? obj.error ?? "";
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return "";
}

/** Translate the Gemini-format conversation into OpenAI/Groq chat messages. */
function toOpenAiMessages(contents: Content[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  for (const content of contents) {
    const parts = content.parts ?? [];
    if (content.role === "model") {
      const text = parts.map((p) => p.text).filter((t): t is string => typeof t === "string").join("");
      const toolCalls: OpenAiToolCall[] = parts
        .filter((p) => p.functionCall != null)
        .map((p) => ({
          id: p.functionCall?.id ?? p.functionCall?.name ?? "",
          type: "function",
          function: { name: p.functionCall?.name ?? "", arguments: JSON.stringify(p.functionCall?.args ?? {}) },
        }));
      const message: OpenAiMessage = { role: "assistant", content: text === "" ? null : text };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      messages.push(message);
      continue;
    }
    // role === "user": either a plain message OR tool (functionResponse) results.
    const toolResponses = parts.filter((p) => p.functionResponse != null);
    if (toolResponses.length > 0) {
      for (const p of toolResponses) {
        const fr = p.functionResponse;
        messages.push({
          role: "tool",
          tool_call_id: fr?.id ?? fr?.name ?? "",
          content: functionResponseText(fr?.response),
        });
      }
    } else {
      messages.push({ role: "user", content: parts.map((p) => p.text ?? "").join("") });
    }
  }
  return messages;
}

async function generateGroq(contents: Content[], functionDeclarations: FunctionDeclaration[]): Promise<ModelTurn> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set (required when LLM_PROVIDER=groq). Get a free key at https://console.groq.com/keys");
  }

  const messages: OpenAiMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...toOpenAiMessages(contents)];
  const tools = functionDeclarations.map((fd) => ({
    type: "function" as const,
    function: { name: fd.name, description: fd.description, parameters: fd.parameters ?? { type: "object", properties: {} } },
  }));

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as GroqResponse;
  const message = data.choices?.[0]?.message;
  const parts: Part[] = [];
  if (message?.content != null && message.content !== "") parts.push({ text: message.content });
  for (const call of message?.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }
    parts.push({ functionCall: { id: call.id, name: call.function.name, args } });
  }
  return {
    parts,
    usage: { promptTokenCount: data.usage?.prompt_tokens, candidatesTokenCount: data.usage?.completion_tokens },
  };
}

// ------------------------------------------------------------ public

/** One model turn. Chooses the provider from LLM_PROVIDER (default: gemini). */
export function generate(contents: Content[], functionDeclarations: FunctionDeclaration[]): Promise<ModelTurn> {
  return PROVIDER === "groq" ? generateGroq(contents, functionDeclarations) : generateGemini(contents, functionDeclarations);
}
