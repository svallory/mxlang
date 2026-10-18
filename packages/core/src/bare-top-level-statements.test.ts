// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * Two keyword-less top-level forms, each probed on stock Marko 6.4.4
 * (`bun run --cwd packages/stock-marko probe '<source>'`):
 *
 * - a `static` alone on its line is an empty statement: stock compiles it
 *   (with or without a trailing line, a blank line, or at end of file) and
 *   emits nothing for it;
 * - a keyword-less `export` of `default` is refused at compile by stock
 *   ("A template is already its own default export. Use a named export
 *   instead."), type-only forms included, so the module never reaches a
 *   second default.
 *
 * The probe table below is the evidence: every row names stock's result.
 */
import { describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";

const BARE_DEFAULT =
  "A template is already its own default export, so a default export at the top of the file would give the module a second one and the module would not load. Use a named export instead (`export const x`, or `export { x }`).";

function lower(source: string) {
  return lowerSource(source, "/f/t.mx", { tagRules: "html" });
}

/** [name, source]; stock 6.4.4 compiles every row. */
const LONE_STATIC: [string, string][] = [
  ["a lone static before a tag", "static\n<div/>"],
  ["a lone static, a blank line, a tag", "static\n\n<div/>"],
  ["a lone static at end of file", "static\n"],
  ["a lone static with no newline", "static"],
  ["two lone statics", "static\nstatic\n<div/>"],
  [
    "a lone static before a static statement",
    "static\nstatic const a = 1\n<div/>",
  ],
  ["a lone static with only a semicolon", "static;\n<div/>"],
  ["a lone static in concise mode", "div\n  span\nstatic\n"],
  ["a lone static after a tag", "<div/>\nstatic\n<span/>"],
  ["a lone static with trailing spaces", "static   \n<div/>"],
];

describe("a `static` alone on its line is an empty statement, as in stock Marko", () => {
  it.each(LONE_STATIC)("%s compiles", (_name, source) => {
    const { ir, diagnostics } = lower(source);
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });

  it("declares and emits nothing", () => {
    const { ir } = lower("static\nstatic const a = 1\n<div/>");
    expect((ir?.hoisted ?? []).map((s) => s.code).filter(Boolean)).toEqual([
      "const a = 1",
    ]);
  });

  it("still refuses a `static` followed by a statement on the next line", () => {
    // Stock: line 2 is a `<const>` tag without a tag variable.
    const { ir, diagnostics } = lower("static\nconst a = 1\n<div/>");
    expect(ir).toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["MX_INVALID_CONST", 2],
    ]);
  });
});

/**
 * [name, source, the refused statement's text].
 * Every row is a compile error in stock 6.4.4 with
 * "A template is already its own default export. Use a named export instead."
 */
const REFUSED: [string, string, string][] = [
  [
    "export default function",
    "export default function f() {}\n<div/>",
    "export default function f() {}",
  ],
  [
    "export default anonymous function",
    "export default function () {}\n<div/>",
    "export default function () {}",
  ],
  [
    "export default class",
    "export default class A {}\n<div/>",
    "export default class A {}",
  ],
  [
    "export default abstract class",
    "export default abstract class A {}\n<div/>",
    "export default abstract class A {}",
  ],
  [
    "export default arrow",
    "export default async () => {}\n<div/>",
    "export default async () => {}",
  ],
  ["export default literal", "export default 1\n<div/>", "export default 1"],
  [
    "export default of an earlier name",
    "static const foo = 1;\nexport default foo;\n<div/>",
    "export default foo;",
  ],
  [
    "export default interface (type only)",
    "export default interface I {}\n<div/>",
    "export default interface I {}",
  ],
  [
    "export { x as default } after a static",
    "static const q = 1\nexport { q as default }\n<div/>",
    "export { q as default }",
  ],
  [
    "export { x as default, y }",
    "static const x = 1\nexport { x as default, x as y }\n<div/>",
    "export { x as default, x as y }",
  ],
  [
    'export { x as "default" }',
    'static const x = 1\nexport { x as "default" }\n<div/>',
    'export { x as "default" }',
  ],
  [
    "export type { T as default } (type only)",
    "export type { T as default }\n<div/>",
    "export type { T as default }",
  ],
  [
    "export { default } from",
    'export { default } from "./x"\n<div/>',
    'export { default } from "./x"',
  ],
  [
    "export { default as default } from",
    'export { default as default } from "./x"\n<div/>',
    'export { default as default } from "./x"',
  ],
  [
    "export { type T as default } from (type only)",
    'export { type T as default } from "./m"\n<div/>',
    'export { type T as default } from "./m"',
  ],
  [
    "export * as default from",
    'export * as default from "./x"\n<div/>',
    'export * as default from "./x"',
  ],
  [
    "an imported type exported as default",
    'import type { T } from "./m"\nexport { T as default }\n<div/>',
    "export { T as default }",
  ],
  [
    "export default after the template",
    "<div/>\nexport default 1",
    "export default 1",
  ],
];

function positionOf(source: string, offset: number): [number, number] {
  const before = source.slice(0, offset).split("\n");
  return [before.length, before[before.length - 1]?.length ?? 0];
}

describe("a keyword-less `export` of `default` is refused, as in stock Marko", () => {
  it.each(REFUSED)("%s", (_name, source, statement) => {
    const at = source.indexOf(statement);
    const { ir, diagnostics } = lower(source);
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    const [line, column] = positionOf(source, at);
    const [endLine, endColumn] = positionOf(source, at + statement.length);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: "MX_INVALID_STATEMENT",
      message: BARE_DEFAULT,
      line,
      column,
      end: { line: endLine, column: endColumn },
    });
  });

  it("states the rule and the fix, with no decision number or link", () => {
    expect(BARE_DEFAULT).toContain("already its own default export");
    expect(BARE_DEFAULT).toContain("Use a named export instead");
    expect(BARE_DEFAULT).not.toMatch(/decision|https?:/i);
  });

  it("refuses the first one when several statements export a default", () => {
    const { diagnostics } = lower("export default 1\nexport default 2\n<div/>");
    expect(diagnostics.map((d) => [d.code, d.line])).toEqual([
      ["MX_INVALID_STATEMENT", 1],
      ["MX_INVALID_STATEMENT", 2],
    ]);
  });
});

/** Stock compiles every one of these (probe: `export { default as foo } from`, named exports). */
describe("exports that are not a default stay accepted", () => {
  it.each([
    [
      "a named re-export of default",
      'export { default as foo } from "./x"\n<div/>',
    ],
    ["a named export", "export const a = 1\n<div/>"],
    ["a named export list", "static const a = 1\nexport { a }\n<div/>"],
    ["a renamed export", "static const a = 1\nexport { a as b }\n<div/>"],
    ["an export of a type", "export type T = 1\n<div/>"],
    [
      "a name that only starts with default",
      "static const a = 1\nexport { a as default2 }\n<div/>",
    ],
  ])("%s compiles", (_name, source) => {
    const { diagnostics } = lower(source);
    expect(diagnostics).toEqual([]);
  });
});
