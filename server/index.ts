/**
 * CLI entry point — `npm run chat` starts a terminal chat with QuoteAgent.
 * Conversation history is kept in memory for the whole session, so the
 * agent remembers earlier turns. (This becomes an HTTP API in a later phase.)
 */
import dotenv from "dotenv";
import readline from "node:readline/promises";
import type { Content } from "@google/genai";
import { runAgent } from "./agent/loop";

dotenv.config({ quiet: true });
// This machine has a placeholder GOOGLE_API_KEY in the system environment;
// remove it from our process so the SDK never gets confused about which key
// to use (we always pass GEMINI_API_KEY explicitly anyway).
delete process.env.GOOGLE_API_KEY;

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "Warning: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key\n" +
        "from https://aistudio.google.com/apikey\n",
    );
  }

  console.log("QuoteAgent - DuctStore UK assistant (Phase 1)");
  console.log("Ask about ducting products. Type 'exit' to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Content[] = [];

  while (true) {
    let line: string;
    try {
      line = (await rl.question("You: ")).trim();
    } catch {
      break; // stdin closed (e.g. Ctrl+C or piped input ended)
    }

    if (!line) continue;
    if (line.toLowerCase() === "exit" || line.toLowerCase() === "quit") break;

    try {
      const result = await runAgent(line, history, {
        // Human-in-the-loop guardrail: when an approval-gated tool (like
        // create_quote_request) produces a draft, the agent loop pauses on
        // this callback until you answer y or n in the terminal.
        onApprovalRequired: async ({ toolName, prompt, draft }) => {
          console.log(`\n${"-".repeat(22)} APPROVAL REQUIRED: ${toolName} ${"-".repeat(22)}`);
          console.log(draft);
          console.log("-".repeat(66));
          const answer = (await rl.question(`${prompt} `)).trim().toLowerCase();
          return answer === "y" || answer === "yes";
        },
      });
      console.log(`\nQuoteAgent: ${result.finalText}\n`);
      const incidentNote =
        result.incidents.length > 0 ? `, incidents: ${result.incidents.join(", ")}` : "";
      console.log(
        `  [stats] ${result.iterations} iteration(s), ${result.toolCallsMade.length} tool call(s), ` +
          `${result.tokensUsed.inputTokens} input / ${result.tokensUsed.outputTokens} output tokens${incidentNote}\n`,
      );
    } catch (error) {
      console.error(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  rl.close();
  console.log("Bye!");
}

void main();
