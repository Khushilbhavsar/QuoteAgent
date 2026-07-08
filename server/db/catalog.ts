/**
 * Shared catalogue access — several tools (search, product details, quotes)
 * and the embedding index all need the product list, so it's loaded in ONE
 * place instead of every file re-implementing its own JSON reader.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTS_PATH = path.join(here, "products.json");

export interface Product {
  name: string;
  sku: string;
  price_gbp: number;
  sizes: string[];
  stock: number;
  category: string;
  description: string;
}

let cache: Product[] | null = null;

export function loadProducts(): Product[] {
  if (cache === null) {
    cache = JSON.parse(fs.readFileSync(PRODUCTS_PATH, "utf8")) as Product[];
  }
  return cache;
}

/** Case-insensitive SKU lookup, tolerant of stray whitespace. */
export function findProductBySku(sku: string): Product | undefined {
  const wanted = sku.trim().toUpperCase();
  return loadProducts().find((product) => product.sku.toUpperCase() === wanted);
}
