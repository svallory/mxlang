// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `export = x` and `import x = require("m")` in a `static`, `server`, `client`
 * or `export` statement.
 *
 * Both parse as TypeScript but are CommonJS forms. Stock Marko 6.4.4 refuses
 * them at the statement ("`export = <value>;` is only supported when compiling
 * modules to CommonJS."); MX used to throw Babel's own error from a position of
 * the generated code (189:16), with no code. They are refused at the statement,
 * with stock's first sentence and MX's fix. `import x = M.N` (a TypeScript
 * alias) is not a CommonJS form and still compiles.
 */
import { describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";

function lower(source: string) {
  return lowerSource(source, "/f/t.mx", { tagRules: "html" });
}

/** `[line, column]` (1-based line, 0-based column) of `offset` in `source`. */
function positionOf(source: string, offset: number): [number, number] {
  const before = source.slice(0, offset).split("\n");
  return [before.length, (before.at(-1) ?? "").length];
}

const EXPORT_EQUALS =
  "`export = <value>;` is only supported when compiling modules to CommonJS. Use a named export instead (`export const x = …`, or `export { x }`).";

const importRequire = (name: string, source: string, type = "") =>
  `\`import ${name} = require(...);\` is only supported when compiling modules to CommonJS. Write \`import ${type}${name} from "${source}"\``;

const KEYWORDS = ["static", "server", "client"] as const;

/** [name, keyword => [source, the refused statement's text, message]] */
const REFUSED: [string, (k: string) => [string, string, string]][] = [
  [
    "export =",
    (k) => [`${k} export = foo;\n<div/>`, "export = foo;", EXPORT_EQUALS],
  ],
  [
    "export = without a semicolon",
    (k) => [`${k} export = foo\n<div/>`, "export = foo", EXPORT_EQUALS],
  ],
  [
    "import = require",
    (k) => [
      `${k} import T = require("x");\n<div/>`,
      'import T = require("x");',
      importRequire("T", "x"),
    ],
  ],
  [
    "import type = require",
    (k) => [
      `${k} import type T = require("x");\n<div/>`,
      'import type T = require("x");',
      importRequire("T", "x", "type "),
    ],
  ],
  [
    "export import = require",
    (k) => [
      `${k} export import T = require("x");\n<div/>`,
      'export import T = require("x");',
      importRequire("T", "x"),
    ],
  ],
  [
    "a block, export =",
    (k) => [`${k} { export = foo; }\n<div/>`, "export = foo;", EXPORT_EQUALS],
  ],
  [
    "a block, import = require",
    (k) => [
      `${k} { import T = require("x"); }\n<div/>`,
      'import T = require("x");',
      importRequire("T", "x"),
    ],
  ],
  [
    "a block, export = without a semicolon",
    (k) => [`${k} { export = foo }\n<div/>`, "export = foo", EXPORT_EQUALS],
  ],
  [
    "a multi-line block, export = after a declaration",
    (k) => [
      `${k} {\n  const a = 1;\n  export = a;\n}\n<div/>`,
      "export = a;",
      EXPORT_EQUALS,
    ],
  ],
  [
    "a multi-line block, import = require after an import",
    (k) => [
      `${k} {\n  import a from "a";\n  import T = require("x");\n}\n<div/>`,
      'import T = require("x");',
      importRequire("T", "x"),
    ],
  ],
  [
    "export = in a second statement",
    (k) => [
      `${k} const a = 1;\n${k} export = a;\n<div/>`,
      "export = a;",
      EXPORT_EQUALS,
    ],
  ],
];

describe("a CommonJS form in a static, server or client statement is refused", () => {
  for (const keyword of KEYWORDS) {
    it.each(REFUSED)(`${keyword}: %s`, (_name, build) => {
      const [source, text, message] = build(keyword);
      const at = source.indexOf(text);
      const { ir, diagnostics } = lower(source);
      expect(ir).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      const [line, column] = positionOf(source, at);
      const [endLine, endColumn] = positionOf(source, at + text.length);
      expect(diagnostics[0]).toMatchObject({
        severity: "error",
        code: "MX_INVALID_STATEMENT",
        message,
        line,
        column,
        end: { line: endLine, column: endColumn },
      });
      // Not Babel's error from the generated code (189:16), and not uncoded.
      expect(diagnostics[0]?.message).not.toMatch(
        /Babel|--allowSyntheticDefaultImports|export default/,
      );
      expect(line).toBeLessThan(10);
    });
  }
});

describe("a top-level `export` statement holding a CommonJS form is refused", () => {
  it.each([
    ["export =", "export = foo;", EXPORT_EQUALS],
    [
      "export import = require",
      'export import T = require("x");',
      importRequire("T", "x"),
    ],
  ])("%s", (_name, text, message) => {
    const source = `${text}\n<div/>`;
    const { ir, diagnostics } = lower(source);
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_INVALID_STATEMENT",
      message,
      line: 1,
      column: 0,
      end: { line: 1, column: text.length },
    });
  });
});

describe("the message states the rule and the fix", () => {
  it("begins with Babel's first sentence and names no CommonJS plugin", () => {
    expect(EXPORT_EQUALS).toMatch(
      /^`export = <value>;` is only supported when compiling modules to CommonJS\. /,
    );
    expect(EXPORT_EQUALS).not.toMatch(/babel|plugin|decision|https?:/i);
    expect(EXPORT_EQUALS).not.toContain("export default");
  });
});

describe("what is not a CommonJS form still compiles", () => {
  it.each([
    ["a TypeScript alias", "static import A = B.C;"],
    ["an exported alias", "static export import A = B.C;"],
    ["an alias in a block", "static { import A = B.C; }"],
    ["an ES import", 'static import A from "a";'],
    ["a named export", "static export const a = 1;"],
    [
      "a CommonJS form in an ambient module",
      'static declare module "x" { import T = require("y"); }',
    ],
  ])("%s", (_name, statement) => {
    const { ir, diagnostics } = lower(`${statement}\n<div/>`);
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });

  it("a top-level `import T = require()` keeps its own refusal", () => {
    const { diagnostics } = lower('import T = require("x");\n<div/>');
    expect(diagnostics[0]).toMatchObject({
      code: "MX_INVALID_STATEMENT",
      line: 1,
      column: 0,
    });
    expect(diagnostics[0]?.message).toMatch(/^an `import` statement must be/);
  });
});
