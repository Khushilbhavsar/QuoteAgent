/**
 * Build-time model warm-up. The embedding model (Xenova/all-MiniLM-L6-v2,
 * ~25 MB) downloads from Hugging Face the first time it's used. Running this
 * during the deploy BUILD downloads and caches it into node_modules, so the
 * first live customer search isn't slowed by that download at request time.
 *
 * It is deliberately non-fatal: if the download fails during build, we exit 0
 * so the deploy still succeeds — the model will simply download on first use.
 */
import { embed } from "./embeddings";

async function main(): Promise<void> {
  console.log("Prewarming embedding model (Xenova/all-MiniLM-L6-v2)...");
  const started = Date.now();
  await embed("warm up the embedding model");
  console.log(`Embedding model ready in ${Date.now() - started}ms.`);
}

main().catch((error) => {
  console.error("Prewarm skipped — model will download on first use:", error);
  process.exit(0);
});
