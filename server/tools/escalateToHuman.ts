/**
 * escalate_to_human — fully implemented in Phase 2.
 * Appends a ticket to db/escalations.jsonl so a (future) human support team
 * can pick the conversation up, and returns the ticket reference.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentTool } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
const ESCALATIONS_PATH = path.join(here, "..", "db", "escalations.jsonl");

const inputSchema = z.object({
  reason: z
    .string()
    .min(1)
    .describe("Why a human is needed, in one sentence — e.g. 'customer is frustrated', 'refund request'"),
  conversationSummary: z
    .string()
    .min(1)
    .describe("Short summary of the conversation so far, so the human has context"),
});

export const escalateToHumanTool: AgentTool = {
  name: "escalate_to_human",
  description:
    "Hand the conversation to a human support agent. Use when the customer is frustrated or angry, " +
    "explicitly asks for a person, or needs something you cannot do (refunds, complaints, account changes).",
  zodInputSchema: inputSchema,
  execute: async (rawInput) => {
    const { reason, conversationSummary } = inputSchema.parse(rawInput);

    const ticket = {
      ticketId: `ESC-${Date.now()}`,
      createdAt: new Date().toISOString(),
      reason,
      conversationSummary,
    };
    fs.appendFileSync(ESCALATIONS_PATH, JSON.stringify(ticket) + "\n", "utf8");

    return JSON.stringify({
      status: "escalated",
      ticketId: ticket.ticketId,
      message: `Escalation ${ticket.ticketId} has been logged. Tell the customer a human agent will follow up shortly, and share the ticket reference.`,
    });
  },
};
