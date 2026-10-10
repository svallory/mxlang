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
    `\`<${name}>\` is not a tag here: \`${name}\` is defined at 1:`;
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
