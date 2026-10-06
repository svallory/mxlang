/**
 * The data target's `HostDeclarations` (decision 132): delegate everything,
 * so every non-structural tag arrives in the IR as a `DelegatedTag` and the
 * tree builder (`build.ts`) projects it.
 *
 * What the declarations intercept *before* delegation:
 *
 * - **Reserved names.** `declarations.tags` dispositions run before core's
 *   structural switch and before core's built-in `<try>`, so `else`,
 *   `else-if` and `try` fail here with the reserved-name message. (`else`/
 *   `else-if` in a real `<if>` chain never reach this table: the chain walk
 *   consumes them directly.) The other reserved names — `if`, `for`,
 *   `const`, `import`, `export`, `static` — are always parsed as the
 *   structural construct, so they pass through as structural nodes or fail
 *   under `structural: "reject"`; they can never be data tag names at all.
 * - **`<define>` / `<return>`** are rejected here, positioned at the tag,
 *   because a static tree can neither expand a macro nor return a value.
 * - **Dynamic tags** (`<${expr}>`, and a bare `${expr}` line, which Marko
 *   parses as one) are *not* claimed (`DYNAMIC_TAG` excluded), so core
 *   lowers them to a dynamic `Component` and `build.ts` rejects them: a
 *   static tree needs a name.
 * - **Component calls** (a capitalized import call, a template-bearing
 *   `customTags` entry) are refused through `rejectComponentTag` where core offers it and
 *   rejected in `build.ts` for the paths that bypass that hook.
 * - **Attribute methods** (`change(ctx) { … }`, the method shorthand the Ash
 *   fixture uses) are accepted: `resolveAttributeMethod: () => true`.
 */

import {
  contractDefaultTag,
  DYNAMIC_TAG,
  type HostDeclarations,
  TranslateError,
} from "@mxlang/core";

/** The names no data tag may use (the 131 addendum's item 2). */
export const RESERVED_NAMES = [
  "if",
  "else",
  "else-if",
  "for",
  "const",
  "define",
  "return",
  "import",
  "export",
  "static",
  "try",
] as const;

/** The reserved-name message, for a name used as a data tag. */
export function reservedNameMessage(name: string): string {
  return `\`<${name}>\` cannot name a data tag: it is reserved — core consumes the structural names (\`if\`, \`else\`, \`else-if\`, \`for\`, \`const\`, \`define\`, \`return\`, \`import\`, \`export\`, \`static\`) and \`<try>\` before a target sees them`;
}

/**
 * The data target's built-in tag: the anonymous node (decision 145,
 * addendum 2). The unnamed tag (`<#id>`, `<.class>`) is this tag unless a
 * `defaultTag` says otherwise. It is always known, has no contract of its own
 * and carries the shorthand's `id`/`class` as ordinary attributes.
 */
export const DEFAULT_TAG = "object";

/** The names the target provides without a taglib entry: what `builtinTags` declares. */
const BUILTIN_TAGS: readonly string[] = [DEFAULT_TAG];

export const dataDeclarations: HostDeclarations = {
  name: "data",
  attrTags: 2,
  builtinTags: BUILTIN_TAGS,
  // The ladder (decision 145): the parent's contract `defaultTag`, then
  // `mx.<target>.defaultTag`, then the target's built-in (the registry folds
  // the host override into `configured`). This host permits the contract rung:
  // it sets no `allowContractDefaultTag: false`.
  resolveDefaultTag: (_node, parents, context) =>
    contractDefaultTag(parents, context, BUILTIN_TAGS) ??
    context.configured ??
    // The target's default tag, which is also its one built-in.
    DEFAULT_TAG,
  tags: {
    else: { kind: "error", reason: reservedNameMessage("else") },
    "else-if": { kind: "error", reason: reservedNameMessage("else-if") },
    try: { kind: "error", reason: reservedNameMessage("try") },
    define: {
      kind: "error",
      reason:
        "`<define>` is a render-time macro: the data tree is static and cannot expand it; inline the content at each use",
    },
    return: {
      kind: "error",
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
    throw new TranslateError(
      `\`<${name}>\` calls a template tag; a data file cannot call a template tag`,
      loc.line ?? 0,
      loc.column ?? 0,
    );
  },
};
