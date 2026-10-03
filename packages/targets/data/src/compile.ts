/**
 * The data target's whole-file compile (`TargetCompiler.compileModule`).
 *
 * A data tree is not code, so the module this emits is the tree itself: a
 * TypeScript module whose default export is the `SerializedDataDocument`
 * (`parseData`'s tree with every Babel `node` removed) as a literal
 * (`as const`). The module imports nothing, so it type-checks in a consumer
 * that has no `@mxlang/*` package (`@mxlang/data` is source-only and its tree
 * types pull in `@babel/types` and core). `import post from "./post.mx"` is
 * then typed by the literal, which is assignable to `SerializedDataDocument`,
 * and the language server, TypeScript plugin,
 * `mx-tsc` and Vite can all treat a data file like any other target's output.
 *
 * `./parse.ts` is required inside `compileModule`, not imported: it reaches
 * the data taglib, which imports `@marko/compiler`, and `load()` must load no
 * compiler (the registry's light-import rule).
 */

import {
  type TargetCompileOptions,
  type TargetCompileResult,
  TranslateError,
} from "@mxlang/core";
import type { DataDocument, SerializedDataDocument } from "./tree.ts";

/** `DataExpr` is the only tree object with a `code` and a `shape`. */
function isDataExpr(value: object): boolean {
  return "code" in value && "shape" in value && "node" in value;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const drop = isDataExpr(value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (drop && key === "node") continue;
    out[key] = strip(child);
  }
  return out;
}

/** The tree without its Babel nodes: what the compiled module exports. */
export function serializeDataDocument(
  document: DataDocument,
): SerializedDataDocument {
  return strip(document) as SerializedDataDocument;
}

/**
 * Whole-file `.mx` data file to a module.
 *
 * - A source error (a parse error, a rejected construct, a failed contract)
 *   throws one positioned `TranslateError`, as the `TargetCompiler` contract
 *   requires. The data parse is fail-fast, so there is no partial tree to
 *   emit; the language server reports the error on its line.
 * - Warnings go to `options.warnings` as core raises them, or print to
 *   `console.warn` when unset, as core's own `warn` does; either way those
 *   raised before an error are kept. Error messages carry no `<filename>: `
 *   prefix (`parseData` strips the one Babel adds); `TranslateError.file` is
 *   set only for another file's position.
 * - `options.strict` and `options.resolveImport` have no effect: the data
 *   target has no strict mode and keeps `import` as statement text, never
 *   resolving it. `dependencies` is `[]`, because no callee file is read.
 */
export function compileModule(
  source: string,
  filename: string,
  options: TargetCompileOptions = {},
): TargetCompileResult {
  const { parseData } = require("./parse.ts") as typeof import("./parse.ts");
  const warnings = options.warnings ?? [];
  const first = warnings.length;
  let parsed: ReturnType<typeof parseData>;
  try {
    parsed = parseData(source, filename, {
      customTags: options.customTags,
      warnings,
    });
  } finally {
    // No sink: print what was raised, even when the parse then throws.
    if (!options.warnings) {
      for (const warning of warnings.slice(first)) {
        // Core's `warn` format (`core.ts:466`); it needs a `Ctx`, so it is restated.
        const where = warning.file ? `${warning.file}:` : "";
        console.warn(
          `${where}${warning.line}:${warning.column}: ${warning.message}`,
        );
      }
    }
  }
  const { tree, diagnostics } = parsed;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      throw new TranslateError(
        diagnostic.message,
        diagnostic.line,
        diagnostic.column,
        diagnostic.file,
      );
    }
  }
  if (!tree) {
    throw new Error("@mxlang/data: parseData returned no tree and no error");
  }
  const code = `export default ${JSON.stringify(serializeDataDocument(tree), null, 2)} as const;\n`;
  return { code, dependencies: [] };
}
