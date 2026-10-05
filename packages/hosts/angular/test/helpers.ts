import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTemplate } from "@angular/compiler";
import type { MxWarning } from "@mxlang/core";
import { getCustomTags } from "@mxlang/core";
import ts from "typescript";
import { compile } from "../src/index.ts";
import { angularOwnTargets } from "../src/own-targets.ts";

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

/** `compileWithTags` returning only the template text, like `emit`. */
export function emitWithTags(source: string, tagNames: string[]): string {
  return compileWithTags(source, tagNames).code;
}

/**
 * Compiles `source` with every tag in `tagNames` discovered from a trivial
 * stub at `tags/<kebab>.mx`, so a capitalized tag call has a binding to
 * resolve through — decision 114 made an *unresolved* capitalized tag
 * Marko's compile error, so a test for the resolved-call path (selector,
 * projection, the step-1 import warning) must give the tag a real home.
 *
 * The temp project leaks deliberately, like every other mkdtemp fixture in
 * this suite. `filename` is relative to the project dir and may be nested.
 */
export function compileWithTags(
  source: string,
  tagNames: string[],
  filename = "x.mx",
): { code: string; warnings: MxWarning[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mx-ng-comptest-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
  mkdirSync(join(dir, "tags"));
  for (const name of tagNames) {
    // The tag's name is its filename, case included (`tags/UserCard.mx` is
    // `<UserCard>`). Static content only: the stub compiles as a unit of its
    // own, where a reference back to the caller's names would itself be
    // unresolved.
    writeFileSync(join(dir, "tags", `${name}.mx`), "<span>x</span>\n");
  }
  const filePath = join(dir, filename);
  mkdirSync(dirname(filePath), { recursive: true });
  const result = compile(source, filePath, {
    customTags: getCustomTags(filePath, {
      host: "angular",
      targets: angularOwnTargets,
    }),
  });
  return { code: result.code, warnings: result.warnings, dir };
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

/** The emitter's gensym order: `__mxAttr`, `__mxAttr1`, `__mxAttr2`, ... */
export const attrName = (n: number): string =>
  n === 0 ? "__mxAttr" : `__mxAttr${n}`;

/** The `@let` the emitter writes before a native element for one authored attribute expression. */
export const attrLet = (n: number, expression: string): string =>
  `@let ${attrName(n)} = $any(${expression});`;

/** The binding value for `[attr.name]`, over the `@let` named `__mxAttr<n>`. */
export const attrBinding = (n: number): string => {
  const v = attrName(n);
  return `${v} == null || ${v} === false ? null : ${v} === true ? '' : ${v}`;
};

/** The same for `class`/`style`, where a falsy primitive is omitted. */
export const listBinding = (n: number): string => {
  const v = attrName(n);
  return `${v} ? (${v} === true ? 'true' : ${v}) : null`;
};

/** The same for a live `value` property. */
export const textBinding = (n: number): string => {
  const v = attrName(n);
  return `${v} == null || ${v} === false || ${v} === true ? '' : ${v}`;
};

/** The same for a boolean DOM property: Marko's presence rule as a real boolean. */
export const presentBinding = (n: number): string => {
  const v = attrName(n);
  return `${v} != null && ${v} !== false`;
};
