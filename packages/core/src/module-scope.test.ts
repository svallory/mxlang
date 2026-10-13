/**
 * Module level code (`static`, `server` and `client` blocks, `export`
 * statements) runs once as the template loads, so it cannot name what exists
 * only while the template renders: a tag variable, `input`, `$global`,
 * `$signal`. Core refuses it with one error positioned at the name, on
 * `lowerSource` and on the html default policy, whatever the host. A tag
 * param is not one of those names (it is only in scope inside its own tag),
 * and the `none` tag rules leave a dialect's statements alone.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { lookup } from "./test-targets.ts";

const CODE = "MX_RENDER_ONLY_IN_MODULE";

const WHERE =
  "(`static`, `server` and `client` blocks and `export` statements), which runs once as the template loads";

const reference = (name: string) =>
  `\`${name}\` exists only while the template renders, so module level code ${WHERE}, cannot reference it. Reference it in the template instead, passing it to a module level function as an argument.`;

const declaration = (name: string) =>
  `\`${name}\` is a tag variable, which exists only while the template renders, so module level code ${WHERE}, cannot declare a name with its spelling. Rename the module level binding.`;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-module-scope-")));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The diagnostics `lowerSource` returns under `tagRules`, as the check's. */
function found(source: string, tagRules: "html" | "markup" | "none" = "html") {
  return lowerSource(source, join(dir, "page.mx"), { tagRules }).diagnostics;
}

function ours(source: string, tagRules: "html" | "markup" | "none" = "html") {
  return found(source, tagRules).filter((d) => d.code === CODE);
}

/** 0-based line and column of the `nth` `needle` in `source`, and where it ends. */
function span(source: string, needle: string, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = source.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`no ${needle} #${nth} in ${source}`);
  }
  const where = (offset: number) => {
    const before = source.slice(0, offset).split("\n");
    return { line: before.length, column: before.at(-1)?.length ?? 0 };
  };
  return { start: where(at), end: where(at + needle.length) };
}

/**
 * Where the whole word `name` is in `statement`, as a `needle` for `span`: the
 * `nth` whole-word match in the source, counting from the statement's start.
 */
function wordAt(source: string, statement: string, name: string) {
  const from = source.indexOf(statement);
  const pattern = new RegExp(
    `(?<![\\w$]|(?<!\\.)\\.)${name.replace(/\$/g, "\\$")}(?![\\w$])`,
    "g",
  );
  pattern.lastIndex = 0;
  const hit = pattern.exec(statement);
  if (!hit) throw new Error(`no ${name} in ${statement}`);
  const offset = from + hit.index;
  const before = source.slice(0, offset).split("\n");
  const line = before.length;
  const column = before.at(-1)?.length ?? 0;
  return {
    line,
    column,
    end: { line, column: column + name.length },
  };
}

/** Expects exactly one error with `message`, at `needle` (the `nth` one). */
function expectAt(source: string, message: string, needle: string, nth = 0) {
  const errors = ours(source);
  const at = span(source, needle, nth);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    severity: "error",
    message,
    line: at.start.line,
    column: at.start.column,
    end: expect.objectContaining(at.end),
  });
}

/** `compileSource` on the html default policy: the error it throws, if any. */
function attempt(
  source: string,
  declarations: HostDeclarations = plainHost,
): TranslateError | undefined {
  try {
    compileSource(source, join(dir, "page.mx"), declarations, {
      targets: lookup,
      emitIr: () => "",
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

const plainHost: HostDeclarations = {
  name: "module-scope-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isBuiltinTag: (name) => name === "let",
  isDelegatedTag: (name) => name === "let",
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
};

/** The module forms, each as a statement that reads `EXPR` once. */
const FORMS: [name: string, statement: (expr: string) => string][] = [
  ["static", (e) => `static const y = ${e}`],
  ["static block", (e) => `static { const y = ${e} }`],
  ["multi-line static block", (e) => `static {\n  const y = ${e}\n}`],
  ["server", (e) => `server const y = ${e}`],
  ["client", (e) => `client const y = ${e}`],
  ["export", (e) => `export const y = ${e}`],
];

/** The render-only names: the tag that declares one, and its spelling. */
const NAMES: [kind: string, prelude: string, name: string][] = [
  ["a `<let>`", "<let/x=1/>\n", "x"],
  ["a `<const>`", "<const/x=1/>\n", "x"],
  ["a destructured `<const>`", "<const/{ a, b }=obj/>\n", "b"],
  ["a `<define>` variable", "<define/x|a|>\n  <p/>\n</define>\n", "x"],
  [
    "a tag variable nested in a body",
    "<if=true>\n  <const/x=1/>\n</if>\n",
    "x",
  ],
  ["a tag variable after the statement", "", "x"],
  ["`input`", "", "input"],
  ["`$global`", "", "$global"],
  ["`$signal`", "", "$signal"],
];

describe("module code that names a render-only name is one error at the name", () => {
  describe.each(FORMS)("%s", (_form, statement) => {
    it.each(NAMES)("%s", (kind, prelude, name) => {
      const after = kind.includes("after the statement");
      const body = statement(name);
      const source = after
        ? `${body}\n<let/x=1/>\n<p>\${y}</p>\n`
        : `${prelude}${body}\n<p>\${y}</p>\n`;
      // `<define>` is refused by `lowerSource`, so it goes through the policy.
      if (kind.includes("define")) {
        const error = attempt(source);
        const at = wordAt(source, body, name);
        expect(error?.diagnosticCode).toBe(CODE);
        expect(error?.message).toBe(reference(name));
        expect([error?.line, error?.column]).toEqual([at.line, at.column]);
        expect(error?.end).toMatchObject(at.end);
        return;
      }
      const errors = ours(source);
      const at = wordAt(source, body, name);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        severity: "error",
        message: reference(name),
        line: at.line,
        column: at.column,
        end: expect.objectContaining(at.end),
      });
    });
  });
});

describe("exact text, one per module form", () => {
  it("static", () => {
    const source = "<const/x=1/>\nstatic const y = x\n<div>${y}</div>\n";
    const [error] = ours(source);
    expect(error).toMatchObject({
      code: CODE,
      severity: "error",
      message: reference("x"),
      line: 2,
      column: 17,
      end: { line: 2, column: 18 },
    });
  });

  it("static block", () => {
    const source = "<const/x=1/>\nstatic { const y = x }\n<div/>\n";
    const [error] = ours(source);
    expect(error).toMatchObject({
      message: reference("x"),
      line: 2,
      column: 19,
      end: { line: 2, column: 20 },
    });
  });

  it("multi-line static block", () => {
    const source = "<const/x=1/>\nstatic {\n  const y = x\n}\n<div/>\n";
    const [error] = ours(source);
    expect(error).toMatchObject({
      message: reference("x"),
      line: 3,
      column: 12,
      end: { line: 3, column: 13 },
    });
  });

  it("server", () => {
    const [error] = ours("<const/x=1/>\nserver const y = x\n<div/>\n");
    expect(error).toMatchObject({
      message: reference("x"),
      line: 2,
      column: 17,
      end: { line: 2, column: 18 },
    });
  });

  it("client", () => {
    const [error] = ours("<const/x=1/>\nclient const y = x\n<div/>\n");
    expect(error).toMatchObject({
      message: reference("x"),
      line: 2,
      column: 17,
      end: { line: 2, column: 18 },
    });
  });

  it("export", () => {
    const [error] = ours("<const/x=1/>\nexport const y = x\n<div/>\n");
    expect(error).toMatchObject({
      message: reference("x"),
      line: 2,
      column: 17,
      end: { line: 2, column: 18 },
    });
  });

  it("input", () => {
    const [error] = ours("static const y = input\n<div>${y}</div>\n");
    expect(error).toMatchObject({
      message: reference("input"),
      line: 1,
      column: 17,
      end: { line: 1, column: 22 },
    });
  });

  it("the message states the rule and the fix, with no decision number", () => {
    expect(reference("x")).toMatch(/exists only while the template renders/);
    expect(reference("x")).toMatch(/Reference it in the template instead/);
    expect(reference("x")).not.toMatch(/decision|\d{3}/i);
    expect(declaration("x")).toMatch(/Rename the module level binding/);
    expect(declaration("x")).not.toMatch(/decision|\d{3}/i);
  });

  it("carries no fix: the repair is not mechanical", () => {
    const [error] = ours("static const y = input\n<div/>\n");
    expect(error?.fixes).toBeUndefined();
  });

  it("the same error comes from the html default policy", () => {
    const source = "<const/x=1/>\nstatic const y = x\n<div/>\n";
    const error = attempt(source);
    expect(error?.diagnosticCode).toBe(CODE);
    expect(error?.message).toBe(reference("x"));
    expect([error?.line, error?.column]).toEqual([2, 17]);
    expect(error?.end).toEqual({ line: 2, column: 18 });
  });

  it("the default tag rules refuse it too", () => {
    const diagnostics = lowerSource(
      "<const/x=1/>\nstatic const y = x\n<div/>\n",
      join(dir, "page.mx"),
    ).diagnostics;
    expect(diagnostics.filter((d) => d.code === CODE)).toHaveLength(1);
  });

  it("the `markup` tag rules refuse it too", () => {
    expect(
      ours("<const/x=1/>\nstatic const y = x\n<div/>\n", "markup"),
    ).toHaveLength(1);
  });
});

describe("every way module code can name the name", () => {
  const LET = "<let/x=1/>\n";
  it.each([
    ["a read", "static const y = x", "x"],
    ["a property read", "static const y = input.a", "input"],
    ["`typeof`", "static const y = typeof x", "x"],
    ["an arrow body", "static const f = () => x", "x"],
    ["a function body", "static function f() { return x }", "x"],
    [
      "`input` in a function body",
      "static function f() { return input.x }",
      "input",
    ],
    [
      "`$global` in a function body",
      "static function f() { return $global.x }",
      "$global",
    ],
    ["a shorthand property", "static const o = { x }", "x"],
    ["a property value", "static const o = { k: x }", "x"],
    ["a computed key", "static const o = { [x]: 1 }", "x"],
    ["an array element", "static const a = [x]", "x"],
    ["a call argument", "static const a = f(x)", "x"],
    ["a template literal", "static const a = `${x}`", "x"],
    ["a spread", "static const a = [...x]", "x"],
    ["a default parameter value", "static function f(a = x) {}", "x"],
    ["an `export` specifier", "export { x }", "x"],
    ["an `export` function body", "export function f() { return x }", "x"],
    ["an assignment", "static { x = 2 }", "x"],
    ["a compound assignment", "static { x += 2 }", "x"],
    ["an update", "static { x++ }", "x"],
    ["an array destructuring assignment", "static { [x] = o }", "x"],
    ["an object destructuring assignment", "static { ({ k: x } = o) }", "x"],
    ["a `for…of` head", "static { for (x of []) {} }", "x"],
    ["a class member", "static class C { m() { return x } }", "x"],
    [
      "a shadowing name in an inner function",
      "static const f = (y) => [y, x]",
      "x",
    ],
  ])("%s", (_name, statement, name) => {
    const source = `${LET}${statement}\n<div/>\n`;
    const errors = ours(source);
    const at = wordAt(source, statement, name);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: reference(name),
      line: at.line,
      column: at.column,
      end: expect.objectContaining(at.end),
    });
  });

  it("two names in one statement: the first is reported", () => {
    const source = "<let/x=1/>\n<let/z=1/>\nstatic const y = [z, x]\n<div/>\n";
    const errors = ours(source);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(reference("z"));
  });

  it("a second module statement is checked on its own", () => {
    const source =
      "<let/x=1/>\nstatic const a = 1\nstatic const b = x\n<div/>\n";
    const at = wordAt(source, "static const b = x", "x");
    expect(ours(source)[0]).toMatchObject({
      line: at.line,
      column: at.column,
    });
  });
});

describe("a module binding with the spelling of a tag variable", () => {
  it.each([
    ["an assignment", "static count = 1", "count = 1"],
    ["a `const`", "static const count = 1", "count = 1"],
    ["a `let`", "static let count = 1", "count = 1"],
    ["a destructured `const`", "static const { count } = o", "{ count } = o"],
    [
      "an array destructured `const`",
      "static const [count] = o",
      "[count] = o",
    ],
    ["a function", "static function count() {}", "function count() {}"],
    ["a class", "static class count {}", "class count {}"],
    ["a block declaration", "static { const count = 2 }", "count = 2"],
    ["a block `var`", "static { var count = 2 }", "count = 2"],
    ["an `export const`", "export const count = 1", "count = 1"],
    [
      "an `export function`",
      "export function count() {}",
      "function count() {}",
    ],
  ])("%s is refused at the declaration", (_name, statement, needle) => {
    for (const source of [
      `<let/count=0/>\n${statement}\n<div/>\n`,
      `${statement}\n<let/count=0/>\n<div/>\n`,
    ]) {
      const errors = ours(source);
      expect(errors).toHaveLength(1);
      const at = span(source, needle);
      expect(errors[0]).toMatchObject({
        message: declaration("count"),
        line: at.start.line,
        column: at.start.column,
        end: at.end,
      });
    }
  });

  it("a `<const>` is a tag variable too", () => {
    expectAt(
      "<const/count=0/>\nstatic count = 1\n<div/>\n",
      declaration("count"),
      "count = 1",
    );
  });

  it("a name declared inside a function or an inner block is not a module binding", () => {
    expect(
      ours(
        "<let/count=0/>\nstatic function f() { const count = 1; return count }\nstatic { if (true) { const count = 2 } }\n<div/>\n",
      ),
    ).toEqual([]);
  });

  it("a module binding of the spelling of a nested tag variable shadows it", () => {
    const source = `<if=true>\n  <const/x=1/>\n</if>\nstatic const x = 5\nstatic const z = x\n<div>\${z}</div>\n`;
    expect(ours(source)).toEqual([]);
  });

  it("module code that reads a module binding by that spelling is not a read of the nested tag variable", () => {
    const source = `<div>\n  <section>\n    <const/deep=1/>\n  </section>\n</div>\nstatic const z = deep\nstatic const deep = 5\n<p>\${z}</p>\n`;
    expect(ours(source)).toEqual([]);
  });

  it("a `static` assignment of the spelling of a nested tag variable declares it", () => {
    const source = `<if=true>\n  <const/x=1/>\n</if>\nstatic x = 5\nstatic const z = x\n<div/>\n`;
    expect(ours(source)).toEqual([]);
  });
});

describe("what is not a render-only name", () => {
  const LET = "<let/x=1/>\n";
  it.each([
    ["a module binding read", "static const a = 1\nstatic const b = a"],
    ["a parameter that shadows", "static function f(x) { return x }"],
    ["an arrow parameter that shadows", "static const f = (x) => x"],
    ["a local that shadows", "static function f() { const x = 2; return x }"],
    ["`input` as a parameter", "static function f(input) { return input }"],
    ["a destructured parameter", "static function f({ x }) { return x }"],
    ["a `catch` binding", "static { try {} catch (x) { log(x) } }"],
    [
      "a function expression's own name",
      "static const f = function x() { return x }",
    ],
    [
      "a class expression's own name",
      "static const C = class x { m() { return x } }",
    ],
    ["a property name", "static const o = { x: 1 }"],
    ["a member property", "static const a = o.x"],
    ["a method name", "static const o = { x() {} }"],
    ["a label", "static { x: for (;;) { break x } }"],
    ["`typeof` in a type alias", "static type T = typeof x"],
    ["a type annotation", "static let y: typeof x"],
    ["an exported type", "export type T = typeof x"],
    ["an exported interface", "export interface P { a: typeof x }"],
    [
      "the exported name of a specifier",
      "static const y = 1\nexport { y as x }",
    ],
    ["a name the template does not declare", "static const a = other"],
    ["a `server` import", 'server import { a } from "b"'],
  ])("%s", (_name, statement) => {
    const source = `${LET}${statement}\n<div/>\n`;
    expect(ours(source)).toEqual([]);
  });

  it("a read in the template", () => {
    expect(ours("<const/x=1/>\n<div>${x}</div>\n")).toEqual([]);
  });

  it("a module file with no tag variable and no implicit name", () => {
    expect(ours("static const a = 1\n<div>${a}</div>\n")).toEqual([]);
  });

  it("an `import` is not module code that reads a name", () => {
    expect(ours('<let/x=1/>\nimport { a } from "./a"\n<div/>\n')).toEqual([]);
  });

  it("a local in the template with the spelling of `input`'s property", () => {
    expect(
      ours("static const o = { input: 1 }\n<div>${o.input}</div>\n"),
    ).toEqual([]);
  });
});

describe("a tag param is not render-only for module code", () => {
  it("a module binding of the param's spelling reads as itself", () => {
    const source = `<for|item| of=[1]>\n  \${item}\n</for>\nstatic const item = 1\nstatic const z = item\n<div>\${z}</div>\n`;
    expect(ours(source)).toEqual([]);
  });

  it("a name only a param declares is a global to module code", () => {
    const source = `<for|item| of=[1]>\n  \${item}\n</for>\nstatic const z = item\n<div>\${z}</div>\n`;
    expect(ours(source)).toEqual([]);
  });

  it("a `<define>` param", () => {
    const source = `<define/Foo|a|>\n  \${a}\n</define>\nstatic const z = a\n<div/>\n`;
    expect(ours(source)).toEqual([]);
  });
});

describe("the `none` tag rules leave a dialect's statements alone", () => {
  it.each([
    "<const/x=1/>\nstatic const y = x\n<div/>\n",
    "<const/x=1/>\nexport const y = x\n<div/>\n",
    "static const y = input\n<div/>\n",
    "<const/count=1/>\nstatic count = 1\n<div/>\n",
  ])("%j", (source) => {
    expect(ours(source, "none")).toEqual([]);
  });
});

describe("a host that refuses `server` or `client` refuses it first", () => {
  const refusing = (
    kind: "error" | "unsupported",
    tag: "server" | "client",
  ): HostDeclarations => ({
    ...plainHost,
    tags: {
      [tag]:
        kind === "error"
          ? { kind, reason: `the host has no \`${tag}\` block` }
          : { kind, hint: `Write the ${tag} code elsewhere.` },
    },
  });

  it.each([
    ["error", "server"],
    ["unsupported", "server"],
    ["error", "client"],
    ["unsupported", "client"],
  ] as const)("a `%s` row for `%s`: that is the only error", (kind, tag) => {
    const source = `<const/x=1/>\n${tag} const y = x\n<div/>\n`;
    const error = attempt(source, refusing(kind, tag));
    expect(error?.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error?.line, error?.column]).toEqual([2, 0]);
    expect(error?.message).not.toContain(
      "exists only while the template renders",
    );
  });

  it("the host's other statements are still checked", () => {
    const source = "<const/x=1/>\nstatic const y = x\n<div/>\n";
    const error = attempt(source, refusing("error", "server"));
    expect(error?.diagnosticCode).toBe(CODE);
  });

  it("a tag the host refuses never declares a variable", () => {
    const declarations: HostDeclarations = {
      ...plainHost,
      isDelegatedTag: () => false,
      tags: { widget: { kind: "unsupported" } },
    };
    const error = attempt(
      "<widget/x=1/>\nstatic const y = x\n<div/>\n",
      declarations,
    );
    expect(error?.diagnosticCode).not.toBe(CODE);
  });
});
