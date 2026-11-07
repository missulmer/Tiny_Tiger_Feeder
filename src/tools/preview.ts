import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Collection } from '../store/repo.js';

/**
 * Two-step write: confirm=false returns the preview and writes nothing;
 * confirm=true runs `commit` and returns its (final) preview.
 */
export async function withConfirm<T>(
  confirm: boolean, preview: T, commit: () => Promise<T>,
): Promise<{ saved: boolean; preview: T }> {
  if (!confirm) return { saved: false, preview };
  return { saved: true, preview: await commit() };
}

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'item';
}

/** Slug of `name`, suffixed -2, -3... until it collides with nothing in `coll` or `taken`. */
export async function uniqueId(
  coll: Collection<{ id: string }>, name: string, taken: Set<string> = new Set(),
): Promise<string> {
  const base = slugify(name);
  let id = base;
  for (let n = 2; taken.has(id) || (await coll.get(id)) !== null; n++) id = `${base}-${n}`;
  return id;
}

export const CONFIRM_HINT =
  'Call with confirm:false first, read the preview back to the owner in plain words, and call again with confirm:true only after she agrees.';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Wrap a plain handler for registerTool: JSON result as text; thrown errors become isError results. */
export function jsonTool<I>(handler: (input: I) => Promise<unknown>): (input: I) => Promise<ToolResult> {
  return async (input: I) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await handler(input), null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  };
}

export type { McpServer };
