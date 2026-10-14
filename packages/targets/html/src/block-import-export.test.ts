// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `import` and `export` inside a `static`, `server` or `client` block.
 *
 * Stock Marko 6.4.4 hoists the statements inside the block to the module, so
 * an `import` or `export` there is a module-level statement (probed with
 * `stockMarkoCompile` in `packages/stock-marko`; the `block-import-export`
 * fixture in `fixtures-marko` locks the render). A `client` block still only
 * declares its names (`var x;`), as in `client-block.test.ts`.
 *
 * The expectations are MX's module text: the statements as authored, not the
 * semicolon-terminated reprint stock Marko's generator makes.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/** The hoisted module code: what sits between the runtime import and `export interface Input`. */
function hoisted(source: string): string {
  const { code } = compile(source, "/f/t.mx");
  const from = code.indexOf("\n", code.indexOf("@mxlang/target-html")) + 1;
  return code.slice(from, code.indexOf("export interface Input")).trim();
}

const TEMPLATE = "\n<div/>\n";

describe("html: an import or export in a block is a module-level statement", () => {
  it.each([
    ["static import", 'static { import x from "./x" }', 'import x from "./x"'],
    ["server import", 'server { import x from "./x" }', 'import x from "./x"'],
    [
      "static export const",
      "static { export const z = 1 }",
      "export const z = 1",
    ],
    [
      "static export function",
      "static { export function f() {} }",
      "export function f() {}",
    ],
    [
      "static export list",
      "static { const y = 1; export { y } }",
      "const y = 1; export { y }",
    ],
    [
      "static export from",
      'static { export { a } from "./x" }',
      'export { a } from "./x"',
    ],
    [
      "static export star",
      'static { export * from "./x" }',
      'export * from "./x"',
    ],
    ["static bare import", 'static { import "./side" }', 'import "./side"'],
    [
      "static type import",
      'static { import type { T } from "./x"; const a: T = 1 }',
      'import type { T } from "./x"; const a: T = 1',
    ],
    [
      "server export star",
      'server { export * from "./x" }',
      'export * from "./x"',
    ],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("keeps the imported name readable by a later statement and the template", () => {
    const { code } = compile(
      'static { import x from "./x"; const y = x; }\n<div>${y}</div>\n',
      "/f/t.mx",
    );
    expect(code).toContain('import x from "./x"; const y = x;');
    expect(code).toMatch(/escape\(y\)|__mxTextOf\(y\)/);
  });

  it("is the module code the statement has without the block", () => {
    expect(hoisted(`static import x from "./x"${TEMPLATE}`)).toBe(
      hoisted(`static { import x from "./x" }${TEMPLATE}`),
    );
  });
});

describe("html: a `client` block's import or export declares its names", () => {
  it.each([
    ["an import", 'client { import x from "./x"; }', "var x;"],
    ["an export const", "client { export const y = 1 }", "var y;"],
    [
      "an export function and class",
      "client { export class C {} export function f() {} }",
      "var C, f;",
    ],
    ["a type-only import", 'client { import type { T } from "./x" }', ""],
    ["an export star", 'client { export * from "./x" }', ""],
    ["an export from", 'client { export { a } from "./x" }', ""],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("emits none of the client block's code", () => {
    const { code } = compile(
      'client { import x from "./x"; export const y = x }\n<div/>\n',
      "/f/t.mx",
    );
    expect(code).not.toContain("./x");
    expect(code).toContain("var x, y;");
  });
});

describe("html: an import or export below the block's statements is refused with a position", () => {
  it.each([
    ["a nested block", 'static { { import x from "./x" } }', 1, 11],
    ["an if body", "static { if (a) { export const q = 1 } }", 1, 18],
    ["a client nested block", 'client { { import x from "./x" } }', 1, 11],
  ])("%s", (_name, statement, line, column) => {
    let error: { line?: number; column?: number; message?: string } = {};
    try {
      compile(`${statement}${TEMPLATE}`, "/f/t.mx");
    } catch (thrown) {
      error = thrown as typeof error;
    }
    expect(error.message).toBe(
      "An `import` or `export` must be a statement of the module: at the top of the file, after `static`, `server` or `client`, or directly inside that statement's `{ … }` block. This one is inside a nested block, an `if` or a function body; move it out to the block's own statements.",
    );
    expect([error.line, error.column]).toEqual([line, column]);
  });
});

describe("html: a default export in a static, server or client statement is refused with a position", () => {
  const SECOND_DEFAULT =
    "A template is already its own default export, so this default export would give the module a second one and the module would not load. Use a named export instead (`export const x`, or `export { x }`).";

  it.each([
    ["static block", "static { const foo = 1; export default foo }", 1, 24],
    ["server block", "server { const foo = 1; export default foo }", 1, 24],
    ["client block", "client { export default 5 }", 1, 9],
    ["static block-less", "static export default 5;", 1, 7],
    ["server block-less", "server export default 5;", 1, 7],
    ["client block-less", "client export default 5;", 1, 7],
    [
      "static as default",
      "static { const q = 1; export { q as default } }",
      1,
      22,
    ],
    [
      "static block-less as default, an earlier statement",
      "static const q = 1;\nstatic export { q as default };",
      2,
      7,
    ],
    ["static function", "static { export default function f() {} }", 1, 9],
    ["static class", "static { export default class C {} }", 1, 9],
    ["static re-export", 'static export { default } from "./m";', 1, 7],
  ])("%s", (_name, statement, line, column) => {
    let error: { line?: number; column?: number; message?: string } = {};
    try {
      compile(`${statement}${TEMPLATE}`, "/f/t.mx");
    } catch (thrown) {
      error = thrown as typeof error;
    }
    expect(error.message).toBe(SECOND_DEFAULT);
    expect([error.line, error.column]).toEqual([line, column]);
  });

  it.each([
    "static export default interface I {}",
    "static { type T = 1; export type { T as default } }",
  ])("compiles the type-only form %s, which exports nothing", (statement) => {
    expect(() => compile(`${statement}${TEMPLATE}`, "/f/t.mx")).not.toThrow();
  });
});

describe("html: an export list names a binding an earlier statement declares", () => {
  let dir: string;
  beforeAll(() => {
    // Under the home directory, not /tmp: /tmp is a small shared tmpfs.
    mkdirSync(join(homedir(), "tmp"), { recursive: true });
    dir = realpathSync(mkdtempSync(join(homedir(), "tmp", "mx-html-export-")));
    // The module `./q` and the runtime the emitted code imports.
    writeFileSync(join(dir, "q.mjs"), "export const q = 3;\n");
    writeFileSync(
      join(dir, "runtime.mjs"),
      "export const escape = String;\nexport const createOut = () => ({ write() {}, toString: () => '' });\n",
    );
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  let count = 0;
  /** Compiles `source`, loads the emitted module with `import()` and returns its exports. */
  async function load(source: string): Promise<Record<string, unknown>> {
    const written: string[] = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...args: unknown[]) => written.push(args.join(" "));
    console.error = (...args: unknown[]) => written.push(args.join(" "));
    let code: string;
    try {
      code = compile(source, "/f/t.mx").code;
    } finally {
      console.warn = warn;
      console.error = error;
    }
    expect(written).toEqual([]);
    const js = ts
      .transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      })
      .outputText.replace('"@mxlang/target-html"', '"./runtime.mjs"')
      .replace('"./q"', '"./q.mjs"');
    const file = join(dir, `t${count++}.mjs`);
    writeFileSync(file, js);
    return import(/* @vite-ignore */ pathToFileURL(file).href);
  }

  it.each([
    [
      "an earlier static statement",
      "static const q = 1;\nstatic export { q };",
      "q",
      1,
    ],
    [
      "an earlier static import",
      'static import { q } from "./q";\nstatic export { q };',
      "q",
      3,
    ],
    [
      "an earlier server statement",
      "server const q = 1;\nserver export { q };",
      "q",
      1,
    ],
    [
      "a rename",
      "static const q = 1;\nstatic export { q as other };",
      "other",
      1,
    ],
    ["a block", "static const q = 1;\nstatic { export { q } }", "q", 1],
  ])(
    "%s: the module loads and exports the name",
    async (_name, statement, name, value) => {
      const loaded = await load(`${statement}${TEMPLATE}`);
      expect(loaded[name]).toBe(value);
      expect(typeof loaded.default).toBe("function");
    },
  );

  it("a client binding compiles; html drops the client block's code, so nothing is exported", async () => {
    const loaded = await load(
      `client const q = 1;\nclient export { q };${TEMPLATE}`,
    );
    expect(Object.keys(loaded)).not.toContain("q");
    expect(typeof loaded.default).toBe("function");
  });

  it("the control, one statement with its declaration, still exports", async () => {
    const loaded = await load(
      `static { const q = 1; export { q } }${TEMPLATE}`,
    );
    expect(loaded.q).toBe(1);
  });
});
