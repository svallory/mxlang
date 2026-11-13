// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A `client { … }` block never runs on the server, but stock Marko 6.4.4 still
 * declares the names the block declares there: `var q;`, no initializer, so a
 * template that reads one sees `undefined` instead of a ReferenceError. Every
 * expectation below is what stock Marko's server module emits for the same
 * source (probed with `stockMarkoCompile` in `packages/stock-marko`; the
 * `client-block-hoisted` fixture in `fixtures-marko` locks the render).
 */
import { describe, expect, it } from "vitest";
import { compile, mx } from "./index.ts";

/** The hoisted module code: what sits between the runtime import and `export interface Input`. */
function hoisted(source: string): string {
  const { code } = compile(source, "/f/t.mx");
  const from = code.indexOf("\n", code.indexOf("@mxlang/target-html")) + 1;
  return code.slice(from, code.indexOf("export interface Input")).trim();
}

const TEMPLATE = "\n<div>hi</div>\n";

describe("html: a `client` block declares its own top-level names, without initializers", () => {
  it.each([
    ["let", "client { let q = 1 }", "var q;"],
    ["const", "client { const q = 1 }", "var q;"],
    ["function", "client { function f() { return 1 } }", "var f;"],
    ["class", "client { class C {} }", "var C;"],
    [
      "async and generator functions",
      "client { async function a() {} function* g() {} }",
      "var a, g;",
    ],
    [
      "several declarators and a var",
      "client { let a = 1, b; var c = 3 }",
      "var a, b, c;",
    ],
    [
      "a destructuring pattern",
      "client { let { x, y: [z] } = obj }",
      "var x, z;",
    ],
    [
      "defaults, rests and holes",
      "client { let [a, , ...b] = c }",
      "var a, b;",
    ],
    ["a typed declarator", "client { let x: number = 1 }", "var x;"],
    ["a repeated var", "client { var a; var a }", "var a;"],
    ["the non-block form: let", "client let q = 1;", "var q;"],
    ["the non-block form: function", "client function f() {}", "var f;"],
    ["a body on the next line", "client\n  const x = 1", "var x;"],
    ["a comment after the block", "client { let q = 1 } // trail", "var q;"],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("emits no initializer and none of the block's code", () => {
    const { code } = compile(
      "client { let q = expensive(); console.log(q) }\n<div>hi</div>\n",
      "/f/t.mx",
    );
    expect(code).not.toContain("expensive");
    expect(code).not.toContain("console.log");
    expect(code).toContain("var q;");
  });

  it.each([
    [
      "nested blocks, var included",
      "client { if (true) { let q = 1; var r = 2 } { let s = 3 } }",
    ],
    ["a for loop's own binding", "client { for (let i = 0; i < 1; i++) {} }"],
    [
      "a try body and catch parameter",
      "client { try { let t } catch (e) { let c } }",
    ],
    ["an expression statement", "client { console.log(1) }"],
    ["an empty block", "client {}"],
    ["only a comment", "client { /* only */ }"],
    ["types", "client { type T = 1; interface I {} }"],
    ["an ambient declaration", "client { declare const d: number }"],
  ])("declares nothing for %s", (_name, statement) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe("");
  });

  it("a function's parameters are not declared", () => {
    expect(hoisted(`client { function f(p) {} }${TEMPLATE}`)).toBe("var f;");
  });

  it("for-in and for-of declare their left-hand binding, a label its name", () => {
    expect(hoisted(`client { for (const k of ks) {} }${TEMPLATE}`)).toBe(
      "var k;",
    );
    expect(hoisted(`client { for (var k in o) {} }${TEMPLATE}`)).toBe("var k;");
    expect(hoisted(`client { lbl: for (;;) { break lbl } }${TEMPLATE}`)).toBe(
      "var lbl;",
    );
  });

  it.each([
    [
      "a for-of head",
      "server const x = 1;\nclient for (const x of [2]) {}\n<div>${x}</div>",
      "const x = 1;",
      "<div>1</div>",
    ],
    [
      "a label",
      "server const x = 1;\nclient x: for (;;) { break x }\n<div>${x}</div>",
      "const x = 1;",
      "<div>1</div>",
    ],
  ])(
    "a client name a `server` statement declares gets no `var` (%s)",
    (_name, source, module, html) => {
      expect(hoisted(source)).toBe(module);
      expect(String(mx(source)({}))).toBe(html);
    },
  );

  it("a `static` label does not stand for a client name's `var`", () => {
    // A plain read of `x` throws a ReferenceError unless the `var` is there.
    const source =
      "static x: for (;;) { break x }\nclient var x = 1;\n<div>${x === undefined}</div>";
    expect(hoisted(source)).toBe("x: for (;;) { break x }\nvar x;");
    expect(String(mx(source)({}))).toBe("<div>true</div>");
  });

  it("orders names the way Marko does: functions and classes before declarators, pattern members last", () => {
    expect(hoisted(`client { let a = 1; function f() {} }${TEMPLATE}`)).toBe(
      "var f, a;",
    );
    expect(
      hoisted(
        `client { let {x, y: [z]} = o, w = 1; function f() {} class K {} var v }${TEMPLATE}`,
      ),
    ).toBe("var f, K, w, v, x, z;");
    expect(
      hoisted(`client { let [a, ...b] = c; let {d = 1, ...e} = f }${TEMPLATE}`),
    ).toBe("var a, b, e, d;");
    expect(
      hoisted(
        `client { let {a: {b}, c: [d = 1]} = o; let [,,e] = p }${TEMPLATE}`,
      ),
    ).toBe("var e, b, d;");
  });
});

describe("html: a `client` block keeps its place among the module's statements", () => {
  it("one `var` per client statement, in source order", () => {
    expect(
      hoisted(`client { let a = 1 }\nclient { let b = 2 }${TEMPLATE}`),
    ).toBe("var a;\nvar b;");
  });

  it("follows a `static` statement written before it", () => {
    expect(
      hoisted(`static const s = 1;\nclient { let q = s }${TEMPLATE}`),
    ).toBe("const s = 1;\nvar q;");
  });

  it("precedes a `static` statement written after it", () => {
    expect(
      hoisted(`client { let q = 1 }\nstatic const s = 2;${TEMPLATE}`),
    ).toBe("var q;\nconst s = 2;");
  });

  it("interleaves with `static` and `server` blocks as written", () => {
    expect(
      hoisted(
        `static { let s1 = 1 }\nclient { let c1 = 1 }\nserver { let v1 = 1 }\nstatic { let s2 = 2 }\nclient { let c2 = 1 }${TEMPLATE}`,
      ),
    ).toBe("let s1 = 1\nvar c1;\nlet v1 = 1\nlet s2 = 2\nvar c2;");
  });

  it("a `server` block before a `static` one now keeps that order too", () => {
    expect(
      hoisted(`server { let v = 1 }\nstatic { let s = 2 }${TEMPLATE}`),
    ).toBe("let v = 1\nlet s = 2");
  });
});

describe("html: a template reads a name a `client` block declares", () => {
  const render = (source: string, input: Record<string, unknown> = {}) =>
    String(mx(source)(input));

  it("`typeof q` renders undefined", () => {
    expect(render("client { let q = 1 }\n<div>${typeof q}</div>\n")).toBe(
      "<div>undefined</div>",
    );
  });

  it("a plain read renders nothing and does not throw a ReferenceError", () => {
    expect(render("client { let q = 1 }\n<div>[${q}]</div>\n")).toBe(
      "<div>[]</div>",
    );
  });

  it("the initializer never runs on the server", () => {
    expect(
      render(
        "static let calls = 0;\nclient { let q = (calls = 1) }\n<div>${calls}${q}</div>\n",
      ),
    ).toBe("<div>0</div>");
  });

  it("a destructured, function and class name read as undefined", () => {
    expect(
      render(
        "client { let { x } = obj; function f() {} class C {} }\n<div>${typeof x}${typeof f}${typeof C}</div>\n",
      ),
    ).toBe("<div>undefinedundefinedundefined</div>");
  });
});

describe("html: the non-block `client import` and `client export` declare their names", () => {
  it.each([
    ["a default import", 'client import x from "./x";', "var x;"],
    [
      "default and named imports, renamed",
      'client import x, { y as z } from "./x";',
      "var x, z;",
    ],
    ["a namespace import", 'client import * as ns from "./x";', "var ns;"],
    ["an exported const", "client export const y = 1;", "var y;"],
    ["an exported function", "client export function g() {}", "var g;"],
    [
      "an exported namespace",
      "client export namespace N { export const a = 1 }",
      "var N;",
    ],
    ["a type-only import", 'client import type { T } from "./t";', ""],
    [
      "a type-only specifier beside a value one",
      'client import { type T, u } from "./t";',
      "var u;",
    ],
    ["a type-only default import", 'client import type D from "./t";', ""],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("a template reads the imported and exported names as undefined", () => {
    expect(
      String(
        mx(
          'client import x from "./x";\nclient export const y = 1;\n<div>[${x}][${y}]</div>\n',
        )({}),
      ),
    ).toBe("<div>[][]</div>");
  });
});

describe("html: a `client` enum declares its name the way stock Marko does", () => {
  // Stock Marko 6.4.4 (`stockMarkoCompile`, source followed by a template that
  // reads `E`): an exported enum, `const` included, is kept as `var E = …` and
  // declares `E`; an unexported `const enum` is inlined and removed, so it
  // declares nothing; a `declare` enum declares nothing. An unexported plain
  // `enum` crashes stock ("Unexpected enum parent 'MarkoScriptlet'") and is the
  // one row below that MX compiles as the exported form (divergences.md).
  it.each([
    ["an exported enum", "client export enum E { A }", "var E;"],
    ["an exported const enum", "client export const enum E { A }", "var E;"],
    [
      "a block with an exported enum",
      "client { export enum E { A } }",
      "var E;",
    ],
    [
      "a block with an exported const enum",
      "client { export const enum E { A } }",
      "var E;",
    ],
    [
      "several exported enums",
      "client { export enum E { A } export enum F { B } }",
      "var E, F;",
    ],
    [
      "an enum beside a let",
      "client { let q = 1; export enum E { A } }",
      "var q, E;",
    ],
    [
      "an enum among functions, classes and exports",
      "client { export enum E { A }; export const x = 1; class C {} function f() {} }",
      "var C, f, E, x;",
    ],
    ["an exported declare enum", "client export declare enum E { A }", ""],
    [
      "an exported declare const enum",
      "client { export declare const enum E { A } }",
      "",
    ],
    ["a declare enum", "client declare enum E { A }", ""],
    ["a declare const enum", "client { declare const enum E { A } }", ""],
    ["an unexported const enum", "client const enum E { A }", ""],
    [
      "a block with an unexported const enum",
      "client { const enum E { A } }",
      "",
    ],
    [
      "an unexported const enum named by an export list",
      "client { const enum E { A }; export { E } }",
      "",
    ],
    // Stock crashes on these two; MX declares the name, as for the exported form.
    ["an unexported enum (stock crashes)", "client enum E { A }", "var E;"],
    [
      "a block with an unexported enum (stock crashes)",
      "client { enum E { A } }",
      "var E;",
    ],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("`static enum` and `server enum` keep the enum", () => {
    expect(hoisted(`static export enum E { A }${TEMPLATE}`)).toBe(
      "export enum E { A }",
    );
    expect(hoisted(`server export enum E { A }${TEMPLATE}`)).toBe(
      "export enum E { A }",
    );
  });

  const render = (source: string) => String(mx(source)({}));

  it("a template reads a declared enum name as undefined", () => {
    for (const statement of [
      "client export enum E { A }",
      "client export const enum E { A }",
      "client { export enum E { A } }",
      "client enum E { A }",
    ]) {
      expect(render(`${statement}\n<div>${"${typeof E}"}</div>\n`)).toBe(
        "<div>undefined</div>",
      );
      expect(render(`${statement}\n<div>[${"${E}"}]</div>\n`)).toBe(
        "<div>[]</div>",
      );
    }
  });

  it("an unexported const enum declares nothing: `typeof` is fine, a plain read throws, as on stock", () => {
    const statement = "client const enum E { A }";
    expect(render(`${statement}\n<div>${"${typeof E}"}</div>\n`)).toBe(
      "<div>undefined</div>",
    );
    expect(() => render(`${statement}\n<div>[${"${E}"}]</div>\n`)).toThrow(
      ReferenceError,
    );
  });
});

describe("html: an unexported const enum's member reads are inlined, as stock Marko does", () => {
  const render = (source: string) => String(mx(source)({}));

  it.each([
    ["a dot read", "client const enum E { A }", "${E.A}", "0"],
    ["a string-key read", "client const enum E { A = 7 }", '${E["A"]}', "7"],
    ["a block", "client { const enum E { A, B } }", "${E.B}", "1"],
    ["a string member", 'client const enum E { A = "a-1" }', "${E.A}", "a-1"],
    [
      "a computed member",
      "client const enum E { A = 2, B = A * 3 + 1 }",
      "${E.B}",
      "7",
    ],
    ["a static enum", "static const enum E { A = 5 }", "${E.A}", "5"],
    ["a server enum", "server const enum E { A = 5 }", "${E.A}", "5"],
  ])("%s", (_name, statement, read, expected) => {
    expect(render(`${statement}\n<div>${read}</div>\n`)).toBe(
      `<div>${expected}</div>`,
    );
  });

  it("a static const enum is removed: `typeof E` is `undefined`, as on stock", () => {
    expect(render("static const enum E { A }\n<div>${typeof E}</div>\n")).toBe(
      "<div>undefined</div>",
    );
  });

  it("an exported const enum keeps its declaration", () => {
    const { code } = compile(
      "static export const enum E { A }\n<div>${E.A}</div>\n",
      "/f/t.mx",
    );
    expect(code).toContain("export const enum E");
  });

  it("the type-check projection keeps the enum for tsc", () => {
    const { code } = compile(
      "static const enum E { A }\n<div>${E.A}</div>\n",
      "/f/t.mx",
      { typeCheck: true },
    );
    expect(code).toContain("const enum E");
    expect(code).toContain("E.A");
  });
});

describe("html: the statement text parses the way Marko's does", () => {
  it("a top-level `return` still declares the names", () => {
    expect(hoisted(`client { let q = 1; return }${TEMPLATE}`)).toBe("var q;");
    expect(
      String(mx("client { let q = 1; return }\n<div>[${q}]</div>\n")({})),
    ).toBe("<div>[]</div>");
  });

  it("a class declares its name; a decorated one is refused, as Marko does", () => {
    expect(hoisted(`client { let q = 1; class K {} }${TEMPLATE}`)).toBe(
      "var K, q;",
    );
    expect(() =>
      hoisted(`client { let q = 1; @dec class K {} }${TEMPLATE}`),
    ).toThrow(/^Decorators are not read inside a `client` statement/);
  });
});

describe("html: a hoisted statement is not joined to the next one by ASI", () => {
  const render = (source: string) => String(mx(source)({}));

  it("a `server` statement before a `static` starting with `(`", () => {
    expect(
      render(
        [
          "static let log = [];",
          'static const a = (x) => { log.push("called"); return () => 0 };',
          "server { let x = a }",
          'static (() => { log.push("iife") })();',
          '<div>${log.join(",")}</div>',
        ].join("\n"),
      ),
    ).toBe("<div>iife</div>");
  });

  it("a `server` statement before a `static` starting with `[`", () => {
    expect(
      render(
        [
          "static let log = [];",
          "server let x = 1",
          'static [1].forEach(() => log.push("each"));',
          '<div>${log.join(",")}</div>',
        ].join("\n"),
      ),
    ).toBe("<div>each</div>");
  });

  it("a trailing comment ending in `;` does not stand in for the terminator", () => {
    expect(
      render(
        [
          "static let log = [];",
          'static const a = (x) => { log.push("called"); return () => 0 };',
          "server let x = a // note;",
          'static (() => { log.push("iife") })();',
          '<div>${log.join(",")}</div>',
        ].join("\n"),
      ),
    ).toBe("<div>iife</div>");
  });

  it("a trailing comment cannot swallow the terminator", () => {
    expect(
      render(
        [
          "static let log = [];",
          "server let x = 1 // note",
          'static (() => { log.push("iife") })();',
          '<div>${log.join(",")}</div>',
        ].join("\n"),
      ),
    ).toBe("<div>iife</div>");
  });
});

describe("html: the strict policy still refuses a `client` block", () => {
  it("names the construct", () => {
    expect(() =>
      compile("client { let q = 1 }\n<div/>\n", "/f/t.mx", { strict: true }),
    ).toThrow(/`client` block is client-only/);
  });
});

describe("html: the type-check projection of a `client` or `server` statement", () => {
  const spanOf = (
    result: ReturnType<typeof compile>,
    source: string,
    text: string,
  ) => {
    const sourceStart = source.indexOf(text);
    const generatedStart = result.code.indexOf(text);
    return {
      sourceStart,
      sourceEnd: sourceStart + text.length,
      generatedStart,
      generatedEnd: generatedStart + text.length,
    };
  };

  it("keeps the `client` statement's own code, mapped, under typeCheck", () => {
    const source = 'client const a: number = "x";\n<div/>\n';
    const checked = compile(source, "/f/t.mx", { typeCheck: true });
    const code = 'const a: number = "x";';
    expect(checked.code).toContain(code);
    expect(checked.code).not.toContain("var a;");
    expect(checked.mappings).toContainEqual(spanOf(checked, source, code));
  });

  it("leaves the module that runs alone: `var <names>;`, no initializer", () => {
    const source = 'client const a: number = "x";\n<div/>\n';
    const { code, mappings } = compile(source, "/f/t.mx");
    expect(code).toContain("var a;");
    expect(code).not.toContain('"x"');
    expect(mappings).toEqual([]);
  });

  it("maps a `server` statement's code in both modes, and runs it the same", () => {
    const source = "server const a: number = 1;\n<div>${a}</div>\n";
    const code = "const a: number = 1;";
    for (const typeCheck of [false, true]) {
      const result = compile(source, "/f/t.mx", { typeCheck });
      expect(result.mappings).toContainEqual(spanOf(result, source, code));
    }
    // The same module, apart from the type-check module's reserved export.
    expect(compile(source, "/f/t.mx").code).toBe(
      compile(source, "/f/t.mx", { typeCheck: true }).code.replace(
        /(;\n)?\/\/ @ts-ignore\nimport \* as __mxSelf[\s\S]*?\n}\n/,
        "",
      ),
    );
  });

  it("maps a block's statements, braces left out, and keeps the statement order", () => {
    const source =
      "server {\n  const a = 1;\n}\nstatic const b = 2;\nclient const c = 3;\n<div/>\n";
    const checked = compile(source, "/f/t.mx", { typeCheck: true });
    expect(checked.mappings).toContainEqual(
      spanOf(checked, source, "const a = 1;"),
    );
    const order = ["const a = 1;", "const b = 2;", "const c = 3;"].map((text) =>
      checked.code.indexOf(text),
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(order.every((at) => at >= 0)).toBe(true);
  });

  it("a `client` statement with no declared name adds nothing at run time and is projected under typeCheck", () => {
    const source = "client console.log(1)\n<div/>\n";
    expect(compile(source, "/f/t.mx").code).not.toContain("console.log");
    expect(compile(source, "/f/t.mx", { typeCheck: true }).code).toContain(
      "console.log(1)",
    );
  });
});

/**
 * Under `typeCheck` (the tooling projection, never the module that runs) the
 * module is the server view: a client name is `undefined`, none is exported,
 * and the client code is typed in a function `__mxClientView.__mxScope` calls
 * where the last `client` statement stands.
 */
describe("html typeCheck: the server view and the client code of a `client` statement", () => {
  const project = (source: string) =>
    compile(source, "/f/t.mx", { typeCheck: true });
  const wrapper = (code: string) =>
    code.slice(
      code.indexOf("(async function (this: void) {"),
      code.indexOf("})();") + "})();".length,
    );
  const beforeWrapper = (code: string) =>
    code.slice(0, code.indexOf("(async function (this: void) {"));

  it("leaves out `var q: undefined` for a name a static `var` already declares", () => {
    const { code } = project("static var q = 1\nclient var q = 2\n<div/>\n");
    expect(beforeWrapper(code)).toContain("var q = 1");
    expect(beforeWrapper(code)).not.toContain("var q: undefined");
  });

  it("declares each name `undefined` and types the client code in a function", () => {
    const { code } = project("client let q = 1;\n<div>${q}</div>\n");
    expect(code).toContain("var q: undefined; void [q];");
    expect(wrapper(code)).toBe(
      "(async function (this: void) {\n    let q = 1;\n  })();",
    );
  });

  it("is the same module without `typeCheck`: only the `var`", () => {
    const { code } = compile("client let q = 1;\n<div/>\n", "/f/t.mx");
    expect(code).toContain("var q;");
    expect(code).not.toContain("(async function (this: void) {");
    expect(code).not.toContain("undefined");
  });

  it("holds every export, client ones too, in the reserved `__mxClientExports`; the running module has none", () => {
    const source =
      "client export const x = 1;\nclient export class C {}\nstatic export const stx = 3;\n<div/>\n";
    expect(project(source).code).toContain(
      [
        "// @ts-ignore",
        'import * as __mxSelf from "./t.mx";',
        "export declare namespace __mxClientExports {",
        "  export import stx = __mxSelf.stx;",
        "  export import Input = __mxSelf.Input;",
        "  export import render = __mxSelf.render;",
        '  export const x: Awaited<typeof __mxClientView.__mxScope>["x"];',
        '  export const C: Awaited<typeof __mxClientView.__mxScope>["C"];',
        "  export type C = __MxInstance<typeof C>;",
        "}",
      ].join("\n"),
    );
    const { code } = compile(source, "/f/t.mx");
    expect(code).not.toContain("__mxClientExports");
    expect(code).not.toContain("__mxSelf");
  });

  it("leaves a string-named export out of the reserved export: a member cannot carry it", () => {
    const { code } = project(
      'static const a = 1;\nstatic export { a as "my-name" };\nclient const b = 2;\nclient export { b as "x-y" };\n<div/>\n',
    );
    expect(code).toContain("export declare namespace __mxClientExports {");
    expect(code).not.toContain("my-name =");
    expect(code).not.toContain("const x-y");
  });

  it("keeps a client export out of the module's exports", () => {
    const { code } = project(
      "client export const x = 1;\nclient export function f() {}\n<div/>\n",
    );
    expect(code).not.toMatch(/^export (const x|function f)/m);
    expect(code).toContain("var x: undefined; void [x];");
    expect(code).toContain("var f: undefined; void [f];");
    expect(wrapper(code)).toContain("const x = 1;");
    expect(wrapper(code)).toContain("function f() {};");
    // Read once, so `noUnusedLocals` does not flag a name the author exports.
    expect(wrapper(code)).toContain("void [x];");
    expect(wrapper(code)).toContain("void [f];");
  });

  it("reads a listed name once at the end of the function, and an exported const enum as a type", () => {
    const { code } = project(
      "client export { a, b as c };\nclient const a = 1;\nclient let b = 2;\nclient export const enum CE { A }\n<div/>\n",
    );
    const inside = wrapper(code);
    expect(inside).toContain("void (null as unknown as [CE]);");
    expect(inside).not.toContain("void [CE]");
    // Last, after the declarations the list names (an export list is hoisted).
    expect(inside.indexOf("void [a, b];")).toBeGreaterThan(
      inside.indexOf("let b = 2;"),
    );
    // A name no client statement declares (here a `static` one) is not read.
    expect(
      wrapper(
        project(
          "static const s = 1;\nclient export { s };\nclient const a = 1;\n<div/>\n",
        ).code,
      ),
    ).not.toContain("void [s]");
  });

  it("moves a value import into the client view, keeps a type at module level, and declares the import `undefined`", () => {
    const { code } = project(
      'client import { a } from "./a.ts";\nclient interface P { n: number }\nclient const b = a;\n<div/>\n',
    );
    const before = beforeWrapper(code);
    const name = before.match(
      /import \* as (__mxClient\d+_0) from "\.\/a\.ts";/,
    )?.[1];
    expect(name).toBeDefined();
    expect(before).not.toContain('import { a } from "./a.ts"');
    expect(before).toContain("interface P { n: number }");
    expect(before).toContain("var a: undefined; void [a];");
    expect(before).toContain("var b: undefined; void [b];");
    expect(before).toContain(
      `namespace __mxClientView {\n  // @ts-ignore\n  import\n    a = ${name}.a;`,
    );
    expect(wrapper(code)).toContain("const b = a;");
    expect(wrapper(code)).not.toContain("import");
  });

  it("names a top-level `return` after the module, and not one inside a function", () => {
    const top = project("client { return; }\n<div/>\n").code;
    expect(top).toMatch(/export \{ __mxRender as render \};\nreturn;\n/);
    const nested = project(
      "client { const f = () => { return 1 }; }\n<div/>\n",
    ).code;
    expect(nested).not.toMatch(/render \};\nreturn;/);
  });

  it("maps every piece of client code to the text the author wrote", () => {
    const source = [
      'client import { a } from "./a.ts";',
      "client interface P { n: number }",
      "client export const x = 1,",
      "  y = 2;",
      "client {",
      "  let z = a;",
      "  if (z) return;",
      "}",
      "<div/>",
      "",
    ].join("\n");
    const { code, mappings } = project(source);
    expect(mappings.length).toBeGreaterThan(0);
    for (const mapping of mappings) {
      expect(
        code.slice(mapping.generatedStart, mapping.generatedEnd),
        JSON.stringify(mapping),
      ).toBe(source.slice(mapping.sourceStart, mapping.sourceEnd));
    }
    for (const text of [
      // A value import's module specifier, and its name, as the alias's.
      '"./a.ts"',
      "a",
      "interface P { n: number }",
      "const x = 1,\n  y = 2;",
      "let z = a;",
    ]) {
      expect(
        mappings.some(
          (mapping) =>
            source.slice(mapping.sourceStart, mapping.sourceEnd) === text &&
            code.slice(mapping.generatedStart, mapping.generatedEnd) === text,
        ),
        text,
      ).toBe(true);
    }
    // The `return` stands in the module once more, mapped to the keyword.
    expect(
      mappings.filter(
        (mapping) =>
          source.slice(mapping.sourceStart, mapping.sourceEnd) === "return",
      ),
    ).toHaveLength(1);
  });

  it("keeps `export` on a type and drops it from a value", () => {
    const { code } = project(
      "client export interface P { n: number }\nclient export type K = keyof P;\nclient export const v = 1;\n<div/>\n",
    );
    const before = beforeWrapper(code);
    expect(before).toContain("export interface P { n: number }");
    expect(before).toContain("export type K = keyof P;");
    expect(before).not.toMatch(/export (const|var) v/);
    expect(wrapper(code)).toContain("const v = 1;");
  });

  it("keeps an `export type { P }` list of a type", () => {
    const { code } = project(
      "client interface P { n: number }\nclient export type { P };\n<div/>\n",
    );
    expect(beforeWrapper(code)).toContain("export type { P };");
  });

  it("keeps a type at module level unless it mentions a client value", () => {
    const { code } = project(
      [
        "client class C {}",
        "client interface P { c: C }",
        "client interface Q { n: number }",
        "client const cfg = { a: 1 };",
        "client type Cfg = typeof cfg;",
        "client type Wrapped = { p: P };",
        "client interface R { n: number; cfg: number }",
        "<div/>",
        "",
      ].join("\n"),
    );
    const before = beforeWrapper(code);
    const inside = wrapper(code);
    // Names a client class, a client value, and (in turn) a type that did.
    for (const moved of [
      "interface P { c: C }",
      "type Cfg = typeof cfg;",
      "type Wrapped = { p: P };",
    ]) {
      expect(inside, moved).toContain(moved);
      expect(before, moved).not.toContain(moved);
    }
    // A property named like a client value is not a mention of it.
    for (const stays of ["interface Q { n: number }", "interface R {"]) {
      expect(before, stays).toContain(stays);
      expect(inside, stays).not.toContain(stays);
    }
  });

  it("calls the client code where the last client statement stands, among the statics", () => {
    const { code } = project(
      "client const z = st + 1;\nstatic const st = 1;\nclient const y = 2;\nstatic const after = 3;\n<div/>\n",
    );
    const at = (text: string) => code.indexOf(text);
    expect(at("(async function (this: void) {")).toBeGreaterThan(
      at("const st = 1"),
    );
    expect(at("(async function (this: void) {")).toBeLessThan(
      at("const after = 3"),
    );
    expect(wrapper(code)).toContain("const z = st + 1;");
    expect(wrapper(code)).toContain("const y = 2;");
  });

  it("projects `export … from` as imports nothing reads, mapped piece by piece", () => {
    const source =
      'client export { one as uno, type T } from "./one.ts";\nclient export * from "./two.ts";\nclient export * as ns from "./three.ts";\n<div/>\n';
    const { code, mappings } = project(source);
    const before = beforeWrapper(code);
    expect(before).toMatch(
      /import \{ one as _mxReexport\d+_0_100, type T as _mxReexport\d+_0_101 \} from "\.\/one\.ts";/,
    );
    expect(before).toMatch(
      /import \* as _mxReexport\d+_0_0 from "\.\/two\.ts";/,
    );
    expect(before).toMatch(
      /import \* as _mxReexport\d+_0_1 from "\.\/three\.ts";/,
    );
    expect(code).not.toMatch(/export (\{ one|\* from)/);
    for (const mapping of mappings) {
      expect(
        code.slice(mapping.generatedStart, mapping.generatedEnd),
        JSON.stringify(mapping),
      ).toBe(source.slice(mapping.sourceStart, mapping.sourceEnd));
    }
    for (const text of [
      "one",
      "T",
      '"./one.ts"',
      '"./two.ts"',
      '"./three.ts"',
    ]) {
      expect(
        mappings.some(
          (mapping) =>
            source.slice(mapping.sourceStart, mapping.sourceEnd) === text &&
            code.slice(mapping.generatedStart, mapping.generatedEnd) === text,
        ),
        text,
      ).toBe(true);
    }
  });

  it("does not take a parameter, key, own type parameter or qualified name for a mention", () => {
    const { code } = project(
      [
        "client let value = 0;",
        "client const items = [1];",
        'client const key = "a";',
        "client const T = 1;",
        "client const Event = 1;",
        "client type Handler = (value: number) => void;",
        "client interface Api { load(items: number[]): void }",
        "client interface Bag { [key: string]: number }",
        "client type Box<T> = { v: T };",
        "client type H = (e: globalThis.Event) => void;",
        "<div/>",
        "",
      ].join("\n"),
    );
    const before = beforeWrapper(code);
    for (const stays of [
      "type Handler",
      "interface Api",
      "interface Bag",
      "type Box<T>",
      "type H =",
    ]) {
      expect(before, stays).toContain(stays);
      expect(wrapper(code), stays).not.toContain(stays);
    }
  });

  it("moves a computed key's name, a heritage clause and a qualified root into the client scope", () => {
    const { code } = project(
      [
        'client const k = "a";',
        "client class A {}",
        "client const ns = { T: 1 };",
        "client interface I { [k]: number }",
        "client interface J extends A {}",
        "client type Q = typeof ns.T;",
        "<div/>",
        "",
      ].join("\n"),
    );
    for (const moved of ["interface I", "interface J", "type Q"]) {
      expect(wrapper(code), moved).toContain(moved);
      expect(beforeWrapper(code), moved).not.toContain(moved);
    }
  });

  it("reads a moved exported type once, and leaves it out of the `export type` list", () => {
    const { code } = project(
      [
        "client class C {}",
        "client export interface P<T, U> { c: C; t: T; u: U }",
        "client interface Q { c: C }",
        "client interface R { n: number }",
        "client export type { Q, R };",
        "<div/>",
        "",
      ].join("\n"),
    );
    expect(wrapper(code)).toContain("void (null as unknown as [P<any, any>]);");
    expect(wrapper(code)).toContain("void (null as unknown as [Q]);");
    expect(wrapper(code)).not.toContain("[R]");
    expect(beforeWrapper(code)).toContain("export type { R };");
    expect(beforeWrapper(code)).not.toMatch(/export type \{[^}]*Q/);
  });
});

describe("html: a `client` name the module already declares is not declared again", () => {
  // `function q(){}` beside `var q;` is TS2300; stock Marko 6.4.4 compiles it.
  it("a static function and a client namespace of one name keep the function only", () => {
    expect(
      hoisted(
        `static function q() {}\nclient export namespace q { export const a = 1 }${TEMPLATE}`,
      ),
    ).toBe("function q() {}");
  });

  it("a type-only static namespace declares no run-time name, so the client `var` stays", () => {
    expect(
      hoisted(
        `static namespace q { export type T = 1 }\nclient export function q() {}${TEMPLATE}`,
      ),
    ).toBe("namespace q { export type T = 1 }\nvar q;");
  });

  it("a client function and a client namespace declare the name once", () => {
    expect(
      hoisted(
        `client export function q() {}\nclient export namespace q { export const a = 1 }${TEMPLATE}`,
      ),
    ).toBe("var q;");
  });
});
