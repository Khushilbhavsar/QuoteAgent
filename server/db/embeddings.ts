/**
 * Local semantic search — no API, no key, no cost.
 *
 * How it works (the 60-second version):
 * - An "embedding" turns a piece of text into a list of 384 numbers (a
 *   vector) that captures its MEANING, not its exact words. Texts that mean
 *   similar things get vectors that point in similar directions.
 * - "Cosine similarity" measures the angle between two vectors: 1.0 = same
 *   meaning, 0 = unrelated. Because we normalise every vector to length 1,
 *   the similarity is just the dot product — one multiply-add per number.
 * - So: buildIndex() embeds every product once and saves the vectors;
 *   semanticSearch() embeds the query and finds the closest product vectors.
 *   That's why "something to connect two round ducts" can find a "coupler"
 *   even though they share no keywords.
 *
 * The model (Xenova/all-MiniLM-L6-v2, ~25 MB) is downloaded from Hugging
 * Face the FIRST time it's used, then cached locally and runs fully offline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@xenova/transformers";
import { loadProducts, type Product } from "./catalog";
import { NonRetryableError } from "../agent/guardrails";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(here, "product-index.json");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

interface ProductIndex {
  model: string;
  createdAt: string;
  entries: { sku: string; vector: number[] }[];
}

// The pipeline is expensive to create (loads the model), so it's a
// lazily-created singleton — built once, reused for every embed() call.
type Extractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;
let extractor: Extractor | null = null;

async function getExtractor(): Promise<Extractor> {
  if (extractor === null) {
    extractor = await pipeline("feature-extraction", MODEL_ID);
  }
  return extractor;
}

/** Turn text into a normalised 384-number embedding vector. */
export async function embed(text: string): Promise<number[]> {
  const model = await getExtractor();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/** The text we embed per product — name, category, sizes AND description,
    so queries can match on any of them. */
function productToText(product: Product): string {
  return `${product.name}. Category: ${product.category}. Sizes: ${product.sizes.join(", ")}. ${product.description}`;
}

/** Embed every product and save the vectors to db/product-index.json. */
export async function buildIndex(): Promise<ProductIndex> {
  const products = loadProducts();
  const entries: ProductIndex["entries"] = [];
  for (const product of products) {
    entries.push({ sku: product.sku, vector: await embed(productToText(product)) });
    console.log(`  embedded ${product.sku} (${entries.length}/${products.length})`);
  }
  const index: ProductIndex = {
    model: MODEL_ID,
    createdAt: new Date().toISOString(),
    entries,
  };
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index), "utf8");
  return index;
}

let indexCache: ProductIndex | null = null;

function loadIndex(): ProductIndex {
  if (indexCache === null) {
    if (!fs.existsSync(INDEX_PATH)) {
      // NonRetryableError: retrying won't create the missing file, so the
      // guardrails skip the retry loop and fail fast with this message.
      throw new NonRetryableError(
        "Product index not found. Run `npm run build-index` once to generate it, then try again.",
      );
    }
    indexCache = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as ProductIndex;
  }
  return indexCache;
}

/** Both vectors are normalised, so the dot product IS the cosine similarity. */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export interface SearchResult {
  product: Product;
  /** 0..1 — how close in meaning the product is to the query */
  score: number;
}

/** Embed the query and return the topK most similar products with scores. */
export async function semanticSearch(query: string, topK = 5): Promise<SearchResult[]> {
  const index = loadIndex();
  const products = loadProducts();
  if (index.entries.length !== products.length) {
    console.warn(
      "[embeddings] products.json has changed since the index was built — run `npm run build-index` to refresh it.",
    );
  }

  const queryVector = await embed(query);
  const bySku = new Map(products.map((product) => [product.sku, product]));

  return index.entries
    .map((entry) => ({
      product: bySku.get(entry.sku),
      score: dotProduct(queryVector, entry.vector),
    }))
    .filter((result): result is SearchResult => result.product !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
