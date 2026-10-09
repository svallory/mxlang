/**
 * `package.json#mx.syntax` (decision 182, PR C): the syntax table a file is
 * parsed with, resolved from the nearest manifest beside `mx.tags`, and the
 * check that keeps a table core cannot lower yet from compiling silently.
 *
 * The table is plain data (`@mxlang/parser`'s `SyntaxTable`); the types are
 * declared here because the published `.d.ts` may not name the private
 * `@mxlang/parser` (a test in `@mxlang/parse-differential` pins the two
 * declarations equal). This is the interim until the MX front end is bundled
 * into core (parser port PR 4).
 */
import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { TranslateError } from "./core.ts";
import { findNearestPackageJson } from "./host-policy.ts";
import { type MxTemplateParser, mxTemplateParser } from "./marko-frontend.ts";
import type { PackageJsonRead } from "./package-json.ts";
import { mxKeyPosition } from "./scan.ts";

/** What the expression parser reads in place of a trigger's text, always of the same length. */
export type StandIn = "number" | "identifier" | "keep";

/** What core builds from a trigger (`lowerTrigger`, not implemented yet). */
export type TriggerNode =
  | "string"
  | "identifier"
  | "attribute"
  | { readonly call: string };

/** One row of a trigger list (decision 182). */
export interface Trigger {
  readonly id: string;
  readonly chars: string;
  readonly match: string;
  readonly standIn: StandIn;
  readonly node: TriggerNode;
  readonly terminatesValue?: boolean;
}

/** The syntax table: one plain-data object per parse (decision 182; `language-extensions/core.md`). */
export interface SyntaxTable {
  readonly placeholder: {
    readonly open: string;
    readonly close: string;
  } | null;
  readonly inlineScript: { readonly trigger: string } | null;
  readonly blockTag: { readonly open: string; readonly close: string } | null;
  readonly filter: { readonly open: string; readonly close: string } | null;
  readonly concise: boolean;
  readonly expressionTriggers: readonly Trigger[];
  readonly attributeTriggers: readonly Trigger[];
  readonly lineTriggers: readonly Trigger[];
  readonly textTriggers: readonly Trigger[];
  /** Tag types by written name: html 0, text 1, void 2, statement 3 (the template parser's `TagType`). */
  readonly tagTypes: Readonly<Record<string, 0 | 1 | 2 | 3>>;
  readonly expressionLanguage: "ts";
}

/** One problem `validateSyntaxTable` reports. */
export interface SyntaxDiagnostic {
  readonly field: string;
  readonly triggerId?: string;
  readonly message: string;
}

/** The fields `mx.syntax` may set: the table's, less `tagTypes`. */
const MANIFEST_FIELDS = new Set([
  "placeholder",
  "inlineScript",
  "blockTag",
  "filter",
  "concise",
  "expressionTriggers",
  "attributeTriggers",
  "lineTriggers",
  "textTriggers",
  "expressionLanguage",
]);

/** Canonical JSON (keys sorted at every level), the input of a table's hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hashes already computed, per table object (tables are frozen data). */
const hashes = new WeakMap<object, string>();

/** A table's identity: the sha256 of its canonical JSON. Two tables with the same content hash alike. */
export function syntaxHash(table: SyntaxTable): string {
  let hash = hashes.get(table);
  if (hash === undefined) {
    hash = createHash("sha256").update(canonical(table)).digest("hex");
    if (Object.isFrozen(table)) hashes.set(table, hash);
  }
  return hash;
}

/**
 * The `.mx` default row, core's own copy of the parser's `DEFAULT_SYNTAX`
 * (a test pins them equal), so the default path never needs the parser: a
 * stock `htmljs-parser` swapped into the bundle has no syntax table.
 */
const DEFAULT_ROW: SyntaxTable = deepFreeze({
  placeholder: { open: "${", close: "}" },
  inlineScript: { trigger: "$ " },
  blockTag: null,
  filter: null,
  concise: true,
  expressionTriggers: [],
  attributeTriggers: [],
  lineTriggers: [],
  textTriggers: [],
  tagTypes: {},
  expressionLanguage: "ts",
});

/**
 * The `.mx` default row, deeply frozen: the base a consumer overlays to
 * build its own table (Mesh's `&` row), and what a file without
 * `mx.syntax` parses with.
 */
export function defaultSyntax(): SyntaxTable {
  return DEFAULT_ROW;
}

let defaultHash: string | undefined;

/** The hash of the default row. */
export function defaultSyntaxHash(): string {
  defaultHash ??= syntaxHash(DEFAULT_ROW);
  return defaultHash;
}

/** MX's template parser when it carries the syntax table API; undefined for a stock parser. */
function syntaxParser() {
  const parser = mxTemplateParser();
  return typeof parser.validateSyntaxTable === "function" ? parser : undefined;
}

/** Why a table cannot be honoured: the installed parser has no syntax table. */
const NEEDS_MX_PARSER =
  "a syntax table other than the `.mx` default row needs MX's template parser; the installed `htmljs-parser` has no syntax table";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) deepFreeze(field);
    Object.freeze(value);
  }
  return value;
}

/** Resolved tables by hash: one frozen object per distinct table in the process. */
const byHash = new Map<string, SyntaxTable>();

function intern(table: SyntaxTable): SyntaxTable {
  const hash = syntaxHash(table);
  const known = byHash.get(hash);
  if (known) return known;
  const frozen = deepFreeze(table);
  byHash.set(hash, frozen);
  return frozen;
}

/**
 * `package.json#mx.syntax` overlaid on `DEFAULT_SYNTAX`, validated, frozen and
 * interned by hash. `undefined` means the default row. A problem is a
 * `TranslateError` in the manifest, at the `mx.syntax` key, naming the field
 * (the `mx.tags` / `mx.contracts` precedent).
 */
export function normalizeMxSyntax(
  value: unknown,
  packageFile: string,
): SyntaxTable {
  if (value === undefined) return DEFAULT_ROW;
  const fail = (message: string): never => {
    const { line, column } = mxKeyPosition(packageFile, "syntax");
    throw new TranslateError(message, line, column, packageFile);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("`mx.syntax` must be an object overlaying the syntax table");
  }
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (key === "tagTypes") {
      fail(
        "`mx.syntax.tagTypes` is not a manifest field: tag types are taglib-owned, computed from the tags and their parseOptions",
      );
    }
    if (!MANIFEST_FIELDS.has(key)) {
      fail(
        `\`mx.syntax.${key}\` is not a syntax table field (${[...MANIFEST_FIELDS].join(", ")})`,
      );
    }
  }
  const table = { ...DEFAULT_ROW, ...fields } as SyntaxTable;
  if (syntaxHash(table) === defaultSyntaxHash()) return DEFAULT_ROW;
  const parser = syntaxParser();
  if (!parser) fail(`\`mx.syntax\`: ${NEEDS_MX_PARSER}`);
  const problems = (parser as MxTemplateParser).validateSyntaxTable(table);
  if (problems.length > 0) {
    fail(
      problems
        .map(
          (problem) =>
            `\`mx.syntax.${problem.field}\`${problem.triggerId === undefined ? "" : ` (trigger "${problem.triggerId}")`}: ${problem.message}`,
        )
        .join("; "),
    );
  }
  return intern(structuredClone(table));
}

/** The table each manifest read gave, so an unchanged `package.json` is never re-validated. */
const byManifest = new WeakMap<PackageJsonRead, SyntaxTable>();

/**
 * The syntax table for `filename`: its nearest `package.json`'s `mx.syntax`,
 * so a dependency's files use the dependency's manifest. A relative or
 * virtual name with no manifest above it gets the default row.
 */
export function resolveSyntax(filename: string): SyntaxTable {
  if (!isAbsolute(filename)) return DEFAULT_ROW;
  const found = findNearestPackageJson(dirname(filename));
  if (!found?.read.manifest) return DEFAULT_ROW;
  const known = byManifest.get(found.read);
  if (known) return known;
  const mx = (found.read.manifest as { mx?: { syntax?: unknown } }).mx;
  const table = normalizeMxSyntax(mx?.syntax, found.file);
  byManifest.set(found.read, table);
  return table;
}

/** Explicit tables already validated (tables are frozen data, checked once per object). */
const validExplicit = new WeakSet<object>();

/**
 * An explicit `syntax` option (`HostOptions.syntax`, `FragmentBase.syntax`,
 * `ParseDataOptions.syntax`: a consumer's own table, Mesh's path), validated
 * with the manifest's rules and wording, as the caller's error: a
 * `TranslateError` at the start of `filename` naming `syntax.<field>`. A
 * non-empty `tagTypes` is refused (taglib-owned), as in a manifest.
 */
export function explicitSyntax(
  table: SyntaxTable,
  filename: string,
): SyntaxTable {
  if (table === DEFAULT_ROW || validExplicit.has(table)) return table;
  const fail = (message: string): never => {
    throw new TranslateError(message, 1, 0, filename);
  };
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    fail("the `syntax` option must be a syntax table object");
  }
  if (
    table.tagTypes &&
    typeof table.tagTypes === "object" &&
    Object.keys(table.tagTypes).length > 0
  ) {
    fail(
      "the `syntax` option's `tagTypes` must be empty: tag types are taglib-owned, computed from the tags and their parseOptions",
    );
  }
  if (syntaxHash(table) !== defaultSyntaxHash()) {
    const parser = syntaxParser();
    if (!parser) fail(`the \`syntax\` option: ${NEEDS_MX_PARSER}`);
    const problems = (parser as MxTemplateParser).validateSyntaxTable(table);
    if (problems.length > 0) {
      fail(
        `the \`syntax\` option is not a valid syntax table: ${problems
          .map(
            (problem) =>
              `\`syntax.${problem.field}\`${problem.triggerId === undefined ? "" : ` (trigger "${problem.triggerId}")`}: ${problem.message}`,
          )
          .join("; ")}`,
      );
    }
  }
  // Only a frozen table is remembered: an unfrozen one could change.
  if (Object.isFrozen(table)) validExplicit.add(table);
  return table;
}

/** Where a parse runs: the file and the fragment's base, for positions. */
export interface SyntaxSite {
  filename: string;
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
}

/** For tests: how many syntax pre-passes have run in this process. */
export const syntaxPrepasses = { count: 0 };

/**
 * Fails `source` loudly when its table makes the parser produce something
 * core cannot lower yet: the first trigger, block tag or filter is a
 * positioned error ("`<id>` trigger has no lowering yet"), and so is an error
 * the table itself causes in the template parser. A table equal to the
 * default row (by hash) costs nothing: no pre-pass runs. When the pre-pass
 * sees nothing, the default parse that follows is the table's parse, because
 * a table changes nothing until one of those events.
 */
export function checkSyntaxUse(
  source: string,
  table: SyntaxTable,
  site: SyntaxSite,
): void {
  // The default row by identity first: a plain project pays one comparison.
  if (table === DEFAULT_ROW || syntaxHash(table) === defaultSyntaxHash()) {
    return;
  }
  syntaxPrepasses.count++;
  const parser = syntaxParser();
  if (!parser) {
    throw new TranslateError(NEEDS_MX_PARSER, 1, 0, site.filename);
  }
  let found: { start: number; message: string } | undefined;
  const first = (start: number, message: string) => {
    found ??= { start, message };
  };
  parser
    .createParser(
      {
        onTrigger: (event: { id: string; start: number }) =>
          first(event.start, `\`${event.id}\` trigger has no lowering yet`),
        onBlockTag: (event: { start: number }) =>
          first(event.start, "a block tag has no lowering yet"),
        onFilter: (event: {
          start: number;
          name: { start: number; end: number };
        }) =>
          first(
            event.start,
            `the \`${source.slice(event.name.start, event.name.end)}\` filter has no lowering yet`,
          ),
        onError: (event: { start: number; message: string }) =>
          first(event.start, event.message),
      },
      { syntax: table },
    )
    .parse(source);
  if (!found) return;
  const { line, column } = position(source, found.start, site);
  throw new TranslateError(found.message, line, column, site.filename);
}

/** 1-based line, 0-based column of `offset`, shifted by the fragment's base. */
function position(
  source: string,
  offset: number,
  site: SyntaxSite,
): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (
    let at = source.indexOf("\n");
    at !== -1 && at < offset;
    at = source.indexOf("\n", at + 1)
  ) {
    line++;
    lineStart = at + 1;
  }
  const column = offset - lineStart;
  return {
    line: line + 1 + (site.baseLine ?? 0),
    column: line === 0 ? column + (site.baseColumn ?? 0) : column,
  };
}
