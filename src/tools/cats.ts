import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import { TEXTURES } from '../domain/types.js';
import type { Cat } from '../domain/types.js';
import { CONFIRM_HINT, jsonTool, parsePatch, withConfirm } from './preview.js';
import { DATE_RE } from './time.js';

const PATCHABLE = [
  'name', 'age', 'breed', 'weight', 'allergies', 'textureRules', 'noMixDryIntoWet', 'sideSwingsWet',
  'fixedPortionOz', 'eatsAnythingWeight', 'dailyOz', 'proteinPrefs', 'usualPlate',
] as const;

// Numbers are finite (zod 4 rejects NaN and Infinity) and >= 0; dailyOz > 0; eatsAnythingWeight in [0, 1].
const amount = z.number().nonnegative();
const item = z.object({ flavorId: z.string().min(1), amountOz: amount }).strict();
const lower = (s: string) => s.trim().toLowerCase();
const catPatch = z.object({
  name: z.string().min(1),
  age: amount.nullable(),
  breed: z.string().nullable(),
  weight: amount.nullable(),
  allergies: z.array(z.object({
    substance: z.string().min(1).transform(lower),
    status: z.enum(['suspected', 'trial', 'confirmed', 'cleared']),
    until: z.string().regex(DATE_RE, 'must be YYYY-MM-DD').nullable(),
  }).strict()),
  textureRules: z.object({ allowed: z.array(z.enum(TEXTURES)), blocked: z.array(z.enum(TEXTURES)) }).strict(),
  noMixDryIntoWet: z.boolean(),
  sideSwingsWet: z.boolean(),
  fixedPortionOz: amount.nullable(),
  eatsAnythingWeight: z.number().min(0).max(1),
  dailyOz: z.number().positive(),
  proteinPrefs: z.array(z.string().min(1).transform(lower)),
  usualPlate: z.object({
    items: z.array(item), toppers: z.array(item),
    side: z.object({ flavorId: z.string().min(1), amount }).strict().nullable(),
  }).strict().nullable(),
}).partial();

export function catDefaults(id: string): Cat {
  return {
    id, name: id, age: null, breed: null, weight: null, allergies: [],
    textureRules: { allowed: [], blocked: [] }, noMixDryIntoWet: false, sideSwingsWet: false,
    fixedPortionOz: null, eatsAnythingWeight: 1, dailyOz: 6.5, proteinPrefs: [], usualPlate: null,
  };
}

export async function updateCat(repo: Repo, input: { id: string; patch: Record<string, unknown>; confirm: boolean }) {
  const { id, confirm } = input;
  const patch = parsePatch(catPatch, PATCHABLE, input.patch, 'cat');
  const existing = await repo.cats.get(id);
  const next = { ...(existing ?? catDefaults(id)), ...patch, id } as Cat;
  const preview = { creating: existing === null, cat: next, changedFields: Object.keys(patch) };
  return withConfirm(confirm, preview, async () => { await repo.cats.put(next); return preview; });
}

export function register(server: McpServer, repo: Repo): void {
  server.registerTool('update_cat', {
    description: `Create a cat (new id, defaults filled) or update fields on an existing one (shallow merge): dailyOz, textureRules, allergies, proteinPrefs, sideSwingsWet, noMixDryIntoWet, fixedPortionOz, etc. ${CONFIRM_HINT}`,
    inputSchema: { id: z.string(), patch: z.record(z.string(), z.unknown()), confirm: z.boolean() },
  }, jsonTool((i: { id: string; patch: Record<string, unknown>; confirm: boolean }) => updateCat(repo, i)));
}
