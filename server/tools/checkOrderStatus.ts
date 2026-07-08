/**
 * check_order_status — fully implemented in Phase 2.
 * Looks up an order in db/orders.json, but ONLY when the email AND the
 * order number both match the same order.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentTool } from "./index";

interface Order {
  orderNumber: string;
  email: string;
  status: "processing" | "shipped" | "delivered" | "cancelled";
  placedAt: string;
  items: { sku: string; quantity: number }[];
  total_gbp: number;
  carrier?: string;
  trackingNumber?: string;
  estimatedDelivery?: string;
  deliveredAt?: string;
  cancellationReason?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_PATH = path.join(here, "..", "db", "orders.json");

let orderCache: Order[] | null = null;

function loadOrders(): Order[] {
  if (orderCache === null) {
    orderCache = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8")) as Order[];
  }
  return orderCache;
}

const inputSchema = z.object({
  email: z.email().describe("The email address the order was placed with"),
  orderNumber: z.string().min(1).describe("The order reference, e.g. 'ORD-10042'"),
});

export const checkOrderStatusTool: AgentTool = {
  name: "check_order_status",
  description:
    "Look up the status and tracking of an existing order. Requires BOTH the email address the " +
    "order was placed with AND the order number — ask the customer for whichever is missing.",
  zodInputSchema: inputSchema,
  execute: async (rawInput) => {
    const { email, orderNumber } = inputSchema.parse(rawInput);

    const order = loadOrders().find(
      (candidate) =>
        candidate.orderNumber.toUpperCase() === orderNumber.trim().toUpperCase() &&
        candidate.email.toLowerCase() === email.trim().toLowerCase(),
    );

    // PRIVACY: we return the SAME message whether the order number is wrong,
    // the email is wrong, or neither exists. If we said "that email has no
    // orders" vs "wrong order number for this email", an attacker could probe
    // random emails to learn who is a customer (an "enumeration attack").
    // Requiring both to match — and revealing nothing on failure — prevents that.
    if (order === undefined) {
      return JSON.stringify({
        status: "not_found",
        message:
          "No matching order was found for that email and order number combination. " +
          "Ask the customer to double-check both against their confirmation email.",
      });
    }

    return JSON.stringify({ status: "found", order }, null, 2);
  },
};
