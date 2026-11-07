import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import type { Cat } from '../domain/types.js';
import { CONFIRM_HINT, jsonTool, withConfirm } from './preview.js';

const PATCHABLE = new Set([
  'name', 'age', 'breed', 'weight', 'allergies', 'textureRules', 'noMixDryIntoWet', 'sideSwingsWet',
  'fixedPortionOz', 'eatsAnythingWeight', 'dailyOz', 'proteinPrefs', 'usualPlate',
]);

export function catDefaults(id: string): Cat {
  return {
    id, name: id, age: null, breed: null, weight: null, allergies: [],
    textureRules: { allowed: [], blocked: [] }, noMixDryIntoWet: false, sideSwingsWet: false,
    fixedPortionOz: null, eatsAnythingWeight: 1, dailyOz: 6.5, proteinPrefs: [], usualPlate: null,
  };
}

export async function updateCat(repo: Repo, input: { id: string; patch: Record<string, unknown>; confirm: boolean }) {
  const { id, patch, confirm } = input;
  for (const k of Object.keys(patch)) {
    if (!PATCHABLE.has(k)) throw new Error(`Unknown or read-only cat field "${k}". Allowed: ${[...PATCHABLE].join(', ')}.`);
  }
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
