import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

// Tag names that collide with an `Object.prototype` member. Stock Marko 6.3.51
// crashes on all of them (`taglib.getTag` indexes a plain object); MX treats
// them as ordinary tag names (divergences.md).
const NAMES = [
  "toString",
  "constructor",
  "hasOwnProperty",
  "valueOf",
  "__proto__",
] as const;

function tagNamed(
  tree: ReturnType<typeof parseData>["tree"],
  name: string,
): { name: string; children: unknown[] } | undefined {
  const children = (tree?.children ?? []) as Array<{
    kind: string;
    name?: string;
    children: unknown[];
  }>;
  return children.find((c) => c.kind === "tag" && c.name === name) as
    | { name: string; children: unknown[] }
    | undefined;
}

describe('unknownTags: "allow"', () => {
  it.each(NAMES)("<%s/> is an ordinary data tag", (name) => {
    const { tree, diagnostics } = parseData(`<${name}/>\n`, "/p.mx", {
      unknownTags: "allow",
    });
    expect(diagnostics).toEqual([]);
    expect(tagNamed(tree, name)).toBeDefined();
  });

  it.each(NAMES)("<%s> nests children like any other tag", (name) => {
    const { tree, diagnostics } = parseData(
      `<${name}>\n  <inner/>\n</${name}>\n`,
      "/p.mx",
      { unknownTags: "allow" },
    );
    expect(diagnostics).toEqual([]);
    expect(tagNamed(tree, name)?.children).toHaveLength(1);
  });
});

describe('unknownTags: "reject"', () => {
  it.each(NAMES)("<%s/> is the normal unknown-tag error", (name) => {
    const { tree, diagnostics } = parseData(`<${name}/>\n`, "/p.mx", {
      unknownTags: "reject",
      customTags: { other: {} },
    });
    expect(tree).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message: `\`<${name}>\` is not a known tag: it has no contract in \`customTags\``,
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });

  it("a nested prototype-named tag is positioned at its own `<`", () => {
    const { diagnostics } = parseData(
      "<outer>\n  <toString/>\n</outer>\n",
      "/p.mx",
      { unknownTags: "reject", customTags: { outer: {} } },
    );
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<toString>` is not a known tag: it has no contract in `customTags`",
        line: 2,
        column: 2,
      },
    ]);
  });

  it("hints a close declared name", () => {
    const { diagnostics } = parseData("<valueof/>\n", "/p.mx", {
      unknownTags: "reject",
      customTags: { valueOf: {} },
    });
    expect(diagnostics).toMatchObject([
      { message: expect.stringContaining("did you mean `<valueOf>`?") },
    ]);
  });
});

describe("customTags keyed by a prototype member name", () => {
  it.each(NAMES)("a declared `%s` works as a contract", (name) => {
    const customTags: Record<string, CustomTag> = Object.defineProperty(
      {},
      name,
      {
        value: { attributes: { label: { type: "string" } } },
        enumerable: true,
      },
    );
    const { tree, diagnostics } = parseData(`<${name} label="a"/>\n`, "/p.mx", {
      customTags,
      unknownTags: "reject",
    });
    expect(diagnostics).toEqual([]);
    expect(JSON.stringify(tree)).toContain(`"${name}"`);
  });

  it("an undeclared prototype name is not mistaken for a declared tag", () => {
    const { tree, diagnostics } = parseData(`<other/>\n`, "/p.mx", {
      customTags: { toString: {} },
      unknownTags: "reject",
    });
    expect(tree).toBeUndefined();
    expect(diagnostics[0]?.message).toContain("`<other>`");
  });
});

describe("an unknown prototype-named parent above a contract error", () => {
  it('"reject" reports the parent, as for any unknown tag', () => {
    const tags = { child: { parents: ["#root"] } } as Record<string, CustomTag>;
    const { diagnostics } = parseData(
      "<toString>\n  <child/>\n</toString>\n",
      "/p.mx",
      { unknownTags: "reject", customTags: tags },
    );
    expect(diagnostics).toMatchObject([
      {
        message: expect.stringContaining("`<toString>` is not a known tag"),
        line: 1,
      },
    ]);
  });
});
