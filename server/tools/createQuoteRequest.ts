/**
 * create_quote_request — fully implemented in Phase 2, with human approval.
 *
 * This tool deliberately does NOT save anything when the model calls it.
 * execute() only VALIDATES the request and returns a priced DRAFT with
 * status "pending_approval". The agent loop then pauses and asks the human
 * to approve; only after a "y" does the loop call commitApproved(), which
 * actually writes the quote to db/quotes.jsonl.
 *
 * Why: an LLM should never take an irreversible business action (creating
 * quotes, sending emails, charging cards) without a human check. The
 * requiresApproval flag makes that a guardrail, not a convention.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentTool } from "./index";
import { findProductBySku } from "../db/catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const QUOTES_PATH = path.join(here, "..", "db", "quotes.jsonl");

const inputSchema = z.object({
  name: z.string().min(1).describe("The customer's full name"),
  email: z.email().describe("The customer's email address"),
  items: z
    .array(
      z.object({
        sku: z.string().min(1).describe("Product SKU from the catalogue"),
        quantity: z.number().int().positive().describe("How many units"),
      }),
    )
    .min(1)
    .describe("The products and quantities to quote"),
  notes: z.string().optional().describe("Special requirements or delivery notes"),
});

interface QuoteLine {
  sku: string;
  name: string;
  quantity: number;
  unit_price_gbp: number;
  line_total_gbp: number;
}

export interface QuoteDraft {
  name: string;
  email: string;
  items: QuoteLine[];
  total_gbp: number;
  notes?: string;
}

const roundGbp = (value: number): number => Math.round(value * 100) / 100;

export const createQuoteRequestTool: AgentTool = {
  name: "create_quote_request",
  description:
    "Create a formal quote request once the customer has CONFIRMED the exact products, quantities, " +
    "their name and their email. Every SKU must come from the catalogue (via search_products / " +
    "get_product_details). The quote is sent for approval before it is saved.",
  zodInputSchema: inputSchema,
  requiresApproval: true,
  approvalPrompt: "Approve this quote request? (y/n)",
  execute: async (rawInput) => {
    const input = inputSchema.parse(rawInput);

    // Validate every SKU against the real catalogue first.
    const unknownSkus = input.items
      .map((item) => item.sku)
      .filter((sku) => findProductBySku(sku) === undefined);
    if (unknownSkus.length > 0) {
      return JSON.stringify({
        status: "invalid_items",
        unknownSkus,
        message:
          `These SKUs do not exist in the catalogue: ${unknownSkus.join(", ")}. ` +
          "Use search_products to find the correct SKUs, confirm them with the customer, and try again.",
      });
    }

    // Build the priced draft — but do NOT save it. The loop pauses here
    // for human approval because requiresApproval is true.
    const lines: QuoteLine[] = input.items.map((item) => {
      const product = findProductBySku(item.sku)!; // validated above
      return {
        sku: product.sku,
        name: product.name,
        quantity: item.quantity,
        unit_price_gbp: product.price_gbp,
        line_total_gbp: roundGbp(product.price_gbp * item.quantity),
      };
    });

    const quoteDraft: QuoteDraft = {
      name: input.name,
      email: input.email,
      items: lines,
      total_gbp: roundGbp(lines.reduce((sum, line) => sum + line.line_total_gbp, 0)),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };

    return JSON.stringify({ status: "pending_approval", quoteDraft }, null, 2);
  },

  // Runs ONLY after the human typed "y" — this is the real side effect.
  commitApproved: async (draftEnvelope) => {
    const { quoteDraft } = draftEnvelope as { quoteDraft: QuoteDraft };
    const quote = {
      quoteId: `Q-${Date.now()}`,
      createdAt: new Date().toISOString(),
      ...quoteDraft,
    };
    fs.appendFileSync(QUOTES_PATH, JSON.stringify(quote) + "\n", "utf8");
    return JSON.stringify({
      status: "created",
      quoteId: quote.quoteId,
      message: `Quote request ${quote.quoteId} was approved and saved. Confirm to the customer that their quote is on its way to ${quoteDraft.email}.`,
    });
  },
};
