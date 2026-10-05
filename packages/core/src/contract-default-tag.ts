import type { CustomTag, CustomTagAttributeTag } from "./custom-tags.ts";
import type { DefaultTagParent } from "./declarations.ts";

/**
 * Whether a parent is structure rather than an authored tag: control flow
 * (`if`, `for`), `try`, `await` and the like. Decided from Marko's own tag
 * def on the node, never from a name: a tag Marko's lookup knows that is not
 * an element (it lacks the taglib's `html` flag, read from `parent.tagDef`) and that no custom tag
 * registered under its name is a core or translator tag, and has no contract
 * a child could read. A dynamic name has no def and counts as authored.
 */
function isStructural(
  parent: DefaultTagParent,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): boolean {
  if (parent.attributeTag) return false;
  if (customTags && Object.hasOwn(customTags, parent.name)) return false;
  const def = parent.tagDef as { html?: unknown } | undefined;
  return def !== undefined && def.html !== true;
}

/**
 * The `defaultTag` a parent's contract declares for the unnamed tag whose
 * ancestors are `parents` (nearest first), or `undefined` when the nearest
 * authored parent declares none. The parent is the nearest *authored tag*,
 * with structural parents skipped; an unnamed tag inside an attribute tag
 * (`<x><@y><.z/></@y></x>`) reads `@y`'s declaration in `x`'s
 * `attributeTags`, at any depth. A parent with no declared default does not
 * pass the question up: its answer is "none".
 *
 * Ordering of the ladder stays in the targets; this is only the lookup.
 */
export function contractDefaultTag(
  parents: readonly DefaultTagParent[],
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): string | undefined {
  let i = 0;
  while (i < parents.length) {
    const parent = parents[i] as DefaultTagParent;
    if (isStructural(parent, customTags)) {
      i++;
      continue;
    }
    if (!parent.attributeTag) {
      return customTags && Object.hasOwn(customTags, parent.name)
        ? stringOrUndefined(customTags[parent.name]?.defaultTag)
        : undefined;
    }
    // An attribute tag: gather the chain of attribute tags (innermost first),
    // then the owner, skipping structure between them.
    const chain: string[] = [];
    while (i < parents.length) {
      const entry = parents[i] as DefaultTagParent;
      if (entry.attributeTag) {
        chain.push(entry.name.replace(/^@/, ""));
        i++;
      } else if (isStructural(entry, customTags)) {
        // `try`/`await` own attribute tags of their own (`@catch`): the whole
        // chain belongs to structure, so it is skipped with its owner.
        if (chain.length > 0 && ownsChainStructurally(parents, i)) {
          chain.length = 0;
        }
        i++;
        if (chain.length === 0) break;
      } else break;
    }
    if (chain.length === 0) continue;
    const owner = parents[i];
    if (!owner || owner.attributeTag) return undefined;
    let declaration: CustomTagAttributeTag | CustomTag | undefined =
      customTags && Object.hasOwn(customTags, owner.name)
        ? customTags[owner.name]
        : undefined;
    for (const name of chain.reverse()) {
      const tags: Record<string, CustomTagAttributeTag> | undefined =
        declaration?.attributeTags;
      declaration = tags && Object.hasOwn(tags, name) ? tags[name] : undefined;
    }
    return stringOrUndefined(declaration?.defaultTag);
  }
  return undefined;
}

/** Whether the structural parent at `index` is the owner of the attribute-tag chain just gathered. */
function ownsChainStructurally(
  parents: readonly DefaultTagParent[],
  index: number,
): boolean {
  return parents[index] !== undefined && !parents[index]?.attributeTag;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
