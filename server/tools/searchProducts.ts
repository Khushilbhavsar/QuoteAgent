/**
 * search_products — now powered by SEMANTIC search (Phase 2).
 * Instead of matching keywords, it compares the MEANING of the query with
 * the meaning of every product (see db/embeddings.ts for how). That's why
 * "something to connect two round ducts" finds couplers and flanges even
 * though none of those words appear in the query.
 */
import { z } from "zod";
import type { AgentTool } from "./index";
import { semanticSearch } from "../db/embeddings";

// Below this similarity score a "match" is just noise. Returning nothing is
// safer than returning a bad match — it stops the model inventing products.
const MIN_SCORE = 0.4;
const TOP_K = 5;

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What the customer is looking for, in natural language — e.g. '200mm circular duct', " +
        "'something to connect two round ducts', or 'stop draughts blowing back in'",
    ),
});

export const searchProductsTool: AgentTool = {
  name: "search_products",
  description:
    "Semantic search over the DuctStore UK catalogue. Describe what the customer needs in natural " +
    "language; returns the closest matching products with name, SKU, price in GBP, sizes, stock, " +
    "category, description, and a similarity score. Use this before answering ANY question about " +
    "products, prices, sizes, or availability.",
  zodInputSchema: inputSchema,
  execute: async (rawInput) => {
    const { query } = inputSchema.parse(rawInput);
    const results = await semanticSearch(query, TOP_K);
    const matches = results.filter((result) => result.score >= MIN_SCORE);

    if (matches.length === 0) {
      return JSON.stringify({
        matches: [],
        message:
          `No products closely match "${query}" — DuctStore UK almost certainly does not stock this. ` +
          "Tell the customer honestly. Do NOT invent, guess, or suggest products that this tool did not return.",
      });
    }

    return JSON.stringify(
      {
        matches: matches.map(({ product, score }) => ({
          similarity: Number(score.toFixed(3)),
          ...product,
        })),
      },
      null,
      2,
    );
  },
};
