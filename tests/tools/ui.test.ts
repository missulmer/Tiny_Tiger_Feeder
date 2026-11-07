import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import { getUiKit, register } from '../../src/tools/ui.js';
import { register as registerPlan } from '../../src/tools/plan.js';
import { register as registerHistory } from '../../src/tools/history.js';

describe('get_ui_kit', () => {
  it('css contains custom properties and a Wanda/License header', async () => {
    const kit = await getUiKit();
    expect(kit.css).toContain('--');
    const header = kit.css.slice(0, kit.css.indexOf('*/'));
    expect(header).toContain('Wanda');
    expect(header).toContain('License');
    expect(kit.css).toContain('prefers-color-scheme: dark');
    expect(kit.css).toContain('[data-theme="dark"]');
    expect(kit.guidance.length).toBeLessThanOrEqual(600);
    expect(kit.updateSheetTemplate).toContain('{{');
  });

  it('update-sheet template uses no hex colors outside the token file', async () => {
    const { updateSheetTemplate: t } = await getUiKit();
    expect(t).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(t).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(t).toContain('var(--');
  });

  it('every var(--x) in the template is defined in the token css', async () => {
    const { css, updateSheetTemplate: t } = await getUiKit();
    const used = new Set([...t.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]!));
    const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(m => m[1]!));
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter(v => !defined.has(v))).toEqual([]);
  });

  it('registers the tools over MCP', async () => {
    const repo = createMemoryRepo();
    const server = new McpServer({ name: 't', version: '0' });
    for (const r of [register, registerPlan, registerHistory]) r(server, repo);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      ['cat_history', 'explain_line', 'export_all', 'food_history', 'get_ui_kit', 'plan_order']);
    for (const t of tools) expect((t.description ?? '').length).toBeLessThan(400);
  });
});
