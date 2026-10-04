/**
 * The data target's taglib (decision 131 and its addendum).
 *
 * Two halves:
 *
 * 1. **Neutralizations.** Marko's own `marko-html.json` declares HTML parse
 *    rules for 19 tag names: `openTagOnly` (void), `text` (raw body) and
 *    `preserveWhitespace`. A data tag named `source`, `input`, `title` or
 *    `script` must parse like any other tag, so the data taglib overrides
 *    each rule with `false` — the *derived* list, read from Marko's own
 *    taglib lookup rather than hand-listed, so a Marko bump that adds a void
 *    tag changes the list with no edit here. (An empty override `{}` merges
 *    nothing and fails; scalars overwrite, which is why `false` wins.)
 *
 * 2. **Structural entries**, copied from the html host's
 *    `taglib/marko.json`: `if`/`else`/`else-if`/`for`/`const`/`define`/
 *    `return`/`import`/`static`/`export`. They are not derivable from
 *    `marko-html.json`. The host-owned entries (`let`, `id`, `effect`,
 *    `lifecycle`, `log`, `debug`, `await`, `class`, `client`, `server`,
 *    `html-*`) are deliberately omitted, so those names stay ordinary data
 *    tag names. TODO `core-export-structural-taglib`: core may one day export
 *    these ten entries so html and data share one copy.
 *
 * Raw-text trade (the addendum's item 3): with `text: false` on `script`,
 * `style`, `textarea` and `title`, a body containing a tag-like `<name` is
 * parsed as tags, not text. A data file expresses text through `${"..."}`
 * or an attribute instead.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const DATA_TAGLIB_ID = "mx-data";

interface ParseOptionsOverride {
  openTagOnly?: false;
  text?: false;
  preserveWhitespace?: false;
}

/**
 * The structural entries, copied from
 * `packages/hosts/html/taglib/marko.json`. Keep in sync until
 * `core-export-structural-taglib` gives both packages one source.
 */
const STRUCTURAL_ENTRIES: Record<string, unknown> = {
  "<if>": {
    parseOptions: { controlFlow: true },
    "@value": { type: "expression" },
  },
  "<else>": {
    parseOptions: { controlFlow: true },
    "@if": { type: "expression" },
  },
  "<else-if>": {
    parseOptions: { controlFlow: true },
    "@value": { type: "expression" },
  },
  "<for>": {
    parseOptions: { controlFlow: true },
    "@of": { type: "expression" },
    "@in": { type: "expression" },
    "@from": { type: "expression" },
    "@to": { type: "expression" },
    "@until": { type: "expression" },
    "@step": { type: "expression" },
    "@by": { type: "expression" },
  },
  "<const>": {
    parseOptions: { openTagOnly: true },
    "@value": { type: "expression" },
  },
  "<define>": {},
  "<return>": { parseOptions: { openTagOnly: true } },
  "<import>": { parseOptions: { statement: true, rawOpenTag: true } },
  "<static>": { parseOptions: { statement: true, rawOpenTag: true } },
  "<export>": { parseOptions: { statement: true, rawOpenTag: true } },
};

/**
 * The names whose Marko HTML parse rules the data taglib neutralizes, read
 * from Marko's own lookup: every tag with any of `openTagOnly`, `text` or
 * `preserveWhitespace` set. 19 names on Marko 6.3.51 (`@marko/compiler`
 * 5.42.5), pinned by `taglib.test.ts` so a Marko change to the lookup or the
 * rules fails loudly here.
 */
export function neutralizations(): Map<string, ParseOptionsOverride> {
  // Required lazily: importing the descriptor must not load `@marko/compiler`
  // (the registry's light-import invariant), and in `dist/` a static import
  // would be hoisted to the top of the bundle.
  const markoCompiler =
    require("@marko/compiler") as typeof import("@marko/compiler");
  const lookup = markoCompiler.taglib.buildLookup("/", {
    taglibs: [],
    tagDiscoveryDirs: [],
    translate: {},
  });
  const out = new Map<string, ParseOptionsOverride>();
  for (const tag of lookup.getTagsSorted()) {
    const options = tag.parseOptions;
    if (!options) continue;
    const off: ParseOptionsOverride = {
      ...(options.openTagOnly ? { openTagOnly: false as const } : {}),
      ...(options.text ? { text: false as const } : {}),
      ...(options.preserveWhitespace
        ? { preserveWhitespace: false as const }
        : {}),
    };
    if (Object.keys(off).length > 0) out.set(tag.name, off);
  }
  return out;
}

function buildTaglib(): [string, unknown] {
  const definition: Record<string, unknown> = { taglibId: DATA_TAGLIB_ID };
  for (const [name, parseOptions] of neutralizations()) {
    definition[`<${name}>`] = { parseOptions };
  }
  Object.assign(definition, STRUCTURAL_ENTRIES);
  return [DATA_TAGLIB_ID, definition];
}

let cached: [string, unknown] | null = null;

/**
 * The data taglib, in `@marko/compiler`'s `[id, definition]` form (core's
 * `HostOptions.taglibs`). Derived once per process: the lookup read is not
 * free and the result cannot change within a run.
 */
export function dataTaglib(): [string, unknown] {
  cached ??= buildTaglib();
  return cached;
}
