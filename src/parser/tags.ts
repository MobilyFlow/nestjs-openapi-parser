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
