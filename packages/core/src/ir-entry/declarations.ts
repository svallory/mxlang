/**
 * The `HostDeclarations` the IR entry point (`lowerSource`) lowers under
 * (decision 204): delegate everything, so every non-structural tag arrives in
 * the IR as a `DelegatedTag` and the checks (`checks.ts`) read it.
 *
 * What the declarations intercept *before* delegation:
 *
 * - **Reserved names.** `declarations.tags` dispositions run before core's
 *   structural switch and before core's built-in `<try>`, so `else`,
 *   `else-if` and `try` fail here with the reserved-name message. (`else`/
 *   `else-if` in a real `<if>` chain never reach this table: the chain walk
 *   consumes them directly.) The other reserved names — `if`, `for`,
 *   `const`, `import`, `export`, `static` — are always lowered as the
 *   structural construct, so they pass through as structural nodes or fail
 *   under `structural: "reject"`; they can never be tag names at all.
 * - **`<define>` / `<return>`** are rejected here, positioned at the tag,
 *   because a static tree can neither expand a macro nor return a value.
 * - **Dynamic tags** (`<${expr}>`, and a bare `${expr}` line, which parses as
 *   one) are *not* claimed (`DYNAMIC_TAG` excluded), so core lowers them to a
 *   dynamic `Component` and `checks.ts` rejects them: a static tree needs a
 *   name.
 * - **Component calls** (a capitalized import call, a template-bearing
 *   `customTags` entry) are refused through `rejectComponentTag` where core
 *   offers it and rejected in `checks.ts` for the paths that bypass that hook.
 * - **Attribute methods** (`change(ctx) { … }`, the method shorthand) are
 *   accepted: `resolveAttributeMethod: () => true`.
 *
 * Moved from `@mxlang/data` with every message unchanged, "data tag" and
 * "data file" wording included.
 */

import { contractDefaultTag } from "../contract-default-tag.ts";
import { codedError, DYNAMIC_TAG } from "../core.ts";
import type { HostDeclarations } from "../declarations.ts";
import { NOT_IN_DATA_FILE_CODE } from "../diagnostic-codes.ts";
import { reservedNameMessage } from "../tag-names.ts";
import type { NativeTags } from "../tag-table.ts";

/** The names no tag may use under the entry point (decision 131 addendum, item 2). */
export { RESERVED_NAMES, reservedNameMessage } from "../tag-names.ts";

/**
 * The entry point's built-in tag: the anonymous node (decision 145,
 * addendum 2). The unnamed tag (`<#id>`, `<.class>`) is this tag unless a
 * `defaultTag` says otherwise. It is always known, has no contract of its own
 * and carries the shorthand's `id`/`class` as ordinary attributes.
 */
export const DEFAULT_TAG = "object";

/** The names provided without a tag-table entry: what `builtinTags` declares. */
const BUILTIN_TAGS: readonly string[] = [DEFAULT_TAG];

const byNatives = new WeakMap<NativeTags, HostDeclarations>();

/**
 * The declarations over `nativeTags`, the tag rules preset's native elements
 * (empty under `none`). Cached per native set, so the tag table core builds
 * from them is reused across calls.
 */
export function entryDeclarations(nativeTags: NativeTags): HostDeclarations {
  let declarations = byNatives.get(nativeTags);
  if (!declarations) {
    declarations = {
      // Read by two core messages ("not supported by tree yet", "on tree a
      // matched child needs `contract:`"); kept as `@mxlang/data` named it.
      name: "tree",
      nativeTags,
      attrTags: 2,
      builtinTags: BUILTIN_TAGS,
      // The ladder (decision 145): the parent's contract `defaultTag`, then
      // the caller's `defaultTag`, then the built-in `object`.
      resolveDefaultTag: (_node, parents, context) =>
        contractDefaultTag(parents, context, BUILTIN_TAGS) ??
        context.configured ??
        DEFAULT_TAG,
      tags: {
        else: {
          kind: "error",
          reason: reservedNameMessage("else"),
          code: NOT_IN_DATA_FILE_CODE,
        },
        "else-if": {
          kind: "error",
          reason: reservedNameMessage("else-if"),
          code: NOT_IN_DATA_FILE_CODE,
        },
        try: {
          kind: "error",
          reason: reservedNameMessage("try"),
          code: NOT_IN_DATA_FILE_CODE,
        },
        define: {
          kind: "error",
          code: NOT_IN_DATA_FILE_CODE,
          reason:
            "`<define>` is a render-time macro: the data tree is static and cannot expand it; inline the content at each use",
        },
        return: {
          kind: "error",
          code: NOT_IN_DATA_FILE_CODE,
          reason:
            "`<return>` needs the evaluated mode: the data tree is static and has no value to return",
        },
      },
      isElement: () => false,
      isComponent: () => false,
      isDelegatedTag: (name) => name !== DYNAMIC_TAG,
      resolveDelegatedTag: () => undefined,
      resolveAttributeMethod: () => true,
      rejectComponentTag: (name, node) => {
        const loc = node?.loc?.start ?? { line: 0, column: 0 };
        throw codedError(
          NOT_IN_DATA_FILE_CODE,
          `\`<${name}>\` calls a template tag; a data file cannot call a template tag`,
          loc.line ?? 0,
          loc.column ?? 0,
        );
      },
    };
    byNatives.set(nativeTags, declarations);
  }
  return declarations;
}

/** The built-in tag names, for the `unknownTags: "reject"` check. */
export function builtinTagNames(): readonly string[] {
  return BUILTIN_TAGS;
}
