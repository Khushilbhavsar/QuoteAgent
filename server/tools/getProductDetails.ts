/**
 * get_product_details — fully implemented in Phase 2.
 * Looks up ONE product by exact SKU and returns the complete record.
 * (search_products finds products; this tool fetches full details once
 * the SKU is known.)
 */
import { z } from "zod";
import type { AgentTool } from "./index";
import { findProductBySku } from "../db/catalog";

const inputSchema = z.object({
  sku: z.string().min(1).describe("The exact product SKU, e.g. 'GD-CIRC-1M'"),
});

export const getProductDetailsTool: AgentTool = {
  name: "get_product_details",
  description:
    "Get the full catalogue record for a single product by its exact SKU (price, all sizes, live " +
    "stock, category, full description). Use search_products first if you don't know the SKU.",
  zodInputSchema: inputSchema,
  execute: async (rawInput) => {
    const { sku } = inputSchema.parse(rawInput);
    const product = findProductBySku(sku);

    if (product === undefined) {
      return JSON.stringify({
        status: "not_found",
        message: `SKU "${sku}" was not found in the catalogue. Use search_products to find valid SKUs — do not guess.`,
      });
    }
    return JSON.stringify({ status: "found", product }, null, 2);
  },
};
