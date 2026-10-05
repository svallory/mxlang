/**
 * Which authored tags a parent's `children["*"]` claims (decision 147).
 *
 * Runs inside `resolveUnnamedTags`'s top-down walk over the Marko tree, so a
 * child's match is known before anything under it is read: an unnamed tag
 * inside `<title>` (as `attribute`) resolves through `attribute`'s
 * `defaultTag`, and a grandchild matches against the matched contract's own
 * `children["*"]`. Nothing is rewritten in the tree: the match is recorded
 * per node, and the lowerer reads it.
 */

import { BUILTIN_CUSTOM_TAGS } from "./builtin-tags.ts";
import type { Ctx, Node } from "./core.ts";
import { CORE_TAGLIB_ID } from "./core-taglib.ts";
import type {
  CustomTag,
  CustomTagAttributeTag,
  WildcardChildEntry,
} from "./custom-tags.ts";
import { CONTROL_FLOW_TAGS } from "./structural-tags.ts";
import {
  explicitChildEntries,
  hasExplicitChild,
  matchWildcardEntry,
  tagLabel,
  wildcardEntries,
} from "./wildcard-children.ts";

/** A contract in force at some point of the walk, with its owner's message label. */
export interface ContractScope {
  declaration: CustomTag | CustomTagAttributeTag;
  label: string;
}

/** What a parent's `"*"` entry decided for one authored tag. */
export interface WildcardMatch {
  /** The tag the child is checked as: the referenced tag, or the authored name for an inline contract. */
  canonical: string;
  /** The name as written. */
  authored: string;
  /** The contract the child is validated against. */
  definition: CustomTag;
  /** The entry pattern's named capture groups. */
  groups: Record<string, string>;
  /** The matching parent's label and its explicit child names, for the did-you-mean guard. */
  parent: { label: string; explicit: readonly string[] };
}

/**
 * The names core itself consumes, which no wildcard entry may claim. "Unknown"
 * is target-neutral (decision 147): no core structural name, no core-owned
 * custom tag, no `customTags` entry. A host's own claims and native elements
 * are not consulted, which is why a wildcard can only fire inside a contract
 * parent.
 */
const CORE_NAMES = new Set([
  ...CONTROL_FLOW_TAGS,
  "const",
  "define",
  "return",
  "import",
  "export",
  "static",
]);

/** What eligibility reads of a compile: the registered tags and the target's taglib lookup. */
export type WildcardContext = Pick<Ctx, "customTags" | "lookup">;

/**
 * Whether the target's own taglib lookup holds `name` as a built-in: a tag
 * that is not an element of the target, or one of core's own tags (`script`
 * and `style` are core entries even though they render as elements). A native
 * element (`title`, `div`) is not a built-in, so a contract can claim it;
 * a target whose lookup omits a host-owned name (data's `let`) leaves it
 * ordinary. The answer is the lookup's, never a list kept here.
 */
function isBuiltin(name: string, ctx: WildcardContext): boolean {
  const def = ctx.lookup?.getTag(name) as
    | { html?: unknown; taglibId?: unknown }
    | undefined;
  return (
    def !== undefined && (def.html !== true || def.taglibId === CORE_TAGLIB_ID)
  );
}

/**
 * Whether no rung of the target resolves `name`, so a parent's `"*"` may claim
 * it (decision 147, target-neutral): not a core structural name, not a
 * core-owned or registered custom tag, not a built-in of the target. A native
 * element is eligible: inside a contract parent the contract decides, and the
 * host's native-element fallback applies only outside one.
 */
export function isWildcardEligible(
  name: string,
  ctx: WildcardContext,
): boolean {
  return !(
    name === "" ||
    name.startsWith("@") ||
    CORE_NAMES.has(name) ||
    Object.hasOwn(BUILTIN_CUSTOM_TAGS, name) ||
    (ctx.customTags !== undefined && Object.hasOwn(ctx.customTags, name)) ||
    isBuiltin(name, ctx)
  );
}

const matches = new WeakMap<Node, WildcardMatch>();

/** The match recorded for this tag node, if a parent's `"*"` claimed it. */
export function wildcardMatchOf(node: Node): WildcardMatch | undefined {
  return node ? matches.get(node) : undefined;
}

/** The contract an entry validates its child with, when it can be reached. */
function entryDefinition(
  entry: WildcardChildEntry,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): CustomTag | undefined {
  if (entry.contract === undefined) return entry as CustomTag;
  return customTags && Object.hasOwn(customTags, entry.contract)
    ? customTags[entry.contract]
    : undefined;
}

/**
 * Matches one authored tag against the contract in force at its position and
 * records the result; a tag matched once keeps its match (the walk can run
 * more than once over one tree).
 */
export function matchWildcardChild(
  node: Node,
  name: string,
  scope: ContractScope | undefined,
  ctx: WildcardContext,
): WildcardMatch | undefined {
  const customTags = ctx.customTags;
  const known = matches.get(node);
  if (known) return known;
  const children = scope?.declaration.children;
  if (!scope || !children || wildcardEntries(children).length === 0) return;
  if (hasExplicitChild(children, name)) return;
  if (!isWildcardEligible(name, ctx)) return;
  const found = matchWildcardEntry(children, name);
  if (!found) return;
  const definition = entryDefinition(found.entry, customTags);
  if (!definition) return;
  const match: WildcardMatch = {
    canonical: found.entry.contract ?? name,
    authored: name,
    definition,
    groups: found.groups,
    parent: {
      label: scope.label,
      explicit: explicitChildEntries(children)
        .map(([child]) => child)
        .filter((child) => child !== "#text"),
    },
  };
  matches.set(node, match);
  return match;
}

/**
 * The contract in force for a tag's own children and attribute tags. Control
 * flow passes its parent's through, as E2 sees through it; an attribute tag
 * reads its declaration in the owner's `attributeTags`; a matched wildcard
 * child, a core-owned custom tag and a registered tag bring their own.
 */
export function scopeForChildren(
  node: Node,
  name: string,
  scope: ContractScope | undefined,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): ContractScope | undefined {
  if (CONTROL_FLOW_TAGS.includes(name)) return scope;
  if (name.startsWith("@")) {
    const tags = scope?.declaration.attributeTags;
    const attrName = name.slice(1);
    const declaration =
      tags && Object.hasOwn(tags, attrName) ? tags[attrName] : undefined;
    return declaration && scope
      ? { declaration, label: `${scope.label}: \`<${name}>\`` }
      : undefined;
  }
  const match = matches.get(node);
  if (match) {
    return {
      declaration: match.definition,
      label: tagLabel(match.canonical, match),
    };
  }
  const declaration = Object.hasOwn(BUILTIN_CUSTOM_TAGS, name)
    ? BUILTIN_CUSTOM_TAGS[name]
    : customTags && Object.hasOwn(customTags, name)
      ? customTags[name]
      : undefined;
  return declaration ? { declaration, label: `\`<${name}>\`` } : undefined;
}
