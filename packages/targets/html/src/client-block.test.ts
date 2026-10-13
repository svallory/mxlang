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

describe("html: the strict policy still refuses a `client` block", () => {
  it("names the construct", () => {
    expect(() =>
      compile("client { let q = 1 }\n<div/>\n", "/f/t.mx", { strict: true }),
    ).toThrow(/`client` block is client-only/);
  });
});
