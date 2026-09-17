import { parseTemplate } from "@angular/compiler";
import type { MxWarning } from "@mxlang/core";
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
