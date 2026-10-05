import type { CustomTag, CustomTagAttributeTag } from "./custom-tags.ts";
import type { DefaultTagParent } from "./declarations.ts";
import {
  type DefaultTagScope,
  validateDefaultTag,
} from "./default-tag-validate.ts";
import type { TargetPolicyDiagnostic } from "./host-policy.ts";

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

/** What `contractDefaultTagDiagnostics` reads from a package's scan. */
export interface ContractDefaultTagInput {
  /** The scan's tags: where each declaration is written (a contracts module or a sidecar). */
  tags: ReadonlyMap<string, { module?: string; sidecar?: string }>;
  customTags: Readonly<Record<string, CustomTag>>;
  /** The scope the target checks a default tag in (custom tags known). */
  scope: DefaultTagScope;
  /** The target's host, when it has one: a host may forbid the rung. */
  host?: { name: string; allowContractDefaultTag?: boolean };
}

/**
 * Registration check for every `defaultTag` the package's contracts declare,
 * top level and on attribute-tag declarations at any depth: one
 * `invalid-default-tag` diagnostic per declaration, at the file that writes it
 * (the contracts module or the sidecar). A host that forbids per-tag default
 * tags (`allowContractDefaultTag: false`) refuses each declaration, naming the
 * host; otherwise the value goes through the shared `validateDefaultTag`.
 * A tag whose sidecar fails to load is skipped: the scan reports that error.
 */
export function contractDefaultTagDiagnostics(
  input: ContractDefaultTagInput,
): TargetPolicyDiagnostic[] {
  const out: TargetPolicyDiagnostic[] = [];
  const forbidden = input.host?.allowContractDefaultTag === false;
  for (const [name, found] of input.tags) {
    const file = found.module ?? found.sidecar;
    const tag = Object.hasOwn(input.customTags, name)
      ? input.customTags[name]
      : undefined;
    if (!file || !tag) continue;
    try {
      const declared: Array<{ chain: string[]; value: string }> = [];
      const collect = (
        declaration: CustomTag | CustomTagAttributeTag,
        chain: string[],
      ): void => {
        const value = declaration.defaultTag;
        if (typeof value === "string" && value !== "")
          declared.push({ chain, value });
        for (const [attrName, nested] of Object.entries(
          declaration.attributeTags ?? {},
        ))
          collect(nested, [...chain, attrName]);
      };
      collect(tag, []);
      for (const { chain, value } of declared) {
        const owner = `\`<${name}>\`${chain.map((c) => ` \`<@${c}>\``).join("")}`;
        const reason = forbidden
          ? `\`defaultTag\` in the contract of ${owner} is not allowed: host \`${input.host?.name}\` does not permit per-tag default tags`
          : validateDefaultTag(value, input.scope);
        if (reason === undefined) continue;
        out.push({
          code: "invalid-default-tag",
          severity: "error",
          file,
          message: forbidden
            ? reason
            : `invalid \`defaultTag\` value: ${reason} (contract of ${owner})`,
          line: 1,
          column: 0,
          length: 1,
        });
      }
    } catch {
      // The sidecar's own registration error is the scan's to report.
    }
  }
  return out;
}
