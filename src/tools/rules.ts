import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import type { HouseholdRule } from '../domain/types.js';
import { CONFIRM_HINT, jsonTool, uniqueId, withConfirm } from './preview.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type RuleInput = { id?: string; kind: 'exclude-ingredient'; value: string; startsOn: string; endsOn?: string | null };

export async function setHouseholdRule(repo: Repo, input: { rule: RuleInput; confirm: boolean }) {
  const r = input.rule;
  if (r.kind !== 'exclude-ingredient') throw new Error(`Unsupported rule kind "${String(r.kind)}"; only exclude-ingredient.`);
  const value = r.value.trim().toLowerCase();
  if (!value) throw new Error('Rule value is empty.');
  if (!DATE.test(r.startsOn)) throw new Error('startsOn must be YYYY-MM-DD.');
  const endsOn = r.endsOn ?? null;
  if (endsOn !== null) {
    if (!DATE.test(endsOn)) throw new Error('endsOn must be YYYY-MM-DD.');
    if (endsOn < r.startsOn) throw new Error('endsOn must not be before startsOn.');
  }
  const existing = r.id ? await repo.rules.get(r.id) : null;
  const rule: HouseholdRule = {
    id: r.id ?? await uniqueId(repo.rules, `no-${value}`), kind: r.kind, value,
    startsOn: r.startsOn, endsOn, outcome: existing?.outcome ?? null,
  };
  const preview = {
    rule: `No ${value} for any cat from ${rule.startsOn} ${endsOn ? `until ${endsOn}` : 'with no end date'}`,
    id: rule.id, replacing: existing !== null,
  };
  return withConfirm(input.confirm, preview, async () => { await repo.rules.put(rule); return preview; });
}

export function register(server: McpServer, repo: Repo): void {
  server.registerTool('set_household_rule', {
    description: `Add or replace a household rule. Only kind "exclude-ingredient" (e.g. value "fish") with startsOn YYYY-MM-DD and optional endsOn. Pass id to edit an existing rule. ${CONFIRM_HINT}`,
    inputSchema: {
      rule: z.object({
        id: z.string().optional(), kind: z.literal('exclude-ingredient'), value: z.string(),
        startsOn: z.string(), endsOn: z.string().nullable().optional(),
      }),
      confirm: z.boolean(),
    },
  }, jsonTool((i: { rule: RuleInput; confirm: boolean }) => setHouseholdRule(repo, i)));
}
