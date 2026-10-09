/**
 * The data target's taglib (decision 131 and its addendum).
 *
 * Two halves:
 *
 * 1. **Neutralizations.** The web element table (`@mxlang/web-elements`,
 *    which this target gives core as its `nativeTags`) declares HTML parse
 *    rules for 19 tag names: void (`openTagOnly`), raw text (`text`) and
 *    `preserveWhitespace`. A data tag named `source`, `input`, `title` or
 *    `script` must parse like any other tag, so the data taglib overrides
 *    each rule with `false` — the *derived* list, read from that table
 *    rather than hand-listed, so a table change that adds a void tag changes
 *    the list with no edit here. (An empty override `{}` merges nothing and
 *    fails; scalars overwrite, which is why `false` wins.)
 *
 * 2. **Structural entries**, copied from core's
 *    `taglib/core-tags.json` (`CORE_TAGLIB`): `if`/`else`/`else-if`/`for`/`const`/`define`/
 *    `return`/`import`/`static`/`export`. They are not derivable from
 *    the element table. The host-owned entries (`let`, `id`, `effect`,
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

import { WEB_ELEMENTS } from "@mxlang/web-elements";

export const DATA_TAGLIB_ID = "mx-data";

interface ParseOptionsOverride {
  openTagOnly?: false;
  text?: false;
  preserveWhitespace?: false;
}

/**
 * The structural entries, copied from
 * `packages/core/src/taglib/core-tags.json` (`CORE_TAGLIB`). Keep in sync until
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

const OFF: Record<string, ParseOptionsOverride> = {
  void: { openTagOnly: false },
  "parsed-text": { text: false },
  preserve: { preserveWhitespace: false },
  "parsed-text-preserve": { text: false, preserveWhitespace: false },
};

/**
 * The names whose HTML parse rules the data taglib neutralizes, read from the
 * web element table: every element whose body is not plain HTML content, in
 * name order. 19 names, pinned by `taglib.test.ts` so a table change fails
 * loudly here.
 */
export function neutralizations(): Map<string, ParseOptionsOverride> {
  const out = new Map<string, ParseOptionsOverride>();
  const names = [...WEB_ELEMENTS.keys()].sort();
  for (const name of names) {
    const body = WEB_ELEMENTS.get(name)?.body;
    const off = body === undefined ? undefined : OFF[body];
    if (off) out.set(name, { ...off });
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
