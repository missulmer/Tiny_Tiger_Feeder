import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo, StoredAlias } from '../store/repo.js';
import { FLAVOR_KINDS, TEXTURES } from '../domain/types.js';
import type { Flavor, FlavorKind, Product, Texture } from '../domain/types.js';
import { CONFIRM_HINT, jsonTool, parsePatch, slugify, uniqueId, withConfirm } from './preview.js';
import { DATE_RE, localToday } from './time.js';

const KINDS: readonly FlavorKind[] = FLAVOR_KINDS;

const positiveNum = z.number().positive();
const priceEntry = z.object({
  casePrice: positiveNum, seenOn: z.string().regex(DATE_RE, 'must be YYYY-MM-DD'), source: z.string().min(1),
}).strict();
const FLAVOR_FIELDS = [
  'id', 'productId', 'name', 'primaryProtein', 'texture', 'contains', 'ingredientsText', 'cansPerCase', 'canOz',
  'kind', 'unit', 'provenAtOnboarding',
] as const;
const flavorPatch = z.object({
  id: z.string(), productId: z.string().min(1), name: z.string().min(1), primaryProtein: z.string().min(1),
  texture: z.enum(TEXTURES), contains: z.array(z.string()).nullable().transform(normalizeContains),
  ingredientsText: z.string().nullable(), cansPerCase: positiveNum, canOz: positiveNum,
  kind: z.enum(FLAVOR_KINDS), unit: z.enum(['can', 'tube', 'cup']), provenAtOnboarding: z.boolean(),
}).partial();
const PRODUCT_FIELDS = [
  'id', 'brand', 'line', 'name', 'canOz', 'cansPerCase', 'isVarietyPack', 'upc', 'store', 'prices', 'status',
] as const;
const productPatch = z.object({
  id: z.string(), brand: z.string(), line: z.string(), name: z.string().min(1), canOz: positiveNum,
  cansPerCase: positiveNum, isVarietyPack: z.boolean(), upc: z.string().nullable(), store: z.string().nullable(),
  prices: z.array(priceEntry), status: z.enum(['active', 'retired']),
}).partial();

export type ProductInput = {
  id?: string; brand: string; line: string; name: string; canOz: number; cansPerCase: number;
  isVarietyPack?: boolean; upc?: string | null; store?: string | null; casePrice?: number;
};
export type FlavorInput = {
  id?: string; productId?: string; name: string; primaryProtein: string; texture: Texture;
  contains?: string[] | null; ingredientsText?: string | null; cansPerCase?: number; canOz?: number;
  kind: FlavorKind; unit?: 'can' | 'tube' | 'cup';
};

export function normalizeContains(c: string[] | null | undefined): string[] | null {
  if (c === null || c === undefined) return null;
  return [...new Set(c.map(x => x.trim().toLowerCase()).filter(Boolean))];
}

function positive(n: unknown, label: string): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error(`${label} must be greater than 0 (got ${String(n)}).`);
}

function validateProduct(p: Product): void {
  positive(p.canOz, `Product "${p.name}" canOz`);
  positive(p.cansPerCase, `Product "${p.name}" cansPerCase`);
}

function validateFlavor(f: Flavor): void {
  if (!f.productId) throw new Error(`Flavor "${f.name}" is missing productId.`);
  if (!KINDS.includes(f.kind)) throw new Error(`Flavor "${f.name}" kind must be one of ${KINDS.join('|')} (got ${String(f.kind)}).`);
  if (!(TEXTURES as readonly string[]).includes(f.texture)) throw new Error(`Flavor "${f.name}" has unknown texture ${String(f.texture)}.`);
  positive(f.canOz, `Flavor "${f.name}" canOz`);
  positive(f.cansPerCase, `Flavor "${f.name}" cansPerCase`);
}

function flavorLine(f: Flavor) {
  return {
    id: f.id, name: f.name, kind: f.kind, texture: f.texture,
    contains: f.contains === null ? 'ingredients not checked' : f.contains.length ? f.contains : 'none of the tracked ingredients',
  };
}

export async function addFood(
  repo: Repo, input: { product: ProductInput; flavors: FlavorInput[]; confirm: boolean }, now: Date = new Date(),
) {
  const { product: pi, flavors: fis, confirm } = input;
  if (pi.casePrice !== undefined && !(typeof pi.casePrice === 'number' && Number.isFinite(pi.casePrice) && pi.casePrice > 0)) {
    throw new Error(`casePrice must be greater than 0 (got ${String(pi.casePrice)}).`);
  }
  const productId = pi.id ?? await uniqueId(repo.products, pi.name);
  if (pi.id && await repo.products.get(pi.id)) throw new Error(`Product id "${pi.id}" already exists; use update_food.`);
  const product: Product = {
    id: productId, brand: pi.brand, line: pi.line, name: pi.name, canOz: pi.canOz, cansPerCase: pi.cansPerCase,
    isVarietyPack: pi.isVarietyPack ?? false, upc: pi.upc ?? null, store: pi.store ?? null,
    prices: pi.casePrice !== undefined ? [{ casePrice: pi.casePrice, seenOn: localToday(now), source: 'add_food' }] : [],
    status: 'active',
  };
  validateProduct(product);
  const taken = new Set<string>();
  const flavors: Flavor[] = [];
  for (const fi of fis) {
    const id = fi.id ?? await uniqueId(repo.flavors, `${pi.name} ${fi.name}`, taken);
    if (fi.id && (taken.has(id) || await repo.flavors.get(id))) throw new Error(`Flavor id "${id}" already exists.`);
    taken.add(id);
    const f: Flavor = {
      id, productId: fi.productId ?? productId, name: fi.name, primaryProtein: fi.primaryProtein, texture: fi.texture,
      contains: normalizeContains(fi.contains), ingredientsText: fi.ingredientsText ?? null,
      cansPerCase: fi.cansPerCase ?? pi.cansPerCase, canOz: fi.canOz ?? pi.canOz, kind: fi.kind, unit: fi.unit ?? 'can',
    };
    if (f.productId !== productId) throw new Error(`Flavor "${f.name}" productId "${f.productId}" does not match product "${productId}".`);
    validateFlavor(f);
    flavors.push(f);
  }
  const preview = {
    product: {
      id: product.id, name: product.name, canOz: product.canOz, cansPerCase: product.cansPerCase, upc: product.upc,
      casePrice: pi.casePrice ?? null,
    },
    flavors: flavors.map(flavorLine),
  };
  return withConfirm(confirm, preview, async () => {
    await repo.products.put(product);
    for (const f of flavors) await repo.flavors.put(f);
    return preview;
  });
}

export async function updateFood(repo: Repo, input: { id: string; patch: Record<string, unknown>; confirm: boolean }) {
  const { id, confirm } = input;
  if ('id' in input.patch && input.patch.id !== id) throw new Error('Cannot change id.');
  const flavor = await repo.flavors.get(id);
  const product = flavor ? null : await repo.products.get(id);
  if (!flavor && !product) throw new Error(`Food "${id}" not found (neither product nor flavor).`);
  if (flavor) {
    const patch = parsePatch(flavorPatch, FLAVOR_FIELDS, input.patch, 'flavor');
    if (patch.productId !== undefined && !(await repo.products.get(patch.productId))) {
      throw new Error(`Product "${patch.productId}" not found; a flavor can only move to an existing product.`);
    }
    const next = { ...flavor, ...patch } as Flavor;
    validateFlavor(next);
    const preview = { kind: 'flavor' as const, before: flavorLine(flavor), after: flavorLine(next) };
    return withConfirm(confirm, preview, async () => { await repo.flavors.put(next); return preview; });
  }
  const patch = parsePatch(productPatch, PRODUCT_FIELDS, input.patch, 'product');
  const next = { ...product!, ...patch } as Product;
  validateProduct(next);
  const preview = { kind: 'product' as const, before: summarizeProduct(product!), after: summarizeProduct(next) };
  return withConfirm(confirm, preview, async () => { await repo.products.put(next); return preview; });
}

function summarizeProduct(p: Product) {
  return { id: p.id, name: p.name, canOz: p.canOz, cansPerCase: p.cansPerCase, upc: p.upc, status: p.status };
}

export type FoodHit = { productId: string; flavorId: string | null; name: string; score: number };

export async function findFood(repo: Repo, input: { query: string }): Promise<FoodHit[]> {
  const q = input.query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const [products, flavors, aliases] = await Promise.all([repo.products.list(), repo.flavors.list(), repo.aliases.list()]);
  const best = new Map<string, FoodHit>();
  const offer = (h: FoodHit) => {
    const key = `${h.productId}|${h.flavorId ?? ''}`;
    const cur = best.get(key);
    if (!cur || h.score > cur.score) best.set(key, h);
  };
  const prodById = new Map(products.map(p => [p.id, p]));
  const flavById = new Map(flavors.map(f => [f.id, f]));
  const nameScore = (text: string) => {
    const t = text.toLowerCase();
    if (words.every(w => t.includes(w))) return 0.7;
    if (words.some(w => t.includes(w))) return 0.4;
    return 0;
  };
  for (const a of aliases) {
    if (a.text.trim().toLowerCase() !== q) continue;
    const f = a.flavorId ? flavById.get(a.flavorId) : undefined;
    const p = prodById.get(a.productId ?? f?.productId ?? '');
    if (f) offer({ productId: f.productId, flavorId: f.id, name: f.name, score: 1 });
    else if (p) offer({ productId: p.id, flavorId: null, name: p.name, score: 1 });
  }
  for (const p of products) {
    const score = p.upc && p.upc === input.query.trim() ? 1 : nameScore(p.name);
    if (score > 0) offer({ productId: p.id, flavorId: null, name: p.name, score });
  }
  for (const f of flavors) {
    const p = prodById.get(f.productId);
    let score = nameScore(f.name);
    if (p?.upc && p.upc === input.query.trim()) score = 1;
    else score = Math.max(score, p ? Math.min(nameScore(`${p.name} ${f.name}`), 0.7) : 0);
    if (score > 0) offer({ productId: f.productId, flavorId: f.id, name: f.name, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 10);
}

export async function setAlias(repo: Repo, input: { text: string; targetId: string; confirm: boolean }) {
  const text = input.text.trim();
  if (!text) throw new Error('Alias text is empty.');
  const flavor = await repo.flavors.get(input.targetId);
  const product = flavor ? null : await repo.products.get(input.targetId);
  if (!flavor && !product) throw new Error(`Target "${input.targetId}" not found (neither flavor nor product).`);
  const id = `alias-${slugify(text)}`;
  const alias: StoredAlias = {
    id, text, flavorId: flavor ? flavor.id : null, productId: flavor ? flavor.productId : product!.id,
  };
  const existing = await repo.aliases.get(id);
  const preview = {
    alias: text, points_to: flavor ? `flavor ${flavor.name} (${flavor.id})` : `product ${product!.name} (${product!.id})`,
    replaces: existing ? { flavorId: existing.flavorId, productId: existing.productId } : null,
  };
  return withConfirm(input.confirm, preview, async () => { await repo.aliases.put(alias); return preview; });
}

export function register(server: McpServer, repo: Repo): void {
  const flavorShape = {
    id: z.string().optional(), productId: z.string().optional(), name: z.string(), primaryProtein: z.string(),
    texture: z.enum(TEXTURES), contains: z.array(z.string()).nullable().optional(),
    ingredientsText: z.string().nullable().optional(), cansPerCase: z.number().optional(), canOz: z.number().optional(),
    kind: z.enum(['wet', 'topper', 'kibble']), unit: z.enum(['can', 'tube', 'cup']).optional(),
  };
  server.registerTool('find_food', {
    description: 'Search the catalog by nickname (alias), product/flavor name, or UPC. Returns up to 10 candidates {productId, flavorId, name, score}; 1.0 = exact alias or UPC. Ask the owner which one if several score close.',
    inputSchema: { query: z.string() },
  }, jsonTool((i: { query: string }) => findFood(repo, i)));
  server.registerTool('add_food', {
    description: `Add a product and its flavors to the catalog. Each flavor needs kind, texture and contains (ingredient groups, or null if not checked). ${CONFIRM_HINT} Say each flavor's contains and texture aloud.`,
    inputSchema: {
      product: z.object({
        id: z.string().optional(), brand: z.string(), line: z.string(), name: z.string(),
        canOz: z.number(), cansPerCase: z.number(), isVarietyPack: z.boolean().optional(),
        upc: z.string().nullable().optional(), store: z.string().nullable().optional(),
        casePrice: z.number().positive().optional(),
      }),
      flavors: z.array(z.object(flavorShape)),
      confirm: z.boolean(),
    },
  }, jsonTool((i: { product: ProductInput; flavors: FlavorInput[]; confirm: boolean }) => addFood(repo, i)));
  server.registerTool('update_food', {
    description: `Change fields on an existing product or flavor by id (patch is shallow-merged; unknown fields are rejected). ${CONFIRM_HINT}`,
    inputSchema: { id: z.string(), patch: z.record(z.string(), z.unknown()), confirm: z.boolean() },
  }, jsonTool((i: { id: string; patch: Record<string, unknown>; confirm: boolean }) => updateFood(repo, i)));
  server.registerTool('set_alias', {
    description: `Teach a nickname (e.g. "funk") for a flavor or product id, so the owner can say it later. ${CONFIRM_HINT}`,
    inputSchema: { text: z.string(), targetId: z.string(), confirm: z.boolean() },
  }, jsonTool((i: { text: string; targetId: string; confirm: boolean }) => setAlias(repo, i)));
}
