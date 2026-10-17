/**
 * A parse-only list of the tags a source's author wrote, for the IR entry
 * point's `unknownTags: "reject"` (moved from `@mxlang/data`'s `scan.ts`).
 *
 * `unknownTags: "reject"` has to name an unknown parent even when the
 * lowering stops at an earlier contract error, and a lowering error that
 * comes later in the file (a misused `openTagOnly`, a `<define/>`) must not
 * hide it. So this pass never lowers: it parses with the MX front end, as the
 * lowering does (`parseMxDocument`), under the same parse rules — the tag
 * rules preset plus each custom tag's `text` / `preserveWhitespace` — and the
 * same syntax table, and reads the MX document. A parse error here is a parse
 * error in the real lowering too, so the caller keeps its own error.
 */

import { parseMxDocument } from "../compile.ts";
import type { TranslateError } from "../core.ts";
import type { CustomTag } from "../custom-tags.ts";
import { validateDefaultTag } from "../default-tag-validate.ts";
import type { Dialect, SyntaxTable } from "../syntax-table.ts";
import { type TagRules, taglibsOfRules } from "../tag-presets.ts";
import { type ContractScope, matchWildcardChild } from "../wildcard-resolve.ts";
import { DEFAULT_TAG, RESERVED_NAMES } from "./declarations.ts";
import { lineStartsOf, positionAt } from "./diagnostics.ts";
import {
  type Explainer,
  enterTag,
  ROOT_FRAME,
  scopeInside,
  type ViewFrame,
} from "./unknown-tag-view.ts";

/** A tag the author wrote, with the position of its `<`. */
export interface AuthoredTag {
  name: string;
  /** 1-based line, 0-based column, as core. */
  line: number;
  column: number;
  /** The file offset of the `<`: the identity of this occurrence. */
  offset: number;
  /** Where the whole element ends (after its closing tag), when known. */
  endLine?: number;
  endColumn?: number;
  /** Where the tag's `<name` ends (exclusive): the range an error blames. */
  nameEnd?: { line: number; column: number };
  /**
   * The dialect's error for this tag, when its `explainUnknownTag` explained
   * it (or failed doing so). Set only on a tag with no contract.
   */
  explained?: TranslateError;
}

/** What the scan needs to ask a dialect about the unknown tags it finds. */
export interface ScanExplain {
  explainer: Explainer;
  /** The names with a contract: a tag outside it is unknown. */
  declared: ReadonlySet<string>;
}

/** The fields of an MX child this pass reads (`@mxlang/babel`'s `mx-ast`). */
interface MxChildNode {
  type: string;
  /** UTF-16 offsets into the file, `[start, end)`. */
  start: number;
  end: number;
  name?: {
    kind?: "static" | "dynamic" | "unnamed";
    value?: string;
    span?: { start: number; end: number };
  };
  body?: readonly MxChildNode[] | null;
}

const RESERVED = new Set<string>(RESERVED_NAMES);

const SCAN_TAGLIB_ID = "mx-ir-entry-scan-parse";

/**
 * One translator per preset and parse-switch signature, kept for the life of
 * the process: the tag table caches by translator object, so the object must
 * be reused rather than rebuilt on each error-path scan.
 */
const translators = new Map<string, unknown>();

function translatorFor(
  rules: TagRules,
  customTags: Record<string, CustomTag> | undefined,
) {
  const custom = parseTaglib(customTags);
  const key = `${rules.preset}|${custom ? custom[0] : SCAN_TAGLIB_ID}`;
  let translator = translators.get(key);
  if (!translator) {
    translator = {
      taglibs: [...taglibsOfRules(rules), ...(custom ? [custom] : [])],
      statementTags: false,
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

const TAG_TYPES = new Set(["MxTag", "MxAttributeTag", "MxReturn"]);

/**
 * The authored tags of `source`, or `null` when it does not parse. Excluded:
 * reserved names (core consumes them), `<@name>` attribute tags (their bodies
 * are still walked) and dynamic tags. The list is in walk order, not
 * necessarily document order: callers take the earliest by position.
 * `include` lists reserved names to report anyway: the call sites of a
 * definition that was refused (`MX_RESERVED_TAG`).
 */
export function scanAuthoredTags(
  source: string,
  filename: string,
  rules: TagRules,
  customTags: Record<string, CustomTag> | undefined,
  defaultTag: string,
  dialect?: SyntaxTable | Dialect,
  include?: ReadonlySet<string>,
  explain?: ScanExplain,
): AuthoredTag[] | null {
  let document: { body: readonly MxChildNode[] } | undefined;
  try {
    document = parseMxDocument(
      source,
      filename,
      translatorFor(rules, customTags),
      dialect,
      rules.nativeTags,
    ) as { body: readonly MxChildNode[] } | undefined;
  } catch {
    return null;
  }
  if (!document) return null;
  const lineStarts = lineStartsOf(source);
  const tags: AuthoredTag[] = [];
  // What an unnamed tag (`<#a>`, `.x`) stands for: the nearest authored
  // parent's contract `defaultTag` when it is a valid one, else the caller's.
  // The lowering resolves it the same way (`resolveDefaultTag`), so the scan
  // must not name it by the caller's alone.
  const unnamedName = (scope: ContractScope | undefined): string => {
    const found = scope?.declaration.defaultTag;
    return typeof found === "string" &&
      found !== "" &&
      validateDefaultTag(found, { customTags, builtins: [DEFAULT_TAG] }) ===
        undefined
      ? found
      : defaultTag;
  };
  const visit = (
    nodes: readonly MxChildNode[] | null | undefined,
    frame: ViewFrame,
  ) => {
    const scope = frame.scope;
    for (const node of nodes ?? []) {
      if (!TAG_TYPES.has(node.type)) continue;
      // A colon is part of the name (`<resource:post>` is the tag
      // `resource:post`, as Marko reads it).
      const kind = node.name?.kind;
      const written =
        node.type === "MxAttributeTag"
          ? `@${node.name?.value ?? ""}`
          : kind === "static"
            ? node.name?.value
            : undefined;
      const unnamed = kind === "unnamed";
      const name = unnamed ? unnamedName(scope) : written;
      // A tag the enclosing contract's `children["*"]` claims is known;
      // the walk carries the contract in force, as core's does.
      // No `lookup`: this pass has no target taglib, and the structural names
      // it would hold are RESERVED already.
      const claimed =
        name !== undefined && !unnamed
          ? matchWildcardChild(node, name, scope, { customTags })
          : undefined;
      // The IR's name span of an attribute tag leaves out its `@`, so this
      // one does too: the hook gets one span whichever path finds the tag.
      const nameSpan = node.name?.span
        ? {
            sourceStart:
              node.name.span.start +
              (node.type === "MxAttributeTag" &&
              source[node.name.span.start] === "@"
                ? 1
                : 0),
            sourceEnd: node.name.span.end,
          }
        : undefined;
      const span = { sourceStart: node.start, sourceEnd: node.end };
      let explained: TranslateError | undefined;
      if (
        name !== undefined &&
        !claimed &&
        !name.startsWith("@") &&
        (!RESERVED.has(name) || include?.has(name))
      ) {
        const start = positionAt(lineStarts, node.start);
        const end = positionAt(lineStarts, node.end);
        if (explain && nameSpan && !explain.declared.has(name)) {
          explained = explain.explainer.explain({
            name,
            nameSpan,
            span,
            ancestors: frame.ancestors,
          });
        }
        tags.push({
          name,
          line: start.line,
          column: start.column,
          offset: node.start,
          endLine: end.line,
          endColumn: end.column,
          ...(nameSpan
            ? { nameEnd: positionAt(lineStarts, nameSpan.sourceEnd) }
            : {}),
          ...(explained ? { explained } : {}),
        });
      }
      visit(node.body, inside(frame, node, name, written, nameSpan, claimed));
    }
  };
  const inside = (
    frame: ViewFrame,
    node: MxChildNode,
    name: string | undefined,
    written: string | undefined,
    nameSpan: { sourceStart: number; sourceEnd: number } | undefined,
    claimed: unknown,
  ): ViewFrame => {
    // A dynamic tag has no name: no contract, and an empty name among the
    // ancestors (the IR's `DelegatedTag` for it has none either).
    const entered = {
      node,
      written: name === undefined ? "" : (written ?? name),
      name: name ?? "",
      ...(nameSpan ? { nameSpan } : {}),
      claimed: claimed !== undefined,
    };
    if (!explain) {
      return {
        scope: scopeInside(customTags, frame.scope, entered),
        ancestors: frame.ancestors,
      };
    }
    // A structural tag (`<if>`, `<for>`) is not an ancestor: the IR holds it
    // as control flow, so its body keeps the ancestors and the contract in
    // force around it.
    if (name !== undefined && RESERVED.has(name)) {
      return {
        scope: scopeInside(customTags, frame.scope, entered),
        ancestors: frame.ancestors,
      };
    }
    return enterTag(explain.explainer.env, frame, entered);
  };
  visit(document.body, ROOT_FRAME);
  return tags;
}
