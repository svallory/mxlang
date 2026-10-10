import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { lowerSource } from "./index.ts";

// `<wrap a="1" b="2"/>` on one line: the authored attributes sit at columns
// 6 (`a`) and 12 (`b`), their name spans and value spans derived from those
// offsets.
const SOURCE = '<wrap a="1" b="2"/>\n';

/**
 * Rewrites the call into two sibling tags, each built `from` one of the
 * original attributes: the built tag (and its built attribute) carries the
 * original attribute's positions.
 */
const fromAttrs: Record<string, CustomTag> = {
  wrap: {
    transform: (call, ctx) =>
      call.attrs.map((attr) => {
        if (attr.kind !== "static") throw ctx.fail("needs static attrs");
        return ctx.build.delegatedTag(
          "item",
          [],
          [],
          [ctx.build.attr(attr.name, attr.value, attr)],
          attr,
        );
      }),
  },
  item: {},
};

describe("transform output through lowerSource", () => {
  it("returns the IR after transform, with built nodes and their spans", () => {
    const { ir, diagnostics } = lowerSource(SOURCE, "/u.mx", {
      customTags: fromAttrs,
    });
    expect(diagnostics).toEqual([]);
    expect(ir?.body).toHaveLength(2);
    const [firstNode, secondNode] = ir?.body ?? [];
    if (
      firstNode?.kind !== "DelegatedTag" ||
      secondNode?.kind !== "DelegatedTag"
    ) {
      throw new Error("expected two built tags");
    }
    const first = firstNode.tag;
    const second = secondNode.tag;
    if (
      first.attrs[0]?.kind !== "static" ||
      second.attrs[0]?.kind !== "static"
    ) {
      throw new Error("expected two built tags with static attrs");
    }
    expect(first.name).toBe("item");
    expect(second.name).toBe("item");
    expect(first.attrs[0].value).toBe("1");
    expect(second.attrs[0].value).toBe("2");
    // Each built tag sits where the attribute it was built from sits.
    expect(first.span).toEqual({ sourceStart: 6, sourceEnd: 7 });
    expect(first.nameSpan).toEqual({ sourceStart: 6, sourceEnd: 7 });
    expect(second.span).toEqual({ sourceStart: 12, sourceEnd: 13 });
    expect(second.nameSpan).toEqual({ sourceStart: 12, sourceEnd: 13 });
    // The built attribute carries the original attribute's spans too.
    expect(first.attrs[0].nameSpan).toEqual({ sourceStart: 6, sourceEnd: 7 });
    expect(first.attrs[0].valueSpan).toEqual({ sourceStart: 8, sourceEnd: 11 });
    expect(second.attrs[0].nameSpan).toEqual({
      sourceStart: 12,
      sourceEnd: 13,
    });
    expect(second.attrs[0].valueSpan).toEqual({
      sourceStart: 14,
      sourceEnd: 17,
    });
  });

  it("positions a contract error on a built node at the original attribute", () => {
    // `mystery` is not declared, so the emitted tag is an unknown tag whose
    // position is the original attribute the built node was built from.
    const tags: Record<string, CustomTag> = {
      wrap: {
        transform: (call, ctx) =>
          call.attrs.map((attr) =>
            ctx.build.delegatedTag("mystery", [], [], [], attr),
          ),
      },
    };
    const { ir, diagnostics } = lowerSource(SOURCE, "/u.mx", {
      customTags: tags,
      unknownTags: "reject",
    });
    expect(ir).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<mystery>` is not a known tag: it has no contract in `customTags`",
        line: 1,
        column: 6,
        offset: 6,
      },
      {
        severity: "error",
        message:
          "`<mystery>` is not a known tag: it has no contract in `customTags`",
        line: 1,
        column: 12,
        offset: 12,
      },
    ]);
  });

  it("leaves tags without transform unchanged", () => {
    const { ir, diagnostics } = lowerSource(
      '<resource id="root"/>\n',
      "/u.mx",
      { customTags: fromAttrs },
    );
    expect(diagnostics).toEqual([]);
    expect(ir?.body).toHaveLength(1);
    expect(ir?.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        name: "resource",
        span: { sourceStart: 0, sourceEnd: 21 },
      },
    });
  });
});
