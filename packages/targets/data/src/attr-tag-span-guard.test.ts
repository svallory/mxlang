import {
  compileSource,
  createTargetLookup,
  type Ir,
  type SourceSpan,
} from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { buildDataDocument } from "./build.ts";
import { dataDeclarations } from "./declarations.ts";
import { dataTaglib } from "./taglib.ts";
import { dataTargetBase } from "./target-base.ts";

/**
 * `dataAttrTag` must never emit an attribute tag whose `nameSpan` is absent or
 * non-finite (core once produced NaN offsets for a comment lowered as an
 * empty-name attribute tag). A captured IR whose name span is replaced drives
 * the guard directly, since core no longer produces such an IR.
 */

const dataTargets = createTargetLookup([dataTargetBase]);

const SOURCE = "<loose><@m>t</@m></loose>\n";

function capturedIr(): Ir {
  let captured: Ir | undefined;
  compileSource(SOURCE, "/guard.mx", dataDeclarations, {
    targets: dataTargets,
    taglibs: [dataTaglib()],
    tagDiscoveryDirs: [],
    emitIr: (ir) => {
      captured = ir;
      return "";
    },
  });
  if (!captured) throw new Error("no IR captured");
  return captured;
}

/** The IR with `<@m>`'s `nameSpan` replaced by `span`. */
function withAttrTagNameSpan(span: unknown): Ir {
  const ir = capturedIr();
  const tag = ir.body.find((n) => n.kind === "DelegatedTag");
  if (tag?.kind !== "DelegatedTag") throw new Error("no <loose>");
  const attrTag = tag.tag.attributeTagTree[0];
  if (attrTag?.kind !== "AttributeTag") throw new Error("no <@m>");
  (attrTag.tag as { nameSpan: unknown }).nameSpan = span;
  return ir;
}

const build = (ir: Ir) =>
  buildDataDocument(ir, SOURCE, "/guard.mx", {
    structural: "pass",
    unknownTags: "allow",
    declaredTags: new Set(),
  });

describe("an attribute tag's name span is checked before it reaches the tree", () => {
  it("accepts a finite span", () => {
    const span: SourceSpan = { sourceStart: 10, sourceEnd: 11 };
    const doc = build(withAttrTagNameSpan(span));
    const loose = doc.children[0];
    if (loose?.kind !== "tag") throw new Error("unreachable");
    expect(loose.attrTags[0]).toMatchObject({
      kind: "attr-tag",
      name: "m",
      nameSpan: span,
    });
  });

  for (const [label, span] of [
    ["absent", undefined],
    ["null", null],
    ["NaN", { sourceStart: Number.NaN, sourceEnd: Number.NaN }],
    ["NaN end only", { sourceStart: 10, sourceEnd: Number.NaN }],
    ["Infinity", { sourceStart: 10, sourceEnd: Number.POSITIVE_INFINITY }],
  ] as const) {
    it(`rejects a ${label} span with the named invariant error`, () => {
      expect(() => build(withAttrTagNameSpan(span))).toThrow(
        /@mxlang\/data: core IR invariant broken — attribute tag `<@m>`'s name carries (no|a non-finite) span/,
      );
    });
  }
});
