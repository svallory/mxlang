/**
 * A parse-only list of the tags a data file's author wrote.
 *
 * `unknownTags: "reject"` has to name an unknown parent even when core's
 * compile stops at an earlier contract error, and a lowering error that comes
 * later in the file (a misused `openTagOnly`, a `<define/>`) must not hide it.
 * So this pass never lowers: it parses with the MX front end, as the compile
 * does (core's `parseMxDocument`), under the same parse rules — the data
 * taglib's neutralizations plus each custom tag's `text` /
 * `preserveWhitespace` — and the same syntax table, and reads the MX
 * document. A parse error here is a parse error in the real compile too, so
 * the caller keeps its own error.
 */

import {
  type ContractScope,
  type CustomTag,
  matchWildcardChild,
  parseMxDocument,
  type SyntaxModule,
  type SyntaxTable,
  scopeForChildren,
  sugarTagName,
} from "@mxlang/core";
import { lineStartsOf } from "./build.ts";
import {
  DEFAULT_TAG,
  dataDeclarations,
  RESERVED_NAMES,
} from "./declarations.ts";
import { dataTaglib } from "./taglib.ts";

/** A tag the author wrote, with the position of its `<`. */
export interface AuthoredTag {
  name: string;
  /** 1-based line, 0-based column, as core. */
  line: number;
  column: number;
  /** Where the whole element ends (after its closing tag), when known. */
  endLine?: number;
  endColumn?: number;
}

/** The fields of an MX child this pass reads (`@mxlang/babel`'s `mx-ast`). */
interface MxChildNode {
  type: string;
  /** UTF-16 offsets into the file, `[start, end)`. */
  start: number;
  end: number;
  name?: { kind?: "static" | "dynamic" | "unnamed"; value?: string };
  body?: readonly MxChildNode[] | null;
}

const RESERVED = new Set<string>(RESERVED_NAMES);

const SCAN_TAGLIB_ID = "mx-data-scan-parse";

/**
 * One translator per parse-switch signature, kept for the life of the
 * process. Core's tag table (`tagTable`) is cached per translator object, so
 * reusing the object keeps each error-path scan from rebuilding the table;
 * the key carries the definitions, as core's `parserTaglibId` does.
 */
const translators = new Map<string, unknown>();

function translatorFor(customTags: Record<string, CustomTag> | undefined) {
  const custom = parseTaglib(customTags);
  const key = custom ? custom[0] : SCAN_TAGLIB_ID;
  let translator = translators.get(key);
  if (!translator) {
    translator = {
      taglibs: [dataTaglib(), ...(custom ? [custom] : [])],
      statementTags: false,
      tagDiscoveryDirs: [],
      translate: {},
    };
    translators.set(key, translator);
  }
  return translator;
}

/**
 * The custom tags' parse switches as a taglib. Only `text` and
 * `preserveWhitespace` reach the front end's tag shapes here (`openTagOnly`
 * is enforced by core's lowerer, which this pass does not run), and a tag
 * without any is left out, like core's own parser taglib does for the open
 * set.
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

/** 1-based line, 0-based column of a file offset, as core positions. */
function positionAt(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (lineStarts[low] as number) };
}

const TAG_TYPES = new Set(["MxTag", "MxAttributeTag", "MxReturn"]);

/**
 * The authored tags of `source`, or `null` when it does
 * not parse. Excluded: reserved names (core consumes them), `<@name>`
 * attribute tags (their bodies are still walked) and dynamic tags. The list
 * is in walk order, not necessarily document order: callers take the
 * earliest by position.
 */
export function scanAuthoredTags(
  source: string,
  filename: string,
  customTags: Record<string, CustomTag> | undefined,
  defaultTag: string = DEFAULT_TAG,
  syntax?: SyntaxTable | SyntaxModule,
): AuthoredTag[] | null {
  let document: { body: readonly MxChildNode[] } | undefined;
  try {
    document = parseMxDocument(
      source,
      filename,
      translatorFor(customTags),
      syntax,
      dataDeclarations.nativeTags,
    );
  } catch {
    return null;
  }
  if (!document) return null;
  const lineStarts = lineStartsOf(source);
  const tags: AuthoredTag[] = [];
  const visit = (
    nodes: readonly MxChildNode[] | null | undefined,
    scope: ContractScope | undefined,
  ) => {
    for (const node of nodes ?? []) {
      if (!TAG_TYPES.has(node.type)) continue;
      // An unnamed tag (`<#a>`, `.x`, `<:title>`) is the default tag; the
      // real compile resolves it, so this pass names it the same way instead
      // of reporting an unknown tag. Decision 146: `resource:post` is the tag
      // `resource` (the front end keeps `:post` as a shorthand).
      const kind = node.name?.kind;
      const written =
        node.type === "MxAttributeTag"
          ? `@${node.name?.value ?? ""}`
          : kind === "static"
            ? node.name?.value
            : undefined;
      const split = written === undefined ? undefined : sugarTagName(written);
      const unnamed = kind === "unnamed" || split?.unnamed === true;
      const name = unnamed ? defaultTag : split?.tag;
      // A tag the enclosing contract's `children["*"]` claims is known
      // (decision 147); the walk carries the contract in force, as core's does.
      // No `lookup`: this pass has no target taglib, and the structural names
      // it would hold are RESERVED already.
      const claimed =
        name !== undefined && !unnamed
          ? matchWildcardChild(node, name, scope, { customTags })
          : undefined;
      if (
        name !== undefined &&
        !claimed &&
        !name.startsWith("@") &&
        !RESERVED.has(name)
      ) {
        const start = positionAt(lineStarts, node.start);
        const end = positionAt(lineStarts, node.end);
        tags.push({
          name,
          line: start.line,
          column: start.column,
          endLine: end.line,
          endColumn: end.column,
        });
      }
      const inside =
        name === undefined
          ? undefined
          : scopeForChildren(
              node,
              claimed?.canonical ?? name,
              scope,
              customTags,
            );
      visit(node.body, inside);
    }
  };
  visit(document.body, undefined);
  return tags;
}
