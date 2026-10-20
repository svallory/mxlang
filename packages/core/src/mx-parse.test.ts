import { describe, expect, it, vi } from "vitest";
import { coreBabel } from "./babel.ts";
import { compileSource, printExpression } from "./compile.ts";
import { type Node, newCtx, TranslateError } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { stripMxTypes } from "./mx-parse.ts";
import { lookup } from "./test-targets.ts";

/**
 * A tag-adjacent `:=` (`<div:=x/>`) is Marko's bound default value
 * (`value:=x`): a value that cannot be bound is Marko's binding error, at the
 * value, and a bindable one compiles (stock `@marko/compiler` 5.42.11 on
 * `htmljs-parser` 5.18.0, probed: `<div:=x/>`, `div:=x` and `<div:=a.b/>`
 * compile, `<div:=1/>` is the binding error at 1:7).
 */

const FILE = "/tmp/mx-core-test/bound.mx";

function policy(): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    resolveDefaultTag: () => "input",
  };
}

function viaCompile(
  source: string,
  tagRules: "html" | "none" = "html",
): unknown {
  try {
    compileSource(source, FILE, policy(), {
      targets: lookup,
      emitIr: () => "",
      ...(tagRules === "none"
        ? { dialect: { id: "loose", name: "Loose", table: {}, tagRules } }
        : {}),
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

function viaFragment(source: string): unknown {
  try {
    const ctx = newCtx(
      source,
      printExpression,
      policy(),
      undefined,
      FILE,
      lookup,
    );
    lower(ctx, parseFragment(source).body);
  } catch (error) {
    return error;
  }
  return undefined;
}

const BINDING =
  "Attributes may only be bound to identifiers or member expressions";
describe.each([
  ["compileSource", viaCompile],
  ["parseFragment + lower", viaFragment],
])("a tag-adjacent `:=` on the MX path (%s)", (_name, run) => {
  it.each([
    // A value that cannot be bound: Marko's binding error, at the value.
    ["<div:=1/>", 1, 6],
    ["div:=1", 1, 5],
    ["<div:=(1)/>", 1, 7],
  ])("%j", (source, line, column) => {
    const error = run(source);
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({ message: BINDING, line, column });
  });

  it.each(["<div:=x/>", "div:=x", "<div:=a.b/>", "<div:=(x)/>"])(
    "%j: a bindable value compiles, as in Marko",
    (source) => {
      expect(run(source)).toBeUndefined();
    },
  );

  it("an optional member is bound too", () => {
    expect(run("<div:=a?.b/>")).toBeUndefined();
  });
});

// Review round 1: Marko kept a bound value that failed to parse as its
// parse-error node, so a fragment lowered that attribute's binding check
// first; a compile reports the parse error (9293794df, both routes).
describe("a bound value that does not parse", () => {
  it.each([
    ["<div:=this.#x/>", 1, 6],
    ["div:=this.#x", 1, 5],
    ["<div :=this.#x/>", 1, 7],
    ["<div x:=this.#x/>", 1, 8],
    ["<div:=this.#x.y/>", 1, 6],
    ["<div x:=(a b)/>", 1, 8],
  ])(
    "%j through parseFragment + lower: the binding error at the value",
    (source, line, column) => {
      const error = viaFragment(source);
      expect(error).toBeInstanceOf(TranslateError);
      expect(error).toMatchObject({ message: BINDING, line, column });
    },
  );

  it.each([
    ["<div:=this.#x/>", "Private name #x is not defined.", 1, 11],
    ["div:=this.#x", "Private name #x is not defined.", 1, 10],
    ["<div x:=this.#x/>", "Private name #x is not defined.", 1, 13],
    ["<div x:=(a b)/>", 'Unexpected token, expected ","', 1, 11],
  ])(
    "%j through compileSource: Marko's parse error",
    (source, label, line, column) => {
      const error = viaCompile(source) as {
        name: string;
        label: string;
        loc: { start: { line: number; column: number } };
      };
      expect(error.name).toBe("CompileError");
      expect(error.label).toBe(label);
      expect(error.loc.start).toMatchObject({ line, column });
    },
  );

  it("an unbound value keeps its own parse error on the fragment route", () => {
    expect(viaFragment("<div x=this.#x/>")).toMatchObject({
      message: "Private name #x is not defined.",
      line: 1,
      column: 12,
    });
  });
});

const STRIP_DUPLICATE_REASON =
  "A namespace with values followed by an enum of its name in one block creates two bindings. Declare the enum first, or put the namespace's values in a namespace after an earlier enum of that name.";
const STRIP_NESTED_DUPLICATE_REASON =
  "A namespace with values followed by an enum of its name in one block creates two bindings. A namespace is only allowed at the top level of a module or of another namespace. Move the namespace there.";

/**
 * The strip is the authority: its duplicate-binding TypeError becomes a
 * positioned MX_DUPLICATE_DECLARATION; accepted forms still compile. These
 * source sites match stock 6.4.4's refusals (stock columns are 1-based).
 */
describe("a namespace with values and an enum of its name in one program", () => {
  it.each([
    [
      "an exported enum",
      "static { namespace q { export const b = 1 }; export enum q {A} }",
      57,
    ],
    [
      "a plain enum",
      "static { namespace q { export const b = 1 }; enum q {A} }",
      50,
    ],
    [
      "an enum after a namespace holding only a const enum",
      "static { namespace q { export const enum E {X} }; export enum q {A} }",
      62,
    ],
    [
      "a non-exported declare const member",
      "static { namespace q { declare const b: number }; export enum q {A} }",
      62,
    ],
    [
      "a non-exported declare class member",
      "static { namespace q { declare class C {} }; export enum q {A} }",
      57,
    ],
    [
      "a non-exported declare abstract class member",
      "static { namespace q { declare abstract class C {} }; export enum q {A} }",
      66,
    ],
    [
      "a non-exported declare enum member",
      "static { namespace q { declare enum E {X} }; export enum q {A} }",
      57,
    ],
    [
      "a non-exported declare nested namespace",
      "static { namespace q { declare namespace r { const b: number } }; export enum q {A} }",
      78,
    ],
    [
      "a declare member of a nested namespace",
      "static { namespace q { namespace r { declare const b: number } }; export enum q {A} }",
      78,
    ],
    [
      "a declare member of an exported nested namespace",
      "static { namespace q { export namespace r { declare const b: number } }; export enum q {A} }",
      85,
    ],
    [
      "a declare member of a dotted namespace",
      "static { namespace q.r { declare const b: number }; export enum q {A} }",
      64,
    ],
    [
      "a declare global member",
      "static { namespace q { declare global { var g: number } }; export enum q {A} }",
      71,
    ],
    [
      "a declare let member beside an exported type",
      "static { namespace q { declare let b: number; export type T = 1 }; export enum q {A} }",
      79,
    ],
  ])(
    "refuses %s at the enum's name, coded, not a raw strip error",
    (_name, source, column) => {
      const error = viaCompile(`${source}\n<div/>\n`) as TranslateError;
      expect(error).toMatchObject({
        diagnosticCode: "MX_DUPLICATE_DECLARATION",
        line: 1,
        column,
      });
      expect(error.message).toBe(
        `Duplicate declaration "q": it is already declared at 1:20. ${STRIP_DUPLICATE_REASON}`,
      );
    },
  );

  it.each([
    [
      "an enum–namespace–enum merge",
      "static { export enum q {A}; namespace q { export const b = 1 }; export enum q {B = 2} }",
    ],
    [
      "an enum–exported namespace–enum merge",
      "static { export enum q {A}; export namespace q { export const b = 1 }; export enum q {B = 2} }",
    ],
    ["an empty namespace", "static { namespace q {}; enum q {A} }"],
    [
      "a type-only namespace",
      "static { namespace q { export type T = 1 }; enum q {A} }",
    ],
    [
      "a declare namespace with values, then an exported enum",
      "static { declare namespace q { const b: number }; export enum q {A} }",
    ],
    [
      "a namespace of declare members, then an exported enum",
      "static { namespace q { export declare const b: number }; export enum q {A} }",
    ],
    [
      "a namespace of declare members, then a plain enum",
      "static { namespace q { export declare const b: number }; enum q {A} }",
    ],
    [
      "a namespace of a declare function, then an exported enum",
      "static { namespace q { export declare function f(): void }; export enum q {A} }",
    ],
    [
      "a namespace of a declare class, then an exported enum",
      "static { namespace q { export declare class C {} }; export enum q {A} }",
    ],
    [
      "a namespace of a declare enum, then an exported enum",
      "static { namespace q { export declare enum E {X} }; export enum q {A} }",
    ],
    [
      "a namespace of a declare namespace, then an exported enum",
      "static { namespace q { export declare namespace r { const b: number } }; export enum q {A} }",
    ],
    [
      "a namespace of only an overload signature, then an exported enum",
      "static { namespace q { export function f(): void; }; export enum q {A} }",
    ],
    [
      "a namespace of only an alias, then an exported enum",
      "static { namespace q { import y = Math; }; export enum q {A} }",
    ],
    [
      "a namespace of only an alias, then a plain enum",
      "static { namespace q { import y = Math; }; enum q {A} }",
    ],
    [
      "a namespace of only an exported alias, then an exported enum",
      "static { namespace q { export import y = Math; }; export enum q {A} }",
    ],
    [
      "a namespace of only an exported alias, then a plain enum",
      "static { namespace q { export import y = Math; }; enum q {A} }",
    ],
    [
      "a namespace of only an alias of a type-only namespace, then an exported enum",
      "static { namespace t { export type T = 1 }; namespace q { import y = t; }; export enum q {A} }",
    ],
    [
      "a namespace with values, then a declare enum",
      "static { namespace q { export const b = 1 }; export declare enum q {A} }",
    ],
    [
      "a namespace with values, then a const enum",
      "static { namespace q { export const b = 1 }; export const enum q {A} }",
    ],
  ])("an enum after %s still compiles", (_name, source) => {
    expect(viaCompile(`${source}\n<div/>\n`)).toBeUndefined();
  });

  it.each([
    [
      "function",
      "static function f() { namespace q { export const b = 1 }; enum q {A} }",
      63,
    ],
    [
      "if",
      "static if (true) { namespace q { export const b = 1 }; enum q {A} }",
      60,
    ],
  ])("positions a duplicate inside a %s body", (_name, source, column) => {
    const error = viaCompile(`${source}\n<div/>\n`) as TranslateError;
    expect(error).toMatchObject({
      diagnosticCode: "MX_DUPLICATE_DECLARATION",
      line: 1,
      column,
      end: { line: 1, column: column + 1 },
    });
    expect(error.message).toContain(STRIP_NESTED_DUPLICATE_REASON);
    expect(error.message).not.toContain("Declare the enum first");
    expect(error.message).not.toContain("module scope");
  });

  it.each(["server", "client"])(
    "keeps enum-first advice for a module-level %s block",
    (keyword) => {
      const error = viaCompile(
        `${keyword} { namespace q { export const b = 1 }; enum q {A} }\n<div/>\n`,
      ) as TranslateError;
      expect(error).toMatchObject({
        diagnosticCode: "MX_DUPLICATE_DECLARATION",
        line: 1,
        column: 50,
        end: { line: 1, column: 51 },
        message: `Duplicate declaration "q": it is already declared at 1:20. ${STRIP_DUPLICATE_REASON}`,
      });
    },
  );

  describe.each(["html", "none"] as const)(
    "strip source sites under %s",
    (tagRules) => {
      it.each([
        [
          "a trailing namespace",
          "static { namespace q { export const b = 1 }; export enum q {A}; namespace q { export const c = 2 } }",
          1,
          57,
          "1:20",
        ],
        [
          "a trailing enum",
          "static { namespace q { export const b = 1 }; export enum q {A}; export enum q {B = 2} }",
          1,
          57,
          "1:20",
        ],
        [
          "a trailing namespace in a function",
          "static function f() { namespace q { export const b = 1 }; enum q {A}; namespace q { export const c = 2 } }",
          1,
          63,
          "1:33",
          STRIP_NESTED_DUPLICATE_REASON,
        ],
        [
          "a trailing enum on another line",
          "static {\n  namespace q { export const b = 1 }\n  export enum q {A}\n  export enum q {B = 2}\n}",
          3,
          14,
          "2:13",
        ],
        [
          "an erased ambient declaration before the namespace",
          "static { declare enum q {A}; namespace q { export const b = 1 }; export enum q {B} }",
          1,
          77,
          "1:40",
        ],
        [
          "a nested ambient namespace partner",
          "static { namespace o { declare namespace q { const b: number }; enum q {A} } }",
          1,
          69,
          "1:42",
        ],
        [
          "a plain static block",
          "static { namespace q { export const b = 1 }; enum q {A} }",
          1,
          50,
          "1:20",
        ],
        [
          "a namespace body",
          "static namespace o { namespace q { export const b = 1 }; enum q {A} }",
          1,
          62,
          "1:32",
        ],
        [
          "an if body",
          "static if (true) { namespace q { export const b = 1 }; enum q {A} }",
          1,
          60,
          "1:30",
          STRIP_NESTED_DUPLICATE_REASON,
        ],
      ])(
        "blames the colliding enum despite %s",
        (_name, source, line, column, first, reason = STRIP_DUPLICATE_REASON) => {
          const error = viaCompile(
            `${source}\n<div/>\n`,
            tagRules,
          ) as TranslateError;
          expect(error).toMatchObject({
            diagnosticCode: "MX_DUPLICATE_DECLARATION",
            line,
            column,
            end: { line, column: column + 1 },
          });
          expect(error.message).toBe(
            `Duplicate declaration "q": it is already declared at ${first}. ${reason}`,
          );
        },
      );
    },
  );

  it.each([
    [
      "Z1: alias before an exported enum",
      "static { import q = Math; export enum q {A} }",
    ],
    [
      "Z2: exported enum before an alias",
      "static { export enum q {A}; import q = Math }",
    ],
    [
      "Z9: alias and enum in a function",
      "static function f() { import q = Math; enum q {A} }",
    ],
    [
      "Y11: alias before a plain enum",
      "static { import q = Math; enum q {A} }",
    ],
    [
      "Y12: plain enum before an alias",
      "static { enum q {A}; import q = Math }",
    ],
    [
      "K25: alias before an enum, namespace after",
      "static { import q = Math; export enum q {A}; export namespace q { export const b = 1 } }",
    ],
    [
      "K26: enum, alias, namespace after",
      "static { export enum q {A}; import q = Math; export namespace q { export const b = 1 } }",
    ],
    [
      "K29: enum, namespace, alias last",
      "static { export enum q {A}; export namespace q { export const b = 1 }; import q = Math }",
    ],
  ])("keeps %s as the unchanged raw strip error", (_label, source) => {
    const error = viaCompile(`${source}\n<div/>\n`);
    expect(error).toBeInstanceOf(TypeError);
    // The strip's code frame is coloured when the run has a colour mode
    // (CI, the gate), and plain under NO_COLOR: compare without escapes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
    const plain = (error as Error).message.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toBe('Duplicate declaration "q"\n> 1 |\n    | ^');
    expect(error).not.toHaveProperty("diagnosticCode");
    expect(error).not.toHaveProperty("end");
  });

  it("uses the failing block, not an earlier legal merge or a later shadow", () => {
    const source = [
      "static {",
      "  { enum q {A}; namespace q { export const b = 1 }; enum q {B = 2} }",
      "  if (true) {",
      "    namespace q { export const b = 1 }; enum q {A}",
      "  }",
      "  { const q = 1 }",
      "}",
      "<div/>",
    ].join("\n");
    const error = viaCompile(source) as TranslateError;
    expect(error).toMatchObject({
      diagnosticCode: "MX_DUPLICATE_DECLARATION",
      line: 4,
      column: 45,
      end: { line: 4, column: 46 },
    });
    expect(error.message).toContain("already declared at 4:15.");
  });

  it("positions a compileSource strip collision under none tag rules", () => {
    expect(
      viaCompile(
        "static { namespace q { export const b = 1 }; export enum q {A} }\n<div/>\n",
        "none",
      ),
    ).toMatchObject({
      diagnosticCode: "MX_DUPLICATE_DECLARATION",
      line: 1,
      column: 57,
      end: { line: 1, column: 58 },
    });
  });

  it("keeps compileSource's accepted strip form under none tag rules", () => {
    expect(
      viaCompile(
        "static { namespace q { import y = Math; }; enum q {A} }\n<div/>\n",
        "none",
      ),
    ).toBeUndefined();
  });

  it.each([
    new Error('Duplicate declaration "q"'),
    new TypeError("a different strip failure"),
    new TypeError('Duplicate declaration "q" plus something else'),
    new TypeError('Duplicate declaration "missing"'),
  ])("passes an unrelated or unlocatable strip error through: %s", (error) => {
    const babel = coreBabel();
    const original = babel.traverse;
    const traverse = vi.spyOn(babel, "traverse").mockImplementation(
      Object.assign(
        () => {
          throw error;
        },
        { visitors: original.visitors },
      ),
    );
    try {
      expect(viaCompile("static const q = 1\n<div/>\n")).toBe(error);
    } finally {
      traverse.mockRestore();
    }
  });

  it.each([
    ["a non-matching TypeError", "a different strip failure", TypeError],
    [
      "a partial duplicate TypeError",
      'Duplicate declaration "q" plus something else',
      TypeError,
    ],
    ["a matching plain Error", 'Duplicate declaration "q"', Error],
  ] as const)(
    "passes through %s built by the real hub",
    (_name, message, ErrorType) => {
      const babel = coreBabel();
      const original = babel.traverse;
      let built: Error | undefined;
      const traverse = vi.spyOn(babel, "traverse").mockImplementation(
        Object.assign(
          (_node: Node, _visitor: Node, _scope: Node, state: Node) => {
            const at = state.file.path.node.body.find(
              (node: Node) => node.type === "ExportNamedDeclaration",
            ).declaration.id;
            built = state.file.hub.buildError(at, message, ErrorType);
            throw built;
          },
          { visitors: original.visitors },
        ),
      );
      try {
        const error = viaCompile(
          "static { namespace q { export const b = 1 }; export enum q {A} }\n<div/>\n",
        );
        expect(traverse).toHaveBeenCalledOnce();
        expect(built).toBeInstanceOf(ErrorType);
        expect(built?.message.split("\n", 1)[0]).toBe(message);
        expect(error).toBe(built);
      } finally {
        traverse.mockRestore();
      }
    },
  );

  it("positions a known collision without an earlier source site", () => {
    const babel = coreBabel();
    const body = babel.parse(
      "namespace q { export const b = 1 }; export enum q {A}",
      { sourceType: "module", plugins: ["typescript"] },
    ).program.body;
    const loc = body[2].declaration.id.loc;
    babel.types.removePropertiesDeep(body[0].id);
    let error: unknown;
    try {
      stripMxTypes({
        body: [
          {
            type: "MxModuleStatement",
            keyword: "static",
            code: { type: "MxStatements", outer: "statement", node: body },
          },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({
      diagnosticCode: "MX_DUPLICATE_DECLARATION",
      line: loc.start.line,
      column: loc.start.column,
      end: { line: loc.end.line, column: loc.end.column },
      message: `Duplicate declaration "q". ${STRIP_DUPLICATE_REASON}`,
    });
  });

  it("keeps the raw error if the colliding declaration has no source position", () => {
    const babel = coreBabel();
    const body = babel.parse(
      "namespace q { export const b = 1 }; export enum q {A}",
      { sourceType: "module", plugins: ["typescript"] },
    ).program.body;
    babel.types.removePropertiesDeep(body[2].declaration.id);
    expect(() =>
      stripMxTypes({
        body: [
          {
            type: "MxModuleStatement",
            keyword: "static",
            code: { type: "MxStatements", outer: "statement", node: body },
          },
        ],
      }),
    ).toThrow(TypeError);
  });
});
