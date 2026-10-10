import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

// Tag names that collide with an `Object.prototype` member. Stock Marko 6.3.51
// crashes on all of them (`taglib.getTag` indexes a plain object); MX treats
// them as ordinary tag names (divergences.md). Core's `tag-table.test.ts`
// pins the lookup layer for these names; none of its cases runs one through
// the entry point's `unknownTags` check or a custom-tag contract.
const NAMES = [
  "toString",
  "constructor",
  "hasOwnProperty",
  "valueOf",
  "__proto__",
] as const;

function parse(source: string, options: LowerSourceOptions = {}) {
  return lowerSource(source, "/p.mx", options);
}

/** The root `DelegatedTag` named `name`, or undefined. */
function tagNamed(ir: ReturnType<typeof parse>["ir"], name: string) {
  for (const node of ir?.body ?? []) {
    if (node.kind === "DelegatedTag" && node.tag.name === name) return node.tag;
  }
  return undefined;
}

describe('unknownTags: "allow"', () => {
  it.each(NAMES)("<%s/> is an ordinary data tag", (name) => {
    const { ir, diagnostics } = parse(`<${name}/>\n`, {
      unknownTags: "allow",
    });
    expect(diagnostics).toEqual([]);
    expect(tagNamed(ir, name)).toBeDefined();
  });

  it.each(NAMES)("<%s> nests children like any other tag", (name) => {
    const { ir, diagnostics } = parse(`<${name}>\n  <inner/>\n</${name}>\n`, {
      unknownTags: "allow",
    });
    expect(diagnostics).toEqual([]);
    expect(tagNamed(ir, name)?.children).toHaveLength(1);
  });
});

describe('unknownTags: "reject"', () => {
  it.each(NAMES)("<%s/> is the normal unknown-tag error", (name) => {
    const { ir, diagnostics } = parse(`<${name}/>\n`, {
      unknownTags: "reject",
      customTags: { other: {} },
    });
    expect(ir).toBeUndefined();
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
    const { diagnostics } = parse("<outer>\n  <toString/>\n</outer>\n", {
      unknownTags: "reject",
      customTags: { outer: {} },
    });
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
    const { diagnostics } = parse("<valueof/>\n", {
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
    const { ir, diagnostics } = parse(`<${name} label="a"/>\n`, {
      customTags,
      unknownTags: "reject",
    });
    expect(diagnostics).toEqual([]);
    const tag = tagNamed(ir, name);
    expect(tag?.attrs).toMatchObject([
      { kind: "static", name: "label", value: "a" },
    ]);
  });

  it("an undeclared prototype name is not mistaken for a declared tag", () => {
    const { ir, diagnostics } = parse(`<other/>\n`, {
      customTags: { toString: {} },
      unknownTags: "reject",
    });
    expect(ir).toBeUndefined();
    expect(diagnostics[0]?.message).toContain("`<other>`");
  });
});

describe("an unknown prototype-named parent above a contract error", () => {
  it('"reject" reports the parent, as for any unknown tag', () => {
    const tags = { child: { parents: ["#root"] } } as Record<string, CustomTag>;
    const { diagnostics } = parse("<toString>\n  <child/>\n</toString>\n", {
      unknownTags: "reject",
      customTags: tags,
    });
    expect(diagnostics).toMatchObject([
      {
        message: expect.stringContaining("`<toString>` is not a known tag"),
        line: 1,
      },
      {
        message: expect.stringContaining("`<child>` must be at the top level"),
        line: 2,
      },
    ]);
  });
});
