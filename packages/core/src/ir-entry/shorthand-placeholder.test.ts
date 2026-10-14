// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
import { describe, expect, it } from "vitest";
import { lowerSource } from "./index.ts";

/**
 * A shorthand `id` or `class` with a placeholder (`<div#a${y}/>`,
 * `<div.${y}-b/>`) lowers through the IR entry point. The value is the
 * template literal (or, for several class words, the array) core builds over
 * the authored word; its `span` is the word run after the first sigil, so
 * `code` is not the source sliced by `span`. A shorthand class beside an
 * authored `class` attribute has no such range and stays refused.
 */

interface Found {
  name: string;
  kind: string;
  code: string | undefined;
  /** The source the value's span covers. */
  text: string | undefined;
  span: { sourceStart: number; sourceEnd: number } | undefined;
}

/** The fields of an IR attribute this file reads. */
interface RawAttr {
  name: string;
  kind: string;
  value?: string | { code?: string; span?: Found["span"] };
  valueSpan?: Found["span"];
}

/** Every `id` and `class` attribute in the IR, in tree order. */
function idAndClass(source: string, node: unknown, out: Found[] = []): Found[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) idAndClass(source, item, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.attrs)) {
    for (const attr of record.attrs as RawAttr[]) {
      if (attr.name !== "id" && attr.name !== "class") continue;
      const span =
        attr.kind === "static"
          ? attr.valueSpan
          : typeof attr.value === "object"
            ? attr.value.span
            : undefined;
      out.push({
        name: attr.name,
        kind: attr.kind,
        code:
          attr.kind === "static"
            ? JSON.stringify(attr.value)
            : typeof attr.value === "object"
              ? attr.value.code
              : undefined,
        text: span && source.slice(span.sourceStart, span.sourceEnd),
        span,
      });
    }
  }
  for (const value of Object.values(record)) idAndClass(source, value, out);
  return out;
}

function lower(source: string, tagRules?: "none") {
  return lowerSource(source, "/shorthand.mx", {
    structural: "pass",
    imports: "pass",
    unknownTags: "allow",
    ...(tagRules ? { tagRules } : {}),
  });
}

const ROWS: [label: string, source: string, expected: Omit<Found, "text">[]][] =
  [
    [
      "id, placeholder last",
      "<div#a${y}/>\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`a${y}`",
          span: { sourceStart: 5, sourceEnd: 10 },
        },
      ],
    ],
    [
      "id, placeholder first",
      "<div#${y}-a/>\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`${y}-a`",
          span: { sourceStart: 5, sourceEnd: 11 },
        },
      ],
    ],
    [
      "id, two placeholders",
      "<div#a${x}b${y}/>\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`a${x}b${y}`",
          span: { sourceStart: 5, sourceEnd: 15 },
        },
      ],
    ],
    [
      "id that is a placeholder alone (the expression, as before)",
      "<div#${y}/>\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "y",
          span: { sourceStart: 7, sourceEnd: 8 },
        },
      ],
    ],
    [
      "class, placeholder last",
      "<div.a${y}/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: "`a${y}`",
          span: { sourceStart: 5, sourceEnd: 10 },
        },
      ],
    ],
    [
      "class, placeholder first",
      "<div.${y}-b/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: "`${y}-b`",
          span: { sourceStart: 5, sourceEnd: 11 },
        },
      ],
    ],
    [
      "class with a placeholder word and a static word",
      "<div.a${y}.b/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: '[`a${y}`, "b"]',
          span: { sourceStart: 5, sourceEnd: 12 },
        },
      ],
    ],
    [
      "class, a static word then a placeholder word",
      "<div.b.a${y}/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: '["b", `a${y}`]',
          span: { sourceStart: 5, sourceEnd: 12 },
        },
      ],
    ],
    [
      "class, two placeholder words",
      "<div.a${y}.c${z}/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: "[`a${y}`, `c${z}`]",
          span: { sourceStart: 5, sourceEnd: 16 },
        },
      ],
    ],
    [
      "class, a placeholder alone and a static word",
      "<div.${y}.b/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: '[y, "b"]',
          span: { sourceStart: 5, sourceEnd: 11 },
        },
      ],
    ],
    [
      "id and class, each with a placeholder",
      "<div#a${x}.b${y}/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: "`b${y}`",
          span: { sourceStart: 11, sourceEnd: 16 },
        },
        {
          name: "id",
          kind: "dynamic",
          code: "`a${x}`",
          span: { sourceStart: 5, sourceEnd: 10 },
        },
      ],
    ],
    [
      "a class run that crosses an id",
      "<div.a${y}#i.b/>\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: '[`a${y}`, "b"]',
          span: { sourceStart: 5, sourceEnd: 14 },
        },
        {
          name: "id",
          kind: "static",
          code: '"i"',
          span: { sourceStart: 11, sourceEnd: 12 },
        },
      ],
    ],
    [
      "concise id",
      "div#a${y}\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`a${y}`",
          span: { sourceStart: 4, sourceEnd: 9 },
        },
      ],
    ],
    [
      "concise class with a body",
      "div.a${y} -- text\n",
      [
        {
          name: "class",
          kind: "dynamic",
          code: "`a${y}`",
          span: { sourceStart: 4, sourceEnd: 9 },
        },
      ],
    ],
    [
      "a custom tag",
      "<x#a${y}/>\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`a${y}`",
          span: { sourceStart: 3, sourceEnd: 8 },
        },
      ],
    ],
    [
      "inside a body, after a multi-unit character",
      "<p>\u{1F600}</p>\n<div#a${y}/>\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`a${y}`",
          span: { sourceStart: 15, sourceEnd: 20 },
        },
      ],
    ],
    [
      "a placeholder with a nested template",
      "<div#a${`${y}`}/>\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`a${`${y}`}`",
          span: { sourceStart: 5, sourceEnd: 15 },
        },
      ],
    ],
    [
      "CRLF line ends",
      "<p/>\r\n<div#a${y}/>\r\n",
      [
        {
          name: "id",
          kind: "dynamic",
          code: "`a${y}`",
          span: { sourceStart: 11, sourceEnd: 16 },
        },
      ],
    ],
  ];

describe.each([
  ["default (strict) tag rules", undefined],
  ['`tagRules: "none"`', "none" as const],
])("a shorthand with a placeholder lowers, %s", (_label, tagRules) => {
  it.each(ROWS)("%s", (_row, source, expected) => {
    const { ir, diagnostics } = lower(source, tagRules);
    expect(diagnostics).toEqual([]);
    const found = idAndClass(source, ir);
    // The attribute order in the tree is not the contract: compare by name.
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);
    expect(found.map(({ text: _text, ...rest }) => rest).sort(byName)).toEqual(
      [...expected].sort(byName),
    );
    for (const attr of found) {
      // `span` is the authored source, which is not `code` here.
      expect(attr.text, `${attr.name} span`).toBeDefined();
      expect(attr.text).toBe(
        source.slice(attr.span?.sourceStart, attr.span?.sourceEnd),
      );
    }
  });

  it("covers the authored word run after the first sigil, as text", () => {
    const cases: [string, string][] = [
      ["<div#a${y}/>\n", "a${y}"],
      ["<div#${y}-a/>\n", "${y}-a"],
      ["<div.a${y}.b/>\n", "a${y}.b"],
      ["<div.a${y}.c${z}/>\n", "a${y}.c${z}"],
      ["div.a${y} -- text\n", "a${y}"],
    ];
    for (const [source, text] of cases) {
      const [only] = idAndClass(source, lower(source, tagRules).ir);
      expect(only?.text, source).toBe(text);
    }
  });

  it("keeps a plain shorthand as it was", () => {
    const [id] = idAndClass("<div#a/>\n", lower("<div#a/>\n", tagRules).ir);
    expect(id).toMatchObject({ kind: "static", text: "a" });
    const [cls] = idAndClass(
      "<div.a.b/>\n",
      lower("<div.a.b/>\n", tagRules).ir,
    );
    expect(cls).toMatchObject({ kind: "static", code: '"a b"', text: "a.b" });
  });

  it("still refuses a shorthand class beside a class attribute, at the tag", () => {
    for (const source of ['<div.a${y} class="c"/>\n', '<div.a class="c"/>\n']) {
      const { ir, diagnostics } = lower(source, tagRules);
      expect(ir, source).toBeUndefined();
      expect(diagnostics, source).toHaveLength(1);
      expect(diagnostics[0]?.message).toMatch(
        /together with a `class` attribute/,
      );
      expect(diagnostics[0]).toMatchObject({ line: 1, column: 0 });
    }
  });
});
