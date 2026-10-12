import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every error core raises carries a code from the catalogue
 * (`diagnostic-codes.ts`). The types enforce it at each wrapper (`raise`,
 * `codedError` and the local helpers take a required code); this scan keeps
 * a later edit from going around them: building a `TranslateError` by hand,
 * or calling the public `fail`, whose code is optional because a host's
 * emitter calls it too.
 */

const SRC = import.meta.dirname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // Test fixtures stand for third-party code (a target's own core).
      if (entry === "fixtures" || entry === "node_modules") continue;
      out.push(...sources(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Each code line of `file` (comment lines dropped), with its 1-based number. */
function codeLines(file: string): { line: number; text: string }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

function matches(pattern: RegExp, except: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of sources(SRC)) {
    const name = relative(SRC, file);
    if (except.includes(name)) continue;
    for (const { line, text } of codeLines(file)) {
      if (pattern.test(text)) hits.push(`${name}:${line}: ${text.trim()}`);
    }
  }
  return hits;
}

describe("every error core raises carries a code", () => {
  it("scans the core sources (the scan is not vacuous)", () => {
    const files = sources(SRC).map((file) => relative(SRC, file));
    expect(files).toContain("core.ts");
    expect(files).toContain("lower.ts");
    expect(files).toContain(join("ir-entry", "checks.ts"));
    expect(files.length).toBeGreaterThan(50);
  });

  it("builds no `TranslateError` by hand outside `core.ts`", () => {
    // `core.ts` holds `fail`, `raise` and `codedError`, the only builders.
    expect(matches(/\bnew TranslateError\(/, ["core.ts"])).toEqual([]);
  });

  it("calls no uncoded public `fail`: only `index.ts` imports it", () => {
    const importsFail = sources(SRC)
      .filter((file) => relative(SRC, file) !== "index.ts")
      .filter((file) =>
        /import\s*\{[^}]*\bfail\b[^}]*\}\s*from\s*"(\.\.?\/)+core\.ts"/s.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(SRC, file));
    expect(importsFail).toEqual([]);
  });

  it("writes no code as a string literal outside the catalogue", () => {
    // A code is one of the catalogue's constants, so a rename is one edit and
    // a typo does not compile.
    expect(
      matches(/diagnosticCode\s*=\s*["'`]|\bcode:\s*["'`]MX_/, [
        "diagnostic-codes.ts",
      ]),
    ).toEqual([]);
  });
});
