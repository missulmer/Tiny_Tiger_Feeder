import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryRepo } from '../../src/store/memoryRepo.js';
import { register as catalog } from '../../src/tools/catalog.js';
import { register as cats } from '../../src/tools/cats.js';
import { register as rules } from '../../src/tools/rules.js';

describe('register', () => {
  it('exposes tools over MCP with short descriptions and JSON results', async () => {
    const repo = createMemoryRepo();
    const server = new McpServer({ name: 't', version: '0' });
    for (const r of [catalog, cats, rules]) r(server, repo);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      ['add_food', 'find_food', 'set_alias', 'set_household_rule', 'update_cat', 'update_food']);
    for (const t of tools) expect((t.description ?? '').length).toBeLessThan(400);
    const res = await client.callTool({ name: 'update_cat', arguments: { id: 'tiger', patch: { name: 'Tiger' }, confirm: false } });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text).saved).toBe(false);
    const bad = await client.callTool({ name: 'update_cat', arguments: { id: 'tiger', patch: { bogus: 1 }, confirm: true } });
    expect(bad.isError).toBe(true);
  });
});
