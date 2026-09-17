import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { parseTemplate } from "@angular/compiler";
import type { MxWarning } from "@mxlang/core";
import ts from "typescript";
import { compile } from "../src/index.ts";

/** Compiles a `.mx` source string, returning both the template and any warnings. */
export function compileMx(
  source: string,
  filename = "x.mx",
): { code: string; warnings: MxWarning[] } {
  const result = compile(source, filename);
  return { code: result.code, warnings: result.warnings };
}

/** Compiles a `.mx` source string to its Angular template. Does not assert on warnings. */
export function emit(source: string, filename = "x.mx"): string {
  return compileMx(source, filename).code;
}

/** Asserts the given Angular template string parses with no errors. */
export function assertAngularParses(template: string): void {
  const result = parseTemplate(template, "x.html");
  if (result.errors) {
    throw new Error(
      `Angular parseTemplate reported errors for:\n${template}\n\n${result.errors
        .map((e) => e.msg)
        .join("\n")}`,
    );
  }
}

// Position/span fields Angular's parser attaches to every node — stripped so
// the snapshot is structural, not byte-offset-sensitive, and so `errors`
// (always `[]` once `assertAngularParses` has run) doesn't clutter the diff.
const SPAN_KEY =
  /span|Span|location|errors|references|startSourceSpan|endSourceSpan/i;

/**
 * Parses `template` with Angular's own compiler and returns its AST with
 * every span/position field stripped, for a structural snapshot. Catches the
 * class of bug a string-only golden misses — `[class]` emitted where
 * `[ngClass]` was intended still renders the same for a trivial fixture, but
 * shows up here as a different `inputs[].name`/`type`.
 */
export function angularAstSnapshot(template: string): unknown {
  const result = parseTemplate(template, "x.html");
  return JSON.parse(
    JSON.stringify(result.nodes, (key, value) =>
      SPAN_KEY.test(key) ? undefined : value,
    ),
  );
}

/**
 * Writes an emitted `.ts` module to disk and typechecks it for real with
 * `ts.createProgram`, `@angular/core` on the type path.
 *
 * `parseTemplate` alone only proves the `template:` string is syntax Angular
 * accepts — it never sees the surrounding module, so an emitted
 * `import { Component, Input } from "@angular/core"` colliding with the
 * tag's own `export interface Input` (`TS2440`) compiled clean and passed
 * every existing test. This is the real `tsc` pass that catches that class
 * of bug.
 */
export function assertModuleTypechecks(
  code: string,
  filename = "tag.ts",
): void {
  // Written under this package's own directory, not the system temp dir:
  // module resolution walks up from the file looking for `node_modules`,
  // and only this package's own `node_modules` (real or bun-linked) has
  // `@angular/core` on the type path.
  const dir = mkdtempSync(
    join(new URL("..", import.meta.url).pathname, ".typecheck-tmp-"),
  );
  try {
    const filePath = join(dir, filename);
    writeFileSync(filePath, code);

    const program = ts.createProgram([filePath], {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      experimentalDecorators: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => dir,
        getNewLine: () => "\n",
      });
      throw new Error(
        `emitted module failed to typecheck:\n${code}\n\n${formatted}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
