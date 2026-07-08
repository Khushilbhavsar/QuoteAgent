/**
 * `npm run build-index` — (re)generates db/product-index.json.
 * Run this once after install, and again whenever products.json changes.
 */
import { buildIndex } from "./embeddings";

console.log("Building product embedding index...");
console.log("(first run downloads the ~25 MB model from Hugging Face, then it's cached locally)\n");

const index = await buildIndex();

console.log(`\nDone: indexed ${index.entries.length} products -> server/db/product-index.json`);
