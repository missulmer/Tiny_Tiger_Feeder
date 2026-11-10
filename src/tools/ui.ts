import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Repo } from '../store/repo.js';
import { jsonTool } from './preview.js';

// Resolve relative to this module: src/tools/ -> <root>/ui, and dist/src/tools/ -> <root>/ui (one level deeper).
async function uiFile(name: string): Promise<string> {
  for (const rel of ['../../ui/', '../../../ui/', '../../../../ui/']) {
    try { return await readFile(fileURLToPath(new URL(rel + name, import.meta.url)), 'utf8'); } catch { /* try next */ }
  }
  throw new Error(`UI kit file not found: ui/${name}`);
}

export const GUIDANCE =
  'Style every visual with this CSS only: inline it in a <style> block and use its var(--…) tokens; never add your own colors, fonts or sizes. ' +
  'For the update sheet, fill the template: repeat the row per product, replace each {{placeholder}}, drop the warnings list when empty. ' +
  'For charts, take colors from the Wanda --color-* tokens (hsl(var(--color-blue-50))) and text/surfaces from --wanda-*. Light and dark are automatic.';

export async function getUiKit() {
  const [css, updateSheetTemplate] = await Promise.all([uiFile('wanda-tokens.css'), uiFile('update-sheet.html')]);
  return { css, updateSheetTemplate, guidance: GUIDANCE };
}

export function register(server: McpServer, _repo: Repo): void {
  server.registerTool('get_ui_kit', {
    description: 'Wanda design-token CSS, the update-sheet HTML template and styling guidance. Call before drawing any visual or update sheet.',
    inputSchema: {},
  }, jsonTool(() => getUiKit()));
}
