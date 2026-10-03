/**
 * `@mxlang/data` — the data target's public API (decisions 131/132).
 *
 * `parseData` compiles a `.mx` source with the data declarations and the
 * data taglib and projects the IR into the static tree (`tree.ts`). It fails
 * fast: Marko's parser and core's `fail` both stop at the first error, so an
 * error means exactly one positioned diagnostic and `tree: undefined` — no
 * partial tree in v1 (the 131 addendum's item 8). Warnings (a duplicate
 * attribute, today) are collected and returned alongside the tree.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CustomTag,
  compileSource,
  type Ir,
  type MxWarning,
  TranslateError,
} from "@mxlang/core";
import { buildDataDocument, lineStartsOf } from "./build.ts";
import { dataDeclarations } from "./declarations.ts";
import { dataTaglib } from "./taglib.ts";
import type { DataDocument } from "./tree.ts";

export { dataDeclarations, RESERVED_NAMES } from "./declarations.ts";
export { DATA_TAGLIB_ID, dataTaglib, neutralizations } from "./taglib.ts";
export type {
  DataAttr,
  DataAttrTag,
  DataAttrTagNode,
  DataBranch,
  DataDocument,
  DataExpr,
  DataForHead,
  DataNode,
  DataStatement,
  DataTag,
} from "./tree.ts";

export interface ParseDataOptions {
  /** Contract-only custom tags (decision 130), by call name. */
  customTags?: Record<string, CustomTag>;
  /**
   * `"pass"` (default) keeps the structural constructs — text, `${}`,
   * `<if>`/`<for>`/`<const>`, comments, `import`/`export`/`static` — in the
   * tree for the consumer to interpret. `"reject"` makes each one a
   * positioned error ("the data tree is static; this file's consumer does
   * not evaluate `<if>`"), for a consumer that wants tags and attributes
   * only and must not silently ignore an `<if>` its codegen never reads.
   */
  structural?: "pass" | "reject";
}

export interface DataDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** 1-based, as `TranslateError` and `MxWarning`. */
  line: number;
  /** 0-based, as core. */
  column: number;
  /**
   * UTF-16 code-unit offset, derived from `line`/`column` so a consumer
   * needs no line table. `-1` when `file` names another file: that file's
   * text is not available to `parseData`, so no offset can be computed.
   */
  offset: number;
  /** When the diagnostic's position is measured in another file. */
  file?: string;
}

export interface ParseDataResult {
  /** Absent when `diagnostics` holds an error: no partial tree. */
  tree: DataDocument | undefined;
  diagnostics: DataDiagnostic[];
}

function offsetOf(
  lineStarts: number[],
  source: string,
  line: number,
  column: number,
): number {
  const start = lineStarts[line - 1];
  if (start === undefined) return source.length;
  return Math.min(start + column, source.length);
}

/** The position an error carries, in the shape core and Marko each report. */
function errorPosition(
  error: unknown,
): { line: number; column: number; file?: string } | null {
  if (error instanceof TranslateError) {
    return { line: error.line, column: error.column, file: error.file };
  }
  if (!error || typeof error !== "object") return null;
  const loc = (error as { loc?: unknown }).loc;
  if (!loc || typeof loc !== "object") return null;
  const direct = loc as { line?: unknown; column?: unknown };
  if (typeof direct.line === "number" && typeof direct.column === "number") {
    return { line: direct.line, column: direct.column };
  }
  const start = (loc as { start?: unknown }).start;
  if (!start || typeof start !== "object") return null;
  const nested = start as { line?: unknown; column?: unknown };
  if (typeof nested.line === "number" && typeof nested.column === "number") {
    return { line: nested.line, column: nested.column };
  }
  return null;
}

/**
 * The prefixes Babel may have put in front of a lowering error's message.
 *
 * The wrap in `@marko/compiler`'s Babel pass prepends `` `${opts.filename}: ` ``,
 * and Babel resolves `opts.filename` against its `cwd` before the wrap runs
 * — so a relative or `./` filename is prefixed by its **absolute** form and
 * the caller's own spelling never matches. Strip whichever of the two leads,
 * longest first so `/a/t.mx: ` wins over `t.mx: `.
 */
function pathPrefixes(filename: string): string[] {
  const names = new Set<string>([filename, resolve(filename)]);
  return [...names]
    .map((name) => `${name}: `)
    .sort((a, b) => b.length - a.length);
}

/**
 * The message an error carries. Marko's `CompileError` (a syntax error) has
 * a one-line `label` ("EOF reached while parsing open tag") and a multi-line
 * framed `message`; the label is the diagnostic text. Everything else uses
 * `message` as is — after stripping the `filename: ` prefix the Babel pass
 * inside `@marko/compiler` prepends to any error thrown while lowering
 * (`babel.js`'s error wrap), which belongs to the diagnostic's `file` field,
 * not its text.
 */
function errorMessage(error: unknown, filename: string): string {
  const prefixes = pathPrefixes(filename);
  const strip = (text: string) => {
    for (const prefix of prefixes) {
      if (text.startsWith(prefix)) return text.slice(prefix.length);
    }
    return text;
  };
  if (error instanceof Error) {
    const label = (error as { label?: unknown }).label;
    if (typeof label === "string" && label.length > 0) return strip(label);
    return strip(error.message);
  }
  return String(error);
}

function toDiagnostic(
  severity: "error" | "warning",
  message: string,
  at: { line: number; column: number; file?: string },
  lineStarts: number[],
  source: string,
  filename: string,
): DataDiagnostic {
  const foreign = at.file !== undefined && at.file !== filename;
  return {
    severity,
    message,
    line: at.line,
    column: at.column,
    offset: foreign ? -1 : offsetOf(lineStarts, source, at.line, at.column),
    ...(at.file !== undefined ? { file: at.file } : {}),
  };
}

/**
 * Parses one data source into its static tree.
 *
 * Never throws for a source-level problem: a parse error, a rejected
 * construct or a failed contract is the single error diagnostic. An error
 * with no position at all is an internal failure, not source feedback, and
 * is rethrown.
 */
export function parseData(
  source: string,
  filename: string,
  options: ParseDataOptions = {},
): ParseDataResult {
  const lineStarts = lineStartsOf(source);
  const warnings: MxWarning[] = [];
  let ir: Ir | null = null;
  // No source pre-scan here any more: a CDATA section and an XML declaration
  // are rejected by core itself, at the `<` of the construct (decision 139),
  // so `compileSource` raises and `toErrorDiagnostic` reports it like any
  // other core error. This target adds no rule of its own for them, and needs
  // none — a construct core drops is a core bug, not a data one.
  const toErrorDiagnostic = (error: unknown): DataDiagnostic | null => {
    const at = errorPosition(error);
    if (!at) return null;
    return toDiagnostic(
      "error",
      errorMessage(error, filename),
      at,
      lineStarts,
      source,
      filename,
    );
  };
  try {
    compileSource(source, filename, dataDeclarations, {
      taglibs: [dataTaglib()],
      tagDiscoveryDirs: [],
      customTags: options.customTags,
      warnings,
      emitIr: (lowered) => {
        ir = lowered;
        // The tree, not a module, is this target's output; `compileSource`
        // requires text back, so the emitted "code" is an unused placeholder.
        return "";
      },
    });
  } catch (error) {
    const diagnostic = toErrorDiagnostic(error);
    if (!diagnostic) throw error;
    return { tree: undefined, diagnostics: [diagnostic] };
  }
  if (!ir) {
    throw new Error("@mxlang/data: compile produced no IR and no error");
  }
  const document = ir as Ir;
  try {
    const tree = buildDataDocument(document, source, filename, {
      structural: options.structural ?? "pass",
    });
    return {
      tree,
      diagnostics: warnings.map((warning) =>
        toDiagnostic(
          "warning",
          warning.message,
          warning,
          lineStarts,
          source,
          filename,
        ),
      ),
    };
  } catch (error) {
    const diagnostic = toErrorDiagnostic(error);
    if (!diagnostic) throw error;
    return { tree: undefined, diagnostics: [diagnostic] };
  }
}

/** `parseData` over a file on disk. */
export function parseDataFile(
  path: string,
  options: ParseDataOptions = {},
): ParseDataResult {
  return parseData(readFileSync(path, "utf8"), path, options);
}
