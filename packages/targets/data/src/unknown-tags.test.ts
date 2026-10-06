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
    // `<deep>` is the first unknown; `<bogus>` inside it is reported too,
    // labelled as following from `<deep>`.
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<deep>` is not a known tag: it has no contract in `customTags`",
        line: 2,
        column: 2,
      },
      {
        message:
          "`<bogus>` is not a known tag: it has no contract in `customTags` (inside the unknown tag `<deep>`; may resolve once it is declared)",
        line: 3,
        column: 4,
      },
    ]);
  });

  it("reports every unknown call, the ones inside an unknown tag labelled", () => {
    const { diagnostics } = parse("<bogus>\n  <other/>\n</bogus>");
    expect(diagnostics.map((d) => [d.line, d.column, d.message])).toEqual([
      [
        1,
        0,
        "`<bogus>` is not a known tag: it has no contract in `customTags`",
      ],
      [
        2,
        2,
        "`<other>` is not a known tag: it has no contract in `customTags` (inside the unknown tag `<bogus>`; may resolve once it is declared)",
      ],
    ]);
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

  it("lets a known parent's closed children error stand (no unknown tag precedes it)", () => {
    const { diagnostics } = parse("<resource>\n  <bad/>\n</resource>");
    // The closed-children error is first; `<bad>` is also an unknown tag, at
    // the same position, and both stay: two different errors are never merged.
    expect(diagnostics.map((d) => [d.line, d.column, d.message])).toEqual([
      [
        2,
        2,
        "`<resource>`: `<bad>` is not allowed here; allowed children: `<attributes>`, `<relationships>`",
      ],
      [2, 2, "`<bad>` is not a known tag: it has no contract in `customTags`"],
    ]);
  });

  it("reports an unknown parent before its child's `parents` error (Mesh's typo)", () => {
    const { tree, diagnostics } = parse('resourse="post"\n  attributes\n', {
      structural: "reject",
    });
    expect(tree).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<resourse>` is not a known tag: it has no contract in `customTags`; did you mean `<resource>`?",
        line: 1,
        column: 0,
        offset: 0,
      },
      {
        severity: "error",
        message:
          "`<attributes>` must be inside `<resource>`; found inside `<resourse>` (inside the unknown tag `<resourse>`; may resolve once it is declared)",
        line: 2,
        column: 2,
        offset: 18,
      },
    ]);
  });

  it("reports an unknown parent before its child's `children` error", () => {
    const { diagnostics } = parse(
      "<open>\n  <bogus>\n    <x/>\n  </bogus>\n</open>",
    );
    expect(diagnostics).toMatchObject([
      { message: expect.stringContaining("`<bogus>`"), line: 2, column: 2 },
      {
        message:
          "`<x>` is not a known tag: it has no contract in `customTags` (inside the unknown tag `<bogus>`; may resolve once it is declared)",
        line: 3,
        column: 4,
      },
    ]);
  });

  it("keeps a core contract error that comes earlier in document order", () => {
    const { diagnostics } = parse(
      "<resource>\n  <bad/>\n</resource>\n<widget/>",
    );
    // The core error comes first, `<bad>` as an unknown tag at the same
    // position next, and the later unknown tag is listed beside them.
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]?.message).toContain("`<bad>` is not allowed here");
    expect(diagnostics[1]?.message).toContain("`<bad>` is not a known tag");
    expect(diagnostics[2]).toMatchObject({
      message: expect.stringContaining("`<widget>`"),
      line: 4,
      column: 0,
    });
  });

  it("reports the earlier of an unknown tag and a structural construct", () => {
    const earlier = parse("<widget/>\n<if=x/>", { structural: "reject" });
    // Both are reported, in file order.
    expect(earlier.diagnostics).toMatchObject([
      { message: expect.stringContaining("`<widget>`"), line: 1 },
      { message: expect.stringContaining("does not evaluate `<if>`"), line: 2 },
    ]);
    const later = parse("<if=x/>\n<widget/>", { structural: "reject" });
    expect(later.diagnostics).toMatchObject([
      { message: expect.stringContaining("does not evaluate `<if>`"), line: 1 },
      { message: expect.stringContaining("`<widget>`"), line: 2 },
    ]);
  });

  it("reports a parse error as is when the file does not compile at all", () => {
    const { diagnostics } = parse("<widget>\n  <open");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).not.toContain("not a known tag");
  });

  it("keeps a text body's content out of the unknown-tag list (parseOptions.text)", () => {
    const tags: Record<string, CustomTag> = {
      ...customTags,
      snippet: { parseOptions: { text: true } },
    };
    const { diagnostics } = parse(
      "<snippet><foo/></snippet>\n<resource>\n  <bad/>\n</resource>",
      {},
      tags,
    );
    // The text body's `<foo/>` is not listed: only `<bad>`, as the closed
    // children error and as an unknown tag at the same position.
    expect(diagnostics.map((d) => d.line)).toEqual([3, 3]);
    expect(diagnostics[0]?.message).toContain("`<bad>` is not allowed here");
    expect(diagnostics[1]?.message).toContain("`<bad>` is not a known tag");
  });

  it("does not reuse a stale parse lookup across calls with different text tags", () => {
    const withText = (name: string): Record<string, CustomTag> => ({
      ...customTags,
      [name]: { parseOptions: { text: true } },
    });
    for (const name of ["snip", "clip"]) {
      const { diagnostics } = parse(
        `<${name}><foo/></${name}>\n<resource>\n  <bad/>\n</resource>`,
        {},
        withText(name),
      );
      expect(diagnostics.map((d) => d.line)).toEqual([3, 3]);
      expect(diagnostics[0]?.message).toContain("`<bad>` is not allowed here");
      expect(diagnostics[1]?.message).toContain("`<bad>` is not a known tag");
    }
  });

  it("keeps the parse shape of an openTagOnly tag when listing unknown tags", () => {
    const tags: Record<string, CustomTag> = {
      ...customTags,
      stub: { parseOptions: { openTagOnly: true } },
    };
    const { diagnostics } = parse(
      "<stub/>\n<resource>\n  <bad/>\n</resource>",
      {},
      tags,
    );
    expect(diagnostics.map((d) => d.line)).toEqual([3, 3]);
    expect(diagnostics[0]?.message).toContain("`<bad>` is not allowed here");
    expect(diagnostics[1]?.message).toContain("`<bad>` is not a known tag");
  });

  it("keeps the parse shape of a preserveWhitespace tag when listing unknown tags", () => {
    const tags: Record<string, CustomTag> = {
      ...customTags,
      note: { parseOptions: { preserveWhitespace: true } },
    };
    const { diagnostics } = parse(
      "<note>\n  <foo/>\n</note>\n<resource>\n  <bad/>\n</resource>",
      {},
      tags,
    );
    // preserveWhitespace changes whitespace only: `<foo>` is still a tag,
    // and it opens before the `<bad>` children error. `<bad>` is reported
    // twice, as the closed-children error and as an unknown tag.
    expect(diagnostics).toMatchObject([
      { message: expect.stringContaining("`<foo>`"), line: 2 },
      { message: expect.stringContaining("is not allowed here"), line: 5 },
      {
        message: expect.stringContaining("`<bad>` is not a known tag"),
        line: 5,
      },
    ]);
  });

  it("reports the unknown parent when a later, contract-independent lowering error follows", () => {
    const tags: Record<string, CustomTag> = {
      ...customTags,
      stub: { parseOptions: { openTagOnly: true } },
    };
    // The unknown parent comes first; the trailer's own mistake follows it.
    const attributes = {
      message: "`<attributes>` must be inside `<resource>`",
      line: 2,
    };
    const trailers: [string, { message: string; line: number }[]][] = [
      [
        "stub\n  x\n",
        [
          attributes,
          { message: "`<stub>`: does not accept content", line: 3 },
          { message: "`<x>` is not a known tag", line: 4 },
        ],
      ],
      // Core recovers per tag (decision 162): the `<define>` after the
      // `<attributes>` error is reached and reports its own.
      ["<define/>\n", [attributes, { message: "<define>", line: 3 }]],
    ];
    for (const [trailer, rest] of trailers) {
      const { diagnostics } = parse(
        `resourse="post"\n  attributes\n${trailer}`,
        { structural: "reject" },
        tags,
      );
      expect(diagnostics).toMatchObject([
        {
          message: expect.stringContaining("`<resourse>` is not a known tag"),
          line: 1,
          column: 0,
        },
        ...rest.map((r) => ({
          message: expect.stringContaining(r.message),
          line: r.line,
        })),
      ]);
    }
  });

  it("keeps the original error when the file does not even parse", () => {
    const { diagnostics } = parse("resourse=\n  attributes\n<open");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).not.toContain("not a known tag");
  });

  it("keeps the build error and the unknown tag at one position, build error first", () => {
    const merged = parse('<widget.a class="b"/>');
    // `<widget>` is unknown too: two different errors at one position both
    // stay, in discovery order (the build's first).
    expect(merged.diagnostics).toMatchObject([
      {
        message: expect.stringContaining("shorthand class"),
        line: 1,
        column: 0,
      },
      {
        message: expect.stringContaining("`<widget>` is not a known tag"),
        line: 1,
        column: 0,
      },
    ]);
    const bad = parse("<$bad/>");
    expect(bad.diagnostics).toMatchObject([
      {
        message: expect.stringContaining("not a tag name a data file can use"),
        line: 1,
        column: 0,
      },
      {
        message: expect.stringContaining("`<$bad>` is not a known tag"),
        line: 1,
        column: 0,
      },
    ]);
  });

  it('orders a structural hit and a build error by position (unknownTags: "allow")', () => {
    const dynamicFirst = parse("<$" + "{y}/>\n<if=x/>", {
      unknownTags: "allow",
      structural: "reject",
    });
    expect(dynamicFirst.diagnostics).toMatchObject([
      { message: expect.stringContaining("a dynamic tag"), line: 1 },
      { message: expect.stringContaining("does not evaluate `<if>`"), line: 2 },
    ]);
    const structuralFirst = parse("<if=x/>\n<$bad/>", {
      unknownTags: "allow",
      structural: "reject",
    });
    expect(structuralFirst.diagnostics).toMatchObject([
      { message: expect.stringContaining("does not evaluate `<if>`"), line: 1 },
      { message: expect.stringContaining("not a tag name"), line: 2 },
    ]);
  });

  it("lets an earlier build-phase error beat a later unknown tag", () => {
    const dynamic = parse("<$" + "{x}/>\n<widget/>");
    expect(dynamic.diagnostics).toMatchObject([
      { message: expect.stringContaining("a dynamic tag"), line: 1, column: 0 },
      { message: expect.stringContaining("`<widget>`"), line: 2, column: 0 },
    ]);
    const doctype = parse("<!doctype html>\n<widget/>");
    expect(doctype.diagnostics).toMatchObject([
      { message: expect.stringContaining("<!doctype>"), line: 1, column: 0 },
      { message: expect.stringContaining("`<widget>`"), line: 2, column: 0 },
    ]);
    const name = parse("<open>\n  <$bad/>\n</open>\n<widget/>");
    expect(name.diagnostics.map((d) => d.line)).toEqual([2, 2, 4]);
    expect(name.diagnostics[0]?.message).toContain("not a tag name");
    expect(name.diagnostics[1]?.message).toContain(
      "`<$bad>` is not a known tag",
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

  it("a structural construct that opens before the unknown tag still reports first", () => {
    const { diagnostics } = parse("<open>\n  <if=x><nope/></if>\n</open>", {
      structural: "reject",
    });
    // The `<if>` is first; `<nope>` inside it is a second, independent error.
    expect(diagnostics).toMatchObject([
      { message: expect.stringContaining("does not evaluate `<if>`"), line: 2 },
      {
        message: expect.stringContaining("`<nope>` is not a known tag"),
        line: 2,
      },
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
    const message = (options: ParseDataOptions) =>
      parseData("<wrap/>", "/u.mx", { customTags: tags, ...options })
        .diagnostics[0]?.message;
    const allowed = message({ unknownTags: "allow" });
    expect(allowed).toContain("`<emitted>`'s name carries no span");
    expect(message({ unknownTags: "reject" })).toBe(allowed);
    // An internal build error is never replaced by an unknown-tag hit, even
    // an earlier one: the transform-output limit is a bug to see, not a source
    // error to hide (round 3, item 4). It is reported beside the unknown tag,
    // under the `internal error:` prefix. Flips with `data-transform-output-tree`.
    expect(parse("<bogus/>\n<wrap/>", {}, tags).diagnostics).toMatchObject([
      {
        message: expect.stringContaining("`<bogus>` is not a known tag"),
        line: 1,
      },
      {
        message: expect.stringMatching(
          /^internal error: .*`<emitted>`'s name carries no span/,
        ),
        line: 1,
        column: 0,
      },
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

describe("walk order: attribute tags and children in source order", () => {
  const tags: Record<string, CustomTag> = {
    known: { attributeTags: { meta: { repeatable: true } } },
    a: { attributes: {} },
  };
  const where = (source: string, options: ParseDataOptions = {}) => {
    const { diagnostics } = parse(source, options, tags);
    const d = diagnostics[0];
    return d ? `${d.line}:${d.column} ${d.message.slice(0, 40)}` : "none";
  };

  it("structural against structural: the earlier text wins over a later attribute tag", () => {
    expect(
      where("<known>\n  <a>hello</a>\n  <@meta>bye</@meta>\n</known>", {
        structural: "reject",
      }),
    ).toMatch(/^2:5 the data tree is static/);
  });

  it("structural against structural: an earlier <if> wins over a later attribute-tag <if>", () => {
    // A contract-less parent (`unknownTags` left at "allow"): a declared tag's
    // contract refuses attribute-tag control flow before the walk runs.
    expect(
      where(
        "<loose>\n  <if=x>\n    <a/>\n  </if>\n  <@meta>\n    <if=y>\n      <@m/>\n    </if>\n  </@meta>\n</loose>",
        { structural: "reject", unknownTags: "allow" },
      ),
    ).toMatch(/^2:2 the data tree is static/);
  });

  it("build against build: the earlier dynamic tag wins over a later doctype", () => {
    expect(
      where(
        "<known>\n  <${x}/>\n  <@meta>\n    <!doctype html>\n  </@meta>\n</known>",
      ),
    ).toMatch(/^2:2 a dynamic tag/);
  });

  it("across categories: an earlier text beats a later unknown tag and attribute tag", () => {
    expect(
      where(
        "<known>\n  <a>hello</a>\n  <bogus/>\n  <@meta>bye</@meta>\n</known>",
        { structural: "reject" },
      ),
    ).toMatch(/^2:5 the data tree is static/);
  });

  it("across categories: an earlier dynamic tag beats a later unknown tag and doctype", () => {
    expect(
      where(
        "<known>\n  <${x}/>\n  <bogus/>\n  <@meta>\n    <!doctype html>\n  </@meta>\n</known>",
      ),
    ).toMatch(/^2:2 a dynamic tag/);
  });

  it("core-error path: the earliest unknown tag wins over a later one in an attribute tag", () => {
    // `<else/>` and `<define/>` are core errors raised after both unknowns.
    for (const late of ["<else/>", "<define/>"]) {
      expect(
        where(
          `<known>\n  <bogus1/>\n  <@meta>\n    <bogus2/>\n  </@meta>\n</known>\n${late}`,
        ),
      ).toMatch(/^2:2 `<bogus1>` is not a known tag/);
    }
  });

  it("core-error path: an unknown tag opening before the core error is reported, not the error", () => {
    expect(
      where(
        "<known>\n  <bogus1/>\n  <@meta><a/></@meta>\n  <try/>\n  <@meta><bogus2/></@meta>\n</known>",
      ),
    ).toMatch(/^2:2 `<bogus1>` is not a known tag/);
  });

  it("keeps attrTags and children as separate arrays in the tree", () => {
    const { tree } = parse(
      "<known>\n  <a/>\n  <@meta/>\n  <a/>\n</known>",
      { unknownTags: "allow" },
      tags,
    );
    const known = tree?.children[0];
    expect(known?.kind === "tag" && known.attrTags.map((n) => n.kind)).toEqual([
      "attr-tag",
    ]);
    expect(known?.kind === "tag" && known.children.length).toBe(2);
  });
});

// Decision 146: `tag:name` and `:name` are sugar; the parse-only scan reads
// Marko's raw tree, so it applies core's `sugarTagName` rule to each name.
describe("name sugar in the parse-only scan", () => {
  it("`resource:post` is the known tag `resource`, so the real error shows", () => {
    const { diagnostics } = parse("resource:post\nrelationships\n");
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<relationships>` must be inside `<resource>`; found at the top level",
        line: 2,
        column: 0,
      },
    ]);
  });

  it("the HTML form `<resource:post/>` is the same", () => {
    const { diagnostics } = parse("<resource:post/>\n<relationships/>\n");
    expect(diagnostics).toMatchObject([
      {
        message: expect.stringContaining("`<relationships>` must be inside"),
        line: 2,
      },
    ]);
  });

  it("`:title` is an unnamed tag, so it gets the default tag", () => {
    const { diagnostics } = parse(
      "resource\n  attributes\n    :title\nrelationships\n",
      {},
      { ...customTags, object: {} },
    );
    expect(diagnostics.map((d) => d.message).join("\n")).not.toContain(
      "`<:title>`",
    );
  });

  it("a real unknown name before a colon is still reported as that name", () => {
    const { diagnostics } = parse("widget:post\n");
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<widget>` is not a known tag: it has no contract in `customTags`",
        line: 1,
        column: 0,
      },
    ]);
  });
});

describe("wildcard children (decision 147) under unknownTags: reject", () => {
  const tags: Record<string, CustomTag> = {
    attribute: { attributes: { value: { type: "string" } } },
    resource: {
      parents: ["#root"],
      children: {
        "*": [
          { pattern: "[a-z]+", contract: "attribute" },
          { pattern: "[A-Z]+", attributes: { value: { type: "string" } } },
        ],
      },
    },
  };

  it("a child a contract claims is known, by reference and inline", () => {
    const { tree, diagnostics } = parse(
      "<resource>\n  <title value='a'/>\n  <PORT value='b'/>\n</resource>\n",
      {},
      tags,
    );
    expect(diagnostics).toEqual([]);
    expect(tree).toBeDefined();
  });

  it("a wildcard child is known on the core-error path too", () => {
    // `<title>` is claimed, so the parse-only scan must not name it; the real
    // error (a bad attribute on the claimed child) is the one reported.
    const { diagnostics } = parse(
      "<resource>\n  <title nope='a'/>\n</resource>\n",
      {},
      tags,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).not.toContain("is not a known tag");
  });

  it("an unmatched name inside the contract parent is the E2 error", () => {
    const { diagnostics } = parse(
      "<resource>\n  <T1 value='a'/>\n</resource>\n",
      {},
      tags,
    );
    expect(diagnostics[0]?.message).toContain("is not allowed here");
  });

  it("an unclaimed name outside any contract is still unknown", () => {
    const { diagnostics } = parse("<title value='a'/>\n", {}, tags);
    expect(diagnostics[0]?.message).toContain("is not a known tag");
  });

  it("the guard is an error diagnostic", () => {
    const withNear: Record<string, CustomTag> = {
      ...tags,
      resource: {
        parents: ["#root"],
        children: {
          attribute: {},
          "*": [{ pattern: "[a-z]+", contract: "attribute" }],
        },
      },
    };
    const { diagnostics } = parse(
      "<resource>\n  <attribut value='a'/>\n</resource>\n",
      {},
      withNear,
    );
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      message: expect.stringContaining("did you mean the explicit child"),
    });
  });
});
