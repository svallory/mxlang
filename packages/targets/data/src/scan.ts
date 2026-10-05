/**
 * A parse-only list of the tags a data file's author wrote.
 *
 * `unknownTags: "reject"` has to name an unknown parent even when core's
 * compile stops at an earlier contract error, and a lowering error that comes
 * later in the file (a misused `openTagOnly`, a `<define/>`) must not hide it.
 * So this pass never lowers: it hands `@marko/compiler` the same parse rules
 * the real compile uses — the data taglib's neutralizations plus each custom
 * tag's `text` / `preserveWhitespace` — with a translator that translates
 * nothing, and reads the Marko tree. A parse error here is a parse error in
 * the real compile too, so the caller keeps its own error.
 */

import { dirname } from "node:path";
import {
  type CustomTag,
  markoCompiler as coreMarkoCompiler,
  type MarkoCompiler,
  sugarTagName,
} from "@mxlang/core";
import { DEFAULT_TAG, RESERVED_NAMES } from "./declarations.ts";
import { dataTaglib } from "./taglib.ts";

/** A tag the author wrote, with the position of its `<`. */
export interface AuthoredTag {
  name: string;
  /** 1-based line, 0-based column, as core. */
  line: number;
  column: number;
}

interface MarkoNode {
  type: string;
  name?: {
    type: string;
    value?: string;
    loc?: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
  };
  body?: { body?: MarkoNode[] };
  attributeTags?: MarkoNode[];
  loc?: { start: { line: number; column: number } };
}

const RESERVED = new Set<string>(RESERVED_NAMES);

const SCAN_TAGLIB_ID = "mx-data-scan-parse";

/**
 * One translator per parse-switch signature, kept for the life of the
 * process. Marko caches a lookup by taglib id and keeps every translator
 * object it has seen in a map that is never freed, so the id must carry the
 * definitions (as core's `parserTaglibId` does) and the object must be reused
 * rather than rebuilt on each error-path scan.
 */
const translators = new Map<string, unknown>();

function translatorFor(customTags: Record<string, CustomTag> | undefined) {
  const custom = parseTaglib(customTags);
  const key = custom ? custom[0] : SCAN_TAGLIB_ID;
  let translator = translators.get(key);
  if (!translator) {
    translator = {
      taglibs: [dataTaglib(), ...(custom ? [custom] : [])],
      tagDiscoveryDirs: [],
      translate: {},
    };
    translators.set(key, translator);
  }
  return translator;
}

/**
 * The custom tags' parse switches as a taglib. Only `text` and
 * `preserveWhitespace` cross into Marko's parser (`openTagOnly` is enforced
 * by core's lowerer, which this pass does not run), and a tag without any is
 * left out, like core's own parser taglib does for the open set.
 */
function parseTaglib(
  customTags: Record<string, CustomTag> | undefined,
): [string, unknown] | null {
  const definitions: Record<string, unknown> = {};
  for (const [name, tag] of Object.entries(customTags ?? {})) {
    const { text, preserveWhitespace } = tag.parseOptions ?? {};
    if (text === undefined && preserveWhitespace === undefined) continue;
    definitions[`<${name}>`] = {
      parseOptions: {
        ...(text === undefined ? {} : { text }),
        ...(preserveWhitespace === undefined ? {} : { preserveWhitespace }),
      },
    };
  }
  const names = Object.keys(definitions).sort();
  if (names.length === 0) return null;
  const signature = names.map((name) => [name, definitions[name]]);
  return [`${SCAN_TAGLIB_ID}:${JSON.stringify(signature)}`, definitions];
}

/**
 * Builds the lookup `compileSync` is about to ask for and makes its tag map
 * prototype-free. Marko's `getTag(name)` is `merged.tags[name]` on a plain
 * object, so a tag named `toString` or `__proto__` resolves to an
 * `Object.prototype` member and Marko throws a raw `TypeError`, which the
 * caller's `catch` would turn into "does not parse". Core does the same for
 * its own compiles (`lookup-safety.ts`); this pass compiles with its own
 * translator, so it hardens its own lookup rather than relying on a core
 * export. `buildLookup` returns the lookup Marko caches by taglib ids, so this
 * runs on a cold or a warm cache alike and is idempotent.
 */
function hardenLookup(
  markoCompiler: MarkoCompiler,
  filename: string,
  translator: unknown,
): void {
  const lookup = markoCompiler.taglib.buildLookup(
    dirname(filename),
    // biome-ignore lint/suspicious/noExplicitAny: the translator is an untyped plain object here
    translator as any,
  ) as unknown as { merged?: { tags?: object } };
  const tags = lookup.merged?.tags;
  if (tags && Object.getPrototypeOf(tags) !== null) {
    Object.setPrototypeOf(tags, null);
  }
}

/**
 * The authored tags of `source`, or `null` when it does
 * not parse. Excluded: reserved names (core consumes them), `<@name>`
 * attribute tags (their bodies are still walked) and dynamic tags. The list
 * is in walk order, a tag's attribute tags before its children, not document
 * order: callers take the earliest by position.
 */
export function scanAuthoredTags(
  source: string,
  filename: string,
  customTags: Record<string, CustomTag> | undefined,
  defaultTag: string = DEFAULT_TAG,
): AuthoredTag[] | null {
  let program: { body: MarkoNode[] };
  try {
    const markoCompiler = coreMarkoCompiler();
    const translator = translatorFor(customTags);
    hardenLookup(markoCompiler, filename, translator);
    const result = markoCompiler.compileSync(source, filename, {
      output: "source",
      ast: true,
      translator,
      // biome-ignore lint/suspicious/noExplicitAny: the compiler's result type is untyped here
    } as any) as unknown as { ast: { program: { body: MarkoNode[] } } };
    program = result.ast.program;
  } catch {
    return null;
  }
  const tags: AuthoredTag[] = [];
  const visit = (nodes: MarkoNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type !== "MarkoTag") continue;
      // Marko writes `div` into an unnamed tag (`<#a>`, `.x`) with an empty
      // name span; the real compile resolves it, so this pass names it the
      // same way instead of reporting an unknown `div`.
      const nameLoc = node.name?.loc;
      const unnamed =
        node.name?.type === "StringLiteral" &&
        nameLoc !== undefined &&
        nameLoc.start.line === nameLoc.end.line &&
        nameLoc.start.column === nameLoc.end.column;
      // Decision 146: `resource:post` is the tag `resource` and `:title` an
      // unnamed tag; the real compile splits them, so this pass does too.
      const written =
        node.name?.type === "StringLiteral" ? node.name.value : undefined;
      const split = written === undefined ? undefined : sugarTagName(written);
      const name = unnamed || split?.unnamed ? defaultTag : split?.tag;
      const start = node.loc?.start;
      if (
        name !== undefined &&
        start &&
        !name.startsWith("@") &&
        !RESERVED.has(name)
      ) {
        tags.push({ name, line: start.line, column: start.column });
      }
      visit(node.attributeTags);
      visit(node.body?.body);
    }
  };
  visit(program.body);
  return tags;
}
