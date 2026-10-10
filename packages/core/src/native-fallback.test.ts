// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX messages and sources use `${...}` placeholders.

// A target that declares no `nativeTags` (a third-party target written before
// decision 197) still parses and lowers HTML's void, raw-text and
// preserved-whitespace elements: core's tag table falls back to core's own
// HTML elements, the same void names lowering already uses, so the parse and
// the IR agree.
import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import { type MxWarning, newCtx } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { Ir, IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

const thirdParty: HostDeclarations = {
  name: "third-party-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  resolveAttributeMethod: () => true,
};

function irOf(source: string, declarations = thirdParty): Ir {
  let captured: Ir | undefined;
  compileSource(source, "/tmp/native-fallback.mx", declarations, {
    targets: lookup,
    emitIr: (ir) => {
      captured = ir;
      return "";
    },
  });
  if (!captured) throw new Error("no IR captured");
  return captured;
}

type Shape =
  | { element: string; void?: true; children: Shape[] }
  | { text: string };

function shape(nodes: readonly IrNode[]): Shape[] {
  const out: Shape[] = [];
  for (const node of nodes) {
    if (node.kind === "Element")
      out.push({
        element: node.name,
        ...(node.void ? { void: true as const } : {}),
        children: shape(node.children),
      });
    else if (node.kind === "Text") out.push({ text: node.value });
  }
  return out;
}

const body = (source: string, declarations = thirdParty) =>
  shape(irOf(source, declarations).body);

describe("a target without nativeTags", () => {
  it("parses a void element as having no body", () => {
    expect(body(`<input value="x"><p>hi</p>`)).toEqual([
      { element: "input", void: true, children: [] },
      { element: "p", children: [{ text: "hi" }] },
    ]);
    expect(body(`<div><br>text<img src="a.png"></div>`)).toEqual([
      {
        element: "div",
        children: [
          { element: "br", void: true, children: [] },
          { text: "text" },
          { element: "img", void: true, children: [] },
        ],
      },
    ]);
  });

  it("keeps a `<pre>` body's whitespace", () => {
    expect(body("<pre>  a\n  b</pre>")).toEqual([
      { element: "pre", children: [{ text: "  a\n  b" }] },
    ]);
  });

  it("reads a `<textarea>` and a `<title>` body as text", () => {
    expect(body("<textarea>  <b>x</b></textarea>")).toEqual([
      { element: "textarea", children: [{ text: "  <b>x</b>" }] },
    ]);
    expect(body("<title><b>x</b></title>")).toEqual([
      { element: "title", children: [{ text: "<b>x</b>" }] },
    ]);
  });
});

/**
 * A target that declares its own `nativeTags` gets exactly that table, in the
 * parse and in lowering alike: core's fallback does not leak in, and a void
 * element is the one the table declares void, so the IR never drops a body the
 * parse kept.
 */
describe("a target with its own nativeTags", () => {
  const custom: HostDeclarations = {
    ...thirdParty,
    nativeTags: new Map([
      ["box", { namespace: "html", body: "void" }],
      ["p", { namespace: "html", body: "html" }],
    ]),
  };

  it("lowers a declared void element as void", () => {
    expect(body("<box/>", custom)).toEqual([
      { element: "box", void: true, children: [] },
    ]);
    expect(body("<div><box><p>a</p></div>", custom)).toEqual([
      {
        element: "div",
        children: [
          { element: "box", void: true, children: [] },
          { element: "p", children: [{ text: "a" }] },
        ],
      },
    ]);
  });

  it("keeps the body of an HTML void name the table does not declare void", () => {
    expect(body("<input>x</input>", custom)).toEqual([
      { element: "input", children: [{ text: "x" }] },
    ]);
  });

  it("parses an undeclared HTML void name as needing its end tag", () => {
    expect(() => body("<embed><p>a</p>", custom)).toThrow("Missing ending");
  });
});

/**
 * A `.<host>.mx` region is lowered with no tag table (`ctx.tagTable` absent), so
 * whether a lowercase name an in-scope `<define>` binds is the native element
 * (decision 164's warning) or not a tag (row 3's error) comes from the
 * target's `nativeTags`, else core's own HTML elements: the same elements a
 * whole file's table holds.
 */
describe("a region's native elements", () => {
  const FILE = "/tmp/native-fallback/Panel.preact.mx";
  function lowerRegion(
    source: string,
    declarations: HostDeclarations,
  ): MxWarning[] {
    const { body } = parseFragment(source, {
      filename: FILE,
      nativeTags: declarations.nativeTags,
    });
    const ctx = newCtx(
      source,
      printExpression,
      declarations,
      undefined,
      FILE,
      lookup,
    );
    const warnings: MxWarning[] = [];
    ctx.warnings = warnings;
    lower(ctx, body);
    return warnings;
  }
  const defining = (name: string) =>
    `<define/${name}|x|>d</define><div><${name}/></div>`;
  const native = (name: string) =>
    expect.objectContaining({
      message: expect.stringContaining(
        `\`<${name}>\` is the native element; the \`${name}\` defined at 1:`,
      ),
    });
  const notATag = (name: string) =>
    `Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use \`<\${${name}}/>\` or rename to \`${name[0]?.toUpperCase()}${name.slice(1)}\`.`;
  const web: HostDeclarations = { ...thirdParty, nativeTags: WEB_ELEMENTS };

  it("reads the target's nativeTags: `<param>` and SVG's `<circle>` are native", () => {
    expect(lowerRegion(defining("param"), web)).toEqual([native("param")]);
    expect(lowerRegion(defining("circle"), web)).toEqual([native("circle")]);
    expect(() => lowerRegion(defining("widget"), web)).toThrow(
      notATag("widget"),
    );
  });

  it("falls back to core's own HTML elements without nativeTags", () => {
    expect(lowerRegion(defining("param"), thirdParty)).toEqual([
      native("param"),
    ]);
    expect(lowerRegion(defining("section"), thirdParty)).toEqual([
      native("section"),
    ]);
    // HTML only: SVG names come from a target's own table.
    expect(() => lowerRegion(defining("circle"), thirdParty)).toThrow(
      notATag("circle"),
    );
  });
});

// Marko's own rule, moved into core verbatim: a lowercase tag never calls a
// local binding of any kind, whatever the binding holds (measured on the stock
// parser, `@marko/compiler` 5.42.11 / `marko` 6.4.4: identical message and
// position - the tag name - for a tag import, a `.ts` value import, a
// `<const>`, a tag param and a `static`/`export` declaration, plain or
// destructured). One error, host-agnostic, before any host's
// `isElement`/`isComponent` is consulted.
describe("a lowercase tag naming a local binding", () => {
  const LOCAL_VARIABLE = (name: string) =>
    `Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use \`<\${${name}}/>\` or rename to \`${name[0]?.toUpperCase()}${name.slice(1)}\`.`;

  function thrownBy(source: string): unknown {
    try {
      irOf(source);
    } catch (caught) {
      return caught;
    }
    return undefined;
  }

  it("fails at the tag name with Marko's exact message, whatever the binding is", () => {
    for (const decl of [
      'import layout from "./layout.mx"',
      'import layout from "./layout.ts"',
      "<define/layout|x|>d</define>",
    ]) {
      expect(thrownBy(`${decl}\n<layout/>\n`), decl).toMatchObject({
        message: LOCAL_VARIABLE("layout"),
        line: 2,
        column: 1,
      });
    }
  });

  // Each source declares `layout` one way and calls `<layout/>`; the position
  // is the tag name (stock parser, 1-based: 2:2, or 3:4 when nested).
  it.each([
    ["a `<const>`", '<const/layout="x"/>\n<layout/>\n'],
    ["a `static const`", "static const layout = 1\n<layout/>\n"],
    ["a `static function`", "static function layout() {}\n<layout/>\n"],
    ["a `static class`", "static class layout {}\n<layout/>\n"],
    [
      "a `static const` in a second declarator",
      "static const a = 1, layout = 2\n<layout/>\n",
    ],
    [
      "a destructured `static const`",
      "static const { layout } = { layout: 1 }\n<layout/>\n",
    ],
    [
      "a renamed destructured `static const`",
      "static const { a: layout } = { a: 1 }\n<layout/>\n",
    ],
    [
      "a defaulted destructured `static const`",
      "static const { layout = 1 } = {}\n<layout/>\n",
    ],
    [
      "a rest in a destructured `static const`",
      "static const { a, ...layout } = { a: 1, b: 2 }\n<layout/>\n",
    ],
    [
      "a nested destructured `static const`",
      "static const { a: { layout } } = { a: { layout: 1 } }\n<layout/>\n",
    ],
    [
      "an array-destructured `static const`",
      "static const [layout] = [1]\n<layout/>\n",
    ],
    [
      "a rest in an array-destructured `static const`",
      "static const [, ...layout] = [1, 2]\n<layout/>\n",
    ],
    ["an `export const`", "export const layout = 1\n<layout/>\n"],
    [
      "an `export let` second declarator",
      "export let a = 1, layout = 2\n<layout/>\n",
    ],
    ["an `export function`", "export function layout() {}\n<layout/>\n"],
    ["an `export class`", "export class layout {}\n<layout/>\n"],
    [
      "a destructured `export const`",
      "export const { layout } = { layout: 1 }\n<layout/>\n",
    ],
    [
      "an array-destructured `export const`",
      "export const [layout] = [1]\n<layout/>\n",
    ],
  ])("fails at the tag name for %s", (_label, source) => {
    expect(thrownBy(source), source).toMatchObject({
      message: LOCAL_VARIABLE("layout"),
      line: 2,
      column: 1,
    });
  });

  it("fails at the tag name of a nested tag, not at its parent", () => {
    expect(
      thrownBy("export const layout = 1\n<div>\n  <layout/>\n</div>\n"),
    ).toMatchObject({ message: LOCAL_VARIABLE("layout"), line: 3, column: 3 });
  });

  it("fails at a `<for>` param's tag name", () => {
    expect(thrownBy("<for|row| of=[1]><row/></for>\n")).toMatchObject({
      message: LOCAL_VARIABLE("row"),
      line: 1,
      column: 18,
    });
  });

  // `export type`/`export interface` bind a type, not a value, and Marko
  // treats the tag as an unknown one (its "Unable to find entry point"), so
  // neither is the local-variable error; neither is a capitalized export, a
  // different name, or a name declared only inside a function body.
  it.each([
    ["an `export type`", "export type layout = number\n<layout/>\n"],
    [
      "an `export interface`",
      "export interface layout { a: number }\n<layout/>\n",
    ],
    [
      "an `export const` of another name",
      "export const other = 1\n<layout/>\n",
    ],
    [
      "a destructured `static const` of another name",
      "static const { other } = { other: 1 }\n<layout/>\n",
    ],
    [
      "a name only a function body declares",
      "static function f() { const layout = 1 }\n<layout/>\n",
    ],
  ])("does not raise the local-variable error for %s", (_label, source) => {
    const error = thrownBy(source) as { message?: string } | undefined;
    expect(error?.message ?? "").not.toContain("Local variables must be");
  });

  // Out of this rule's scope: an exported PascalCase name binds for the
  // lowercase rule only. How it resolves as a component is unchanged (a
  // `static` PascalCase name is a component call; an exported one is not,
  // yet), so a change to that is its own decision, not a side effect here.
  it("an `export const` PascalCase name is not routed as a component by this rule", () => {
    expect(
      thrownBy("export const Layout = () => 1\n<Layout/>\n"),
    ).toMatchObject({
      message: expect.stringContaining(
        "`<Layout>` has no matching import or `<define>` in scope",
      ),
    });
    expect(
      thrownBy("static const Layout = () => 1\n<Layout/>\n"),
    ).toBeUndefined();
  });

  it("a core taglib name bound by an import is exempt: no local-variable error", () => {
    // Stock Marko compiles `import debug from "debug"` + `<debug/>` as the
    // core `<debug>` tag. The rule must not blame the import. What the tag
    // itself lowers to is each target's own answer (a target that does not
    // implement the tag falls to its element path), so this asserts only the
    // absence of the local-variable error.
    expect(thrownBy('import debug from "debug"\n<debug/>\n')).toBeUndefined();
  });

  // A core taglib name is not "the native element" the binding warning
  // claims: bound by a tag module or a `<define>`, it raises neither the
  // local-variable error nor that warning.
  it.each([
    ["an import", 'import log from "./log.mx"\n<log=1/>\n'],
    ["a `<define>`", "<define/debug|x|>d</define>\n<debug/>\n"],
  ])(
    "a core taglib name bound by %s raises no error and no warning",
    (_label, source) => {
      const warnings: MxWarning[] = [];
      compileSource(source, "/tmp/native-fallback.mx", thirdParty, {
        targets: lookup,
        warnings,
        emitIr: () => "",
      });
      expect(warnings).toEqual([]);
    },
  );
});
