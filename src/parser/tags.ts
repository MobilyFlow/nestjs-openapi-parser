import type { JSDoc, Node } from 'ts-morph';

/** Tag name → values (one entry per `@TagName` occurrence in the node's JSDoc). */
export type TagBag = Record<string, string[]>;

interface JSDocableLike {
  getJsDocs(): JSDoc[];
}

function hasJsDocs(node: Node): node is Node & JSDocableLike {
  return typeof (node as Partial<JSDocableLike>).getJsDocs === 'function';
}

/**
 * Extract all custom JSDoc tags on a node.
 *
 * Only tags at line start (after the JSDoc `* ` prefix) are recognized — inline
 * mentions like `Some text with @Scope inline` are description, not tags.
 * That behavior comes from the TypeScript JSDoc parser; we just consume it.
 *
 * The value is taken from the SAME line as `@TagName`. ts-morph treats lines
 * after a tag as continuation of the tag's body until the next tag, but we
 * want subsequent comment lines to remain plain description — so we read only
 * the first line.
 */
export function getTags(node: Node): TagBag {
  if (!hasJsDocs(node)) return {};
  const bag: TagBag = {};
  for (const jsdoc of node.getJsDocs()) {
    for (const tag of jsdoc.getTags()) {
      const name = tag.getTagName();
      const value = (tag.getCommentText() ?? '').split('\n')[0].trim();
      (bag[name] ??= []).push(value);
    }
  }
  return bag;
}

/**
 * Resolve the `@Scope` tag values on a node into a flat set of scope names.
 * Accepts comma-separated lists with optional whitespace
 * (`@Scope internal,admin`, `@Scope internal, admin`) and multiple occurrences
 * (`@Scope internal` on one line and `@Scope admin` on another).
 */
export function getScopes(bag: TagBag): Set<string> {
  return new Set(
    (bag.Scope ?? []).flatMap((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/**
 * Decide whether an item is visible under the active scopes.
 *
 *  - Untagged items (`itemScopes` empty) are always visible.
 *  - When no scope is active, only untagged items are visible.
 *  - Otherwise, visible iff at least one of the item's scopes is active.
 */
export function isVisible(itemScopes: Set<string>, activeScopes: Set<string>): boolean {
  if (itemScopes.size === 0) return true;
  if (activeScopes.size === 0) return false;
  for (const s of itemScopes) if (activeScopes.has(s)) return true;
  return false;
}

/**
 * Normalize an `--scope a,b --scope c` style CLI input (or a `scopes` config
 * array) into a flat string list — comma-split, trimmed, falsy filtered.
 */
export function parseScopeList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.flatMap((s) =>
    s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  );
}

// Matches an element-style open or close tag: <name> or </name>. The name must
// look like a scope identifier — letters/digits/underscore/hyphen, leading letter.
const FRAGMENT_TAG = /<\/?([A-Za-z][A-Za-z0-9_-]*)>/g;

/**
 * Filter `<scope>…</scope>` fragments inside a JSDoc description.
 *
 *  - Untagged text passes through unchanged.
 *  - `<X>…</X>` keeps its inner text when `X ∈ activeScopes`; otherwise the
 *    whole block (open tag → close tag) is removed.
 *  - The remaining text is normalized: lines that contained only an open/close
 *    tag are dropped (including their newline), runs of 3+ newlines collapse
 *    to 2, and the result is trimmed.
 *  - Nested fragments, mismatched close tags, and unclosed open tags throw.
 *
 * The optional `ctx.itemPath` (e.g. `"User.email"`) is included in the error
 * message so misconfigured comments are easy to locate.
 */
export function filterScopedComments(
  text: string,
  activeScopes: Set<string>,
  ctx: { itemPath?: string } = {},
): string {
  const where = ctx.itemPath ? ` at ${ctx.itemPath}` : '';

  let currentScope: string | undefined;
  let keep = true;
  let out = '';
  let cursor = 0;

  FRAGMENT_TAG.lastIndex = 0;
  for (let m = FRAGMENT_TAG.exec(text); m !== null; m = FRAGMENT_TAG.exec(text)) {
    const before = text.slice(cursor, m.index);
    if (keep) out += before;
    cursor = m.index + m[0].length;

    const name = m[1];
    const isClose = m[0].startsWith('</');

    if (!isClose) {
      if (currentScope !== undefined) {
        throw new Error(
          `Nested scope fragments are not allowed${where}: <${name}> inside <${currentScope}>.`,
        );
      }
      currentScope = name;
      keep = activeScopes.has(name);
    } else {
      if (currentScope === undefined) {
        throw new Error(`Unmatched closing scope tag </${name}>${where}.`);
      }
      if (currentScope !== name) {
        throw new Error(`Mismatched scope tag </${name}>${where} (expected </${currentScope}>).`);
      }
      currentScope = undefined;
      keep = true;
    }
  }
  if (currentScope !== undefined) {
    throw new Error(`Unclosed scope fragment <${currentScope}>${where}.`);
  }

  if (keep) out += text.slice(cursor);

  return normalizeFiltered(out);
}

function normalizeFiltered(text: string): string {
  // Drop lines whose remaining content is only whitespace AND that came from a
  // removed tag — heuristic: any line that, after trim, is empty stays as a
  // blank line, but we then collapse runs.
  const noBlankLineRuns = text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return noBlankLineRuns.trim();
}
