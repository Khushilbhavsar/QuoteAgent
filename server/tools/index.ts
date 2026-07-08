/**
 * Tool registry — the single list of every tool the agent can use.
 *
 * Each tool is described once with a Zod schema (used for runtime
 * validation in the guardrails) and converted automatically to the
 * functionDeclarations format the Gemini API expects, so the two can
 * never drift apart.
 */
import { z } from "zod";
import { Type, type FunctionDeclaration, type Schema } from "@google/genai";
import { searchProductsTool } from "./searchProducts";
import { getProductDetailsTool } from "./getProductDetails";
import { createQuoteRequestTool } from "./createQuoteRequest";
import { checkOrderStatusTool } from "./checkOrderStatus";
import { escalateToHumanTool } from "./escalateToHuman";

/** The shape every tool in the registry must have. */
export interface AgentTool {
  /** snake_case name the model sees and calls */
  name: string;
  /** the model reads this to decide when to use the tool — be specific */
  description: string;
  /** Zod schema used to validate the model's input before execution */
  zodInputSchema: z.ZodType;
  /** Runs the tool; returns a string result that goes back to the model */
  execute: (input: unknown) => Promise<string>;

  // --- Human-in-the-loop approval (generic — ANY tool can opt in) -------
  /**
   * If true, execute() must only VALIDATE and return a JSON draft with
   * { "status": "pending_approval", ... } — no side effects. The agent loop
   * pauses, shows the draft to a human, and only calls commitApproved()
   * after an explicit "yes".
   */
  requiresApproval?: boolean;
  /** The question shown to the human, e.g. "Approve this quote request? (y/n)" */
  approvalPrompt?: string;
  /**
   * Performs the real side effect after human approval. Receives the parsed
   * draft envelope that execute() returned; returns the tool result string.
   */
  commitApproved?: (draftEnvelope: unknown) => Promise<string>;
}

/** All registered tools — all five fully implemented as of Phase 2. */
export const agentTools: AgentTool[] = [
  searchProductsTool,
  getProductDetailsTool,
  createQuoteRequestTool,
  checkOrderStatusTool,
  escalateToHumanTool,
];

// Gemini's Schema format is an OpenAPI-style subset of JSON Schema with
// enum-style types ("STRING", "OBJECT", ...). We convert the JSON Schema
// that Zod v4 emits (z.toJSONSchema) and keep only the fields Gemini
// understands: type, description, enum, properties, required, items.
const TYPE_MAP: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

function jsonSchemaToGeminiSchema(jsonSchema: Record<string, unknown>): Schema {
  const schema: Schema = {};

  const type = jsonSchema["type"];
  if (typeof type === "string" && TYPE_MAP[type] !== undefined) {
    schema.type = TYPE_MAP[type];
  }
  if (typeof jsonSchema["description"] === "string") {
    schema.description = jsonSchema["description"];
  }
  const enumValues = jsonSchema["enum"];
  if (Array.isArray(enumValues)) {
    schema.enum = enumValues.map(String);
    schema.type ??= Type.STRING;
  }
  const properties = jsonSchema["properties"];
  if (properties !== null && typeof properties === "object") {
    schema.properties = {};
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      schema.properties[key] = jsonSchemaToGeminiSchema(value as Record<string, unknown>);
    }
  }
  const required = jsonSchema["required"];
  if (Array.isArray(required)) {
    schema.required = required.filter((entry): entry is string => typeof entry === "string");
  }
  const items = jsonSchema["items"];
  if (items !== null && typeof items === "object") {
    schema.items = jsonSchemaToGeminiSchema(items as Record<string, unknown>);
  }

  return schema;
}

/** Convert our Zod-based tool definitions into Gemini functionDeclarations. */
export function toGeminiFunctionDeclarations(tools: AgentTool[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: jsonSchemaToGeminiSchema(
      z.toJSONSchema(tool.zodInputSchema) as Record<string, unknown>,
    ),
  }));
}
