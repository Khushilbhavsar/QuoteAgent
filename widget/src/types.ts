/** Shared types mirroring the API's JSON shapes (see server/server.ts). */

export interface QuoteDraftLine {
  sku: string;
  name: string;
  quantity: number;
  unit_price_gbp: number;
  line_total_gbp: number;
}

export interface QuoteDraft {
  name: string;
  email: string;
  items: QuoteDraftLine[];
  total_gbp: number;
  notes?: string;
}

export type ChatState = "done" | "pending_approval" | "rate_limited" | "error";

/** The normalised response every API call resolves to. */
export interface ChatResponse {
  sessionId: string;
  state: ChatState;
  reply: string;
  quoteDraft?: QuoteDraft;
}

/** One line in the visible transcript. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}
