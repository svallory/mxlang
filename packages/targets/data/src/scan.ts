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

import markoCompiler from "@marko/compiler";
import type { CustomTag } from "@mxlang/core";
import { RESERVED_NAMES } from "./declarations.ts";
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
  name?: { type: string; value?: string };
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
 * The authored tags of `source` in document order, or `null` when it does
 * not parse. Excluded: reserved names (core consumes them), `<@name>`
 * attribute tags (their bodies are still walked) and dynamic tags.
 */
export function scanAuthoredTags(
  source: string,
  filename: string,
  customTags: Record<string, CustomTag> | undefined,
): AuthoredTag[] | null {
  let program: { body: MarkoNode[] };
  try {
    const result = markoCompiler.compileSync(source, filename, {
      output: "source",
      ast: true,
      translator: translatorFor(customTags),
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
      const name =
        node.name?.type === "StringLiteral" ? node.name.value : undefined;
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
