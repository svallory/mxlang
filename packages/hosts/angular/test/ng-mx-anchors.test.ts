/**
 * Node anchors (`CompileNgMxResult.anchors`): the generated extent of a start
 * tag or attribute, tied to the authored name / attribute it came from.
 *
 * Every assertion slices both sides, as `mapping.test.ts` does: the module
 * text by the anchor's generated span, the `.ng.mx` source by its source span.
 */

import { describe, expect, it } from "vitest";
import {
  anchorFor,
  type NodeAnchor,
  rebaseAnchorsThroughEscaping,
} from "../src/mapping.ts";
import { compileNgMx } from "../src/ng-mx.ts";

function ngMx(template: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    "export class XComponent { title = 'a'; }",
  ].join("\n");
}

/** `[module slice, source slice]` for every anchor, in emission order. */
function pairs(source: string): Array<[string, string]> {
  const result = compileNgMx(source, "/p/x.component.ng.mx");
  return result.anchors.map((a) => [
    result.code.slice(a.generatedStart, a.generatedEnd),
    source.slice(a.sourceStart, a.sourceEnd),
  ]);
}

describe("compileNgMx anchors", () => {
  it("anchors a start tag to the authored name and an attribute to its name through value", () => {
    // Emission order: a start tag's anchor closes after its attributes'.
    expect(pairs(ngMx("<div><input lable=title/></div>"))).toEqual([
      ["<div>", "div"],
      ['[lable]="title"', "lable=title"],
      ['<input [lable]="title">', "input"],
    ]);
  });

  it("anchors a boolean attribute and a static attribute", () => {
    expect(pairs(ngMx('<div id="a" hidden></div>'))).toEqual([
      ['id="a"', 'id="a"'],
      ["hidden", "hidden"],
      ['<div id="a" hidden>', "div"],
    ]);
  });

  it("anchors a default attribute at its value, since it has no spelled name", () => {
    expect(pairs(ngMx("<widget=title></widget>"))).toEqual([
      ['[value]="title"', "title"],
      ['<widget [value]="title">', "widget"],
    ]);
  });

  it("keeps an anchor whose attribute value needed template-literal escaping", () => {
    const source = ngMx("<input lable=`a${title}`/>");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    const attr = result.anchors.find((a) =>
      source.slice(a.sourceStart, a.sourceEnd).startsWith("lable"),
    );
    if (!attr) throw new Error("the attribute anchor was dropped");
    // The escaped backtick and `\${` shifted the module offsets: the anchor
    // still slices the emitted attribute, in full, out of the module.
    expect(result.code.slice(attr.generatedStart, attr.generatedEnd)).toBe(
      '[lable]="`a${title}`"'.replaceAll("`", "\\`").replace("${", "\\${"),
    );
  });

  it("does not add anchors to `mappings` (source maps keep punctuation unmapped)", () => {
    const source = ngMx("<div><input lable=title/></div>");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    for (const a of result.anchors) {
      const wide = result.mappings.some(
        (m) =>
          m.generatedStart === a.generatedStart &&
          m.generatedEnd === a.generatedEnd,
      );
      expect(wide).toBe(false);
    }
  });

  it("anchors nothing for a node with no authored span", () => {
    // A bare fragment root has no tag of its own to anchor.
    expect(pairs(ngMx("<><p>x</p></>")).map(([, s]) => s)).toEqual(["p"]);
  });
});

describe("anchorFor", () => {
  const outer: NodeAnchor = {
    generatedStart: 0,
    generatedEnd: 20,
    sourceStart: 100,
    sourceEnd: 105,
  };
  const inner: NodeAnchor = {
    generatedStart: 6,
    generatedEnd: 12,
    sourceStart: 108,
    sourceEnd: 114,
  };

  it("prefers the narrowest anchor containing the offset", () => {
    expect(anchorFor([outer, inner], 7)).toBe(inner);
    expect(anchorFor([inner, outer], 7)).toBe(inner);
    expect(anchorFor([outer, inner], 1)).toBe(outer);
  });

  it("treats the end as exclusive and answers null outside every anchor", () => {
    expect(anchorFor([outer], 20)).toBeNull();
    expect(anchorFor([], 0)).toBeNull();
  });
});

describe("rebaseAnchorsThroughEscaping", () => {
  it("shifts both ends by the escaped length of what precedes them, dropping nothing", () => {
    const template = "a`b<i x=`/>";
    const escapeTick = (c: string) => (c === "`" ? "\\`" : c);
    const [rebased] = rebaseAnchorsThroughEscaping(
      template,
      [{ generatedStart: 3, generatedEnd: 11, sourceStart: 0, sourceEnd: 1 }],
      1,
      escapeTick,
    );
    // One backtick precedes the start (+1), another sits inside (+1 on the end).
    expect(rebased).toMatchObject({
      generatedStart: 1 + 3 + 1,
      generatedEnd: 1 + 11 + 2,
    });
  });
});
