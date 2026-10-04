import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { type ParseDataOptions, parseData } from "./parse.ts";

const customTags: Record<string, CustomTag> = {
  resource: {
    parents: ["#root"],
    children: { attributes: {}, relationships: {} },
  },
  attributes: { parents: ["resource"] },
  relationships: { parents: ["resource"] },
  // No `children` declaration: any child is allowed by the contract.
  open: { attributes: { label: { type: "string" } } },
};

function parse(
  source: string,
  options: Omit<ParseDataOptions, "customTags"> = {},
  tags: Record<string, CustomTag> = customTags,
) {
  return parseData(source, "/u.mx", {
    customTags: tags,
    unknownTags: "reject",
    ...options,
  });
}

describe('unknownTags: "reject"', () => {
  it("rejects a far-named root tag with no hint, positioned at the call", () => {
    const { tree, diagnostics } = parse('widget="post"\n');
    expect(tree).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<widget>` is not a known tag: it has no contract in `customTags`",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });

  it("hints the nearest declared name for a typo at the root", () => {
    const { diagnostics } = parse('resorce="post"\n');
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<resorce>` is not a known tag: it has no contract in `customTags`; did you mean `<resource>`?",
        line: 1,
        column: 0,
      },
    ]);
  });

  it("rejects a nested unknown tag under a parent with no children declaration", () => {
    const { tree, diagnostics } = parse(
      "<open>\n  <deep>\n    <bogus/>\n  </deep>\n</open>",
    );
    expect(tree).toBeUndefined();
    // `<deep>` is the first unknown; `<bogus>` inside it is not also reported.
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<deep>` is not a known tag: it has no contract in `customTags`",
        line: 2,
        column: 2,
      },
    ]);
  });

  it("reports one error per unknown call: the body of an unknown tag is not walked", () => {
    const { diagnostics } = parse("<bogus>\n  <other/>\n</bogus>");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("`<bogus>`");
  });

  it("finds an unknown tag inside an <if> branch and a <for> body", () => {
    expect(
      parse("<open>\n  <if=x>\n    <nope/>\n  </if>\n</open>").diagnostics,
    ).toMatchObject([
      { message: expect.stringContaining("`<nope>`"), line: 3 },
    ]);
    expect(
      parse("<open>\n  <for|i| of=xs>\n    <nope/>\n  </for>\n</open>")
        .diagnostics,
    ).toMatchObject([
      { message: expect.stringContaining("`<nope>`"), line: 3 },
    ]);
  });

  it("lets a parent's closed children error win over the unknown-tag error", () => {
    const { diagnostics } = parse("<resource>\n  <bad/>\n</resource>");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe(
      "`<resource>`: `<bad>` is not allowed here; allowed children: `<attributes>`, `<relationships>`",
    );
  });

  it("accepts a document of only declared tags", () => {
    const { tree, diagnostics } = parse(
      "<resource>\n  <attributes/>\n</resource>",
    );
    expect(diagnostics).toEqual([]);
    expect(tree).toBeDefined();
  });

  it("does not treat reserved/core-owned names as unknown", () => {
    const { diagnostics } = parse(
      "<open>\n  <if=x><open/></if>\n  <else><open/></else>\n  <for|i| of=xs><open/></for>\n  <const/y=1>\n</open>",
    );
    expect(diagnostics).toEqual([]);
  });

  it("is checked after structural: a structural construct still reports first", () => {
    const { diagnostics } = parse("<open>\n  <if=x><nope/></if>\n</open>", {
      structural: "reject",
    });
    expect(diagnostics).toMatchObject([
      { message: expect.stringContaining("does not evaluate `<if>`") },
    ]);
  });

  it('combines with structural: "pass"', () => {
    const { tree, diagnostics } = parse('widget="post"\n', {
      structural: "pass",
    });
    expect(tree).toBeUndefined();
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<widget>` is not a known tag: it has no contract in `customTags`",
        line: 1,
        column: 0,
      },
    ]);
  });

  it("rejects an unknown inside an <else> body", () => {
    const { diagnostics } = parse(
      "<open>\n  <if=x><open/></if>\n  <else><bogus/></else>\n</open>",
    );
    expect(diagnostics).toMatchObject([
      { message: expect.stringContaining("`<bogus>`"), line: 3 },
    ]);
  });

  it("rejects an unknown inside an <@meta> attribute-tag body, and does not check <@meta> itself", () => {
    const tags: Record<string, CustomTag> = {
      ...customTags,
      holder: {
        attributeTags: { meta: { repeatable: true } },
      },
    };
    const ok = parse("<holder><@meta/></holder>", {}, tags);
    expect(ok.diagnostics).toEqual([]);
    const { diagnostics } = parse(
      "<holder><@meta><bogus/></@meta></holder>",
      {},
      tags,
    );
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<bogus>` is not a known tag: it has no contract in `customTags`",
        line: 1,
        column: 15,
      },
    ]);
  });

  // Flips when TODO `data-transform-output-tree` lands: today a transform's
  // output throws the IR invariant in both modes.
  it("checks authored names only: a tag a declared transform emits is not unknown", () => {
    const tags: Record<string, CustomTag> = {
      ...customTags,
      wrap: {
        transform: (call, ctx) => [
          ctx.build.delegatedTag(
            "emitted",
            call.content?.children ?? [],
            call.attributeTags,
          ),
        ],
      },
    };
    // The data tree cannot represent a spanless (synthesized) tag at all, so
    // `<wrap/>` throws core's IR-invariant error under `"allow"` as well; the
    // point here is that `"reject"` does not turn it into an unknown-tag
    // error blaming the authored `<wrap>`.
    const message = (options: ParseDataOptions) => {
      try {
        parseData("<wrap/>", "/u.mx", { customTags: tags, ...options });
        return "no throw";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const allowed = message({ unknownTags: "allow" });
    expect(allowed).toContain("`<emitted>`'s name carries no span");
    expect(message({ unknownTags: "reject" })).toBe(allowed);
    // An authored unknown is still reported, at its own position.
    const mixed = parse("<bogus/>\n<wrap/>", {}, tags);
    expect(mixed.diagnostics).toMatchObject([
      { message: expect.stringContaining("`<bogus>`"), line: 1, column: 0 },
    ]);
  });

  it("rejects every tag when customTags is empty", () => {
    const empty = parse("<anything/>", {}, {});
    expect(empty.diagnostics).toMatchObject([
      {
        message:
          "`<anything>` is not a known tag: it has no contract in `customTags`",
      },
    ]);
    // Nothing to reject in a file with no tags.
    expect(parse("", {}, {}).diagnostics).toEqual([]);
  });

  it("rejects every tag when customTags is omitted", () => {
    const result = parseData("<anything/>", "/u.mx", { unknownTags: "reject" });
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe('unknownTags: "allow" (default)', () => {
  it("accepts an unknown tag by default and when explicit", () => {
    for (const options of [{}, { unknownTags: "allow" as const }]) {
      const result = parseData('widget="post"\n', "/u.mx", {
        customTags,
        ...options,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.tree?.children[0]).toMatchObject({
        kind: "tag",
        name: "widget",
      });
    }
  });
});
