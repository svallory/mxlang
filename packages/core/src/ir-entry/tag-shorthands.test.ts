// biome-ignore-all lint/suspicious/noTemplateCurlyInString: sources contain `${`
/**
 * `tagShorthands: false` (a syntax table field, `@unstable`) through
 * `lowerSource`: a dialect whose tag names are JSX member names
 * (`billing.InvoiceVoided`), with no `.class`, no `#id` and no implicit
 * `div`. The default (`true`) is every other test's grammar; the cases here
 * are only what the field changes.
 */
import { describe, expect, it } from "vitest";
import { NO_TAG_SHORTHAND_CODE } from "../diagnostic-codes.ts";
import { MX_DIAGNOSTIC_CODES } from "../index.ts";
import type { DelegatedTag, IrNode } from "../ir.ts";
import { type Dialect, defaultSyntax, syntaxHash } from "../syntax-table.ts";
import { type LowerSourceOptions, lowerSource, type Spanned } from "./index.ts";

type Tag = Spanned<DelegatedTag>;

/** A dialect that turns the shorthands off and publishes a wildcard parent. */
const EVENTS: Dialect = {
  id: "events",
  name: "Events",
  table: { tagShorthands: false },
  tagRules: "none",
  contracts: {
    events: { children: { "*": {} } },
  },
};

const OPTIONS: LowerSourceOptions = { dialect: EVENTS };

const tagsIn = (nodes: readonly Spanned<IrNode>[]): Tag[] =>
  nodes.flatMap((node) => (node.kind === "DelegatedTag" ? [node.tag] : []));

describe("tagShorthands: false, a dotted name lowers as one tag", () => {
  it("concise: one wildcard child with the dotted name and no class attribute", () => {
    const result = lowerSource(
      "events\n  billing.InvoiceVoided amount=1\n",
      "/w.events",
      OPTIONS,
    );
    expect(result.diagnostics).toEqual([]);
    const [events] = tagsIn(result.ir?.body ?? []);
    const [child] = tagsIn(events?.children ?? []);
    expect(child?.name).toBe("billing.InvoiceVoided");
    expect(child?.alias).toMatchObject({ authored: "billing.InvoiceVoided" });
    expect(
      child?.attrs.map((a) => (a.kind === "spread" ? "..." : a.name)),
    ).toEqual(["amount"]);
    expect(
      child?.attrs.some((a) => a.kind !== "spread" && a.name === "class"),
    ).toBe(false);
  });

  it("HTML: the same child, with its closing tag", () => {
    const result = lowerSource(
      "<events>\n  <billing.InvoiceVoided></billing.InvoiceVoided>\n</events>\n",
      "/w.events",
      OPTIONS,
    );
    expect(result.diagnostics).toEqual([]);
    const [events] = tagsIn(result.ir?.body ?? []);
    const [child] = tagsIn(events?.children ?? []);
    expect(child?.name).toBe("billing.InvoiceVoided");
    expect(child?.attrs).toEqual([]);
  });

  it("a deeper dotted name and a dotted tag with a body", () => {
    const result = lowerSource(
      "events\n  a.b.c\n    d.e\n",
      "/w.events",
      OPTIONS,
    );
    expect(result.diagnostics).toEqual([]);
    const [events] = tagsIn(result.ir?.body ?? []);
    const [abc] = tagsIn(events?.children ?? []);
    expect(abc?.name).toBe("a.b.c");
    const [de] = tagsIn(abc?.children ?? []);
    expect(de?.name).toBe("d.e");
  });

  it("the same source under the default row is a `billing` tag with a class", () => {
    const result = lowerSource(
      "events\n  billing.InvoiceVoided\n",
      "/w.events",
      { dialect: { ...EVENTS, table: {} } },
    );
    const [events] = tagsIn(result.ir?.body ?? []);
    const [child] = tagsIn(events?.children ?? []);
    expect(child?.name).toBe("billing");
    expect(
      child?.attrs.some((a) => a.kind !== "spread" && a.name === "class"),
    ).toBe(true);
  });
});

describe("tagShorthands: false, the refused heads are positioned diagnostics", () => {
  it.each([
    // [source, code, line, column, endLine, endColumn]
    ["events\n  a#b\n", "MX_NO_TAG_SHORTHAND", 2, 3, 2, 4],
    ["events\n  a.b#c\n", "MX_NO_TAG_SHORTHAND", 2, 5, 2, 6],
    ["events\n  #x\n", "MX_NO_TAG_SHORTHAND", 2, 2, 2, 3],
    ["events\n  .x\n", "MX_NO_TAG_SHORTHAND", 2, 2, 2, 3],
    ["<events><.x/></events>", "MX_NO_TAG_SHORTHAND", 1, 9, 1, 10],
    ["<events><#x/></events>", "MX_NO_TAG_SHORTHAND", 1, 9, 1, 10],
    ["events\n  a.\n", "MX_INVALID_TAG_NAME", 2, 3, 2, 4],
    ["<events><a./></events>", "MX_INVALID_TAG_NAME", 1, 10, 1, 11],
    ["events\n  a..b\n", "MX_INVALID_TAG_NAME", 2, 3, 2, 5],
    ["events\n  ${x}.y\n", "MX_INVALID_TAG_NAME", 2, 6, 2, 7],
  ])("%j", (source, code, line, column, endLine, endColumn) => {
    const result = lowerSource(source, "/w.events", OPTIONS);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      code,
      line,
      column,
      end: { line: endLine, column: endColumn },
    });
  });

  it("the messages state the rule and the fix", () => {
    const message = (source: string) =>
      lowerSource(source, "/w.events", OPTIONS).diagnostics[0]?.message;
    expect(message("events\n  a#b\n")).toBe(
      '`#` is not allowed in a tag name: this file\'s dialect has no `#id` shorthand; write the id as an attribute (`id="main"`) or drop the `#`',
    );
    expect(message("events\n  .x\n")).toMatch(
      /write the class as an attribute/,
    );
    expect(message("events\n  a.\n")).toMatch(/`billing\.InvoiceVoided`/);
  });

  it("neither code is reported under the default row", () => {
    const plain: LowerSourceOptions = { dialect: { ...EVENTS, table: {} } };
    for (const source of [
      "events\n  a#b\n",
      "events\n  .x\n",
      "events\n  a.\n",
    ]) {
      // A wildcard parent may still refuse a built-in name (`.x` is a `div`):
      // only the two codes of this field are absent.
      const codes = lowerSource(source, "/w.events", plain).diagnostics.map(
        (d) => d.code,
      );
      expect(codes).not.toContain("MX_NO_TAG_SHORTHAND");
      expect(codes).not.toContain("MX_INVALID_TAG_NAME");
    }
  });
});

/** What the default row says about a spaced `#id` / `.class` (byte-identical pins). */
const DEFAULT_HINT =
  "a `#id` or `.class` shorthand goes on the tag name with no space (`<div#a>`, `<div.cls>`); otherwise write `id=` or `class=`";

describe("a spaced #id or .class in a tag head, by table", () => {
  const ON: LowerSourceOptions = { dialect: { ...EVENTS, table: {} } };
  const message = (source: string, options: LowerSourceOptions) => {
    const { diagnostics } = lowerSource(source, "/w.events", options);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("MX_INVALID_ATTRIBUTE");
    return diagnostics[0]?.message;
  };
  const SOURCES = (name: string): [string, string][] => [
    ["concise", `events\n  div ${name}\n`],
    ["HTML", `<events><div ${name}></div></events>\n`],
    ["after a bare attribute", `<events><div k ${name}></div></events>\n`],
  ];

  describe.each(SOURCES("#a"))("%s, #a", (_form, source) => {
    it("shorthands on: the hint points at the tag name (unchanged)", () => {
      expect(message(source, ON)).toBe(
        `Invalid attribute name \`#a\` — ${DEFAULT_HINT}`,
      );
    });
    it("shorthands off: states the rule and the fix, no tag-name advice", () => {
      expect(message(source, OPTIONS)).toBe(
        "Invalid attribute name `#a` — this file's dialect has no `#id` shorthand; write `id=` as an attribute",
      );
    });
  });

  describe.each(SOURCES(".a"))("%s, .a", (_form, source) => {
    it("shorthands on: the hint points at the tag name (unchanged)", () => {
      expect(message(source, ON)).toBe(
        `Invalid attribute name \`.a\` — ${DEFAULT_HINT}`,
      );
    });
    it("shorthands off: states the rule and the fix, no tag-name advice", () => {
      expect(message(source, OPTIONS)).toBe(
        "Invalid attribute name `.a` — this file's dialect has no `.class` shorthand; write `class=` as an attribute",
      );
    });
  });

  describe.each(SOURCES("#a.b"))("%s, #a.b", (_form, source) => {
    it("shorthands on (unchanged)", () => {
      expect(message(source, ON)).toBe(
        `Invalid attribute name \`#a.b\` — ${DEFAULT_HINT}`,
      );
    });
    it("shorthands off: the leading character picks the shorthand named", () => {
      expect(message(source, OPTIONS)).toBe(
        "Invalid attribute name `#a.b` — this file's dialect has no `#id` shorthand; write `id=` as an attribute",
      );
    });
  });

  it("a bare table with the field off (no dialect) says the same", () => {
    const table = Object.freeze({ ...defaultSyntax(), tagShorthands: false });
    expect(message("a #x\n", { dialect: table })).toBe(
      "Invalid attribute name `#x` — this file's dialect has no `#id` shorthand; write `id=` as an attribute",
    );
  });

  it("the hint is not the unspaced form's diagnostic: that stays MX_NO_TAG_SHORTHAND", () => {
    const { diagnostics } = lowerSource(
      "events\n  div#a\n",
      "/w.events",
      OPTIONS,
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["MX_NO_TAG_SHORTHAND"]);
  });

  describe("a file with an `analyze` hook (the analyze walk reads the same table)", () => {
    const withAnalyze = (table: Dialect["table"]): LowerSourceOptions => ({
      dialect: {
        ...EVENTS,
        table,
        contracts: {
          events: { children: { "*": {} }, analyze() {} },
        },
      } as Dialect,
    });
    const OFF_ID =
      "Invalid attribute name `#a` — this file's dialect has no `#id` shorthand; write `id=` as an attribute";

    it.each([
      ["concise", "events\n  div #a\n"],
      ["HTML", "<events><div #a></div></events>\n"],
    ])("shorthands off, %s: the new text", (_form, source) => {
      expect(message(source, withAnalyze({ tagShorthands: false }))).toBe(
        OFF_ID,
      );
    });

    it("shorthands off, `.a`", () => {
      expect(
        message(
          "<events><div .a></div></events>\n",
          withAnalyze({ tagShorthands: false }),
        ),
      ).toBe(
        "Invalid attribute name `.a` — this file's dialect has no `.class` shorthand; write `class=` as an attribute",
      );
    });

    it("shorthands on: the default text (unchanged)", () => {
      expect(message("events\n  div #a\n", withAnalyze({}))).toBe(
        `Invalid attribute name \`#a\` — ${DEFAULT_HINT}`,
      );
    });

    it("a bare off table with a custom tag that has an `analyze` hook", () => {
      const table = Object.freeze({ ...defaultSyntax(), tagShorthands: false });
      const { diagnostics } = lowerSource("div #a\nitem\n", "/w.events", {
        dialect: table,
        customTags: { item: { analyze() {} } },
      } as LowerSourceOptions);
      expect(diagnostics.map((d) => d.message)).toEqual([OFF_ID]);
    });
  });

  describe("the file's voice", () => {
    const voiced = (table: Dialect["table"]): LowerSourceOptions => ({
      dialect: {
        ...EVENTS,
        table,
        messageVocabulary: {
          attribute: { one: "option", many: "options" },
          formatTag: ({ name }) => name,
        },
      } as Dialect,
    });

    it("shorthands off: the noun is the dialect's (an option)", () => {
      expect(
        message("events\n  div .a\n", voiced({ tagShorthands: false })),
      ).toBe(
        "Invalid option name `.a` — this file's dialect has no `.class` shorthand; write `class=` as an option",
      );
    });

    it("shorthands on: the tag examples are spelled by the dialect's formatTag", () => {
      expect(message("events\n  div #a\n", voiced({}))).toBe(
        "Invalid option name `#a` — a `#id` or `.class` shorthand goes on the tag name with no space (`div#a`, `div.cls`); otherwise write `id=` or `class=`",
      );
    });
  });
});

describe("tagShorthands: the code and the hash", () => {
  it("MX_NO_TAG_SHORTHAND is in the catalogue under its exported name", () => {
    expect(NO_TAG_SHORTHAND_CODE).toBe("MX_NO_TAG_SHORTHAND");
    expect(MX_DIAGNOSTIC_CODES.map((c) => c.code)).toContain(
      "MX_NO_TAG_SHORTHAND",
    );
  });

  it("true and false hash differently; an overlay of true is the default row", () => {
    const base = defaultSyntax();
    expect(base.tagShorthands).toBe(true);
    expect(syntaxHash({ ...base, tagShorthands: false })).not.toBe(
      syntaxHash(base),
    );
    expect(syntaxHash({ ...base, tagShorthands: true })).toBe(syntaxHash(base));
  });
});

describe("tagShorthands: the explicit `dialect` option", () => {
  it("a bare table with the field set behaves as the dialect does", () => {
    const table = Object.freeze({ ...defaultSyntax(), tagShorthands: false });
    const result = lowerSource("a#b\n", "/w.events", { dialect: table });
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "MX_NO_TAG_SHORTHAND",
    ]);
  });

  it.each(["no", 0, null, {}])("refuses %j as the field's value", (value) => {
    const dialect = { ...EVENTS, table: { tagShorthands: value } } as never;
    const result = lowerSource("events\n", "/w.events", { dialect });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        severity: "error",
        code: "MX_INVALID_DIALECT_MODULE",
        line: 1,
        column: 0,
        message:
          "the `dialect` option is not a valid dialect: `dialect.table.tagShorthands`: `tagShorthands` is a boolean",
      },
    ]);
  });

  it("a dialect whose table is deep-frozen is validated once and reused", () => {
    const frozen = Object.freeze({
      ...EVENTS,
      table: Object.freeze({ tagShorthands: false }),
    });
    for (let i = 0; i < 2; i++) {
      const result = lowerSource("events\n  a.b\n", "/w.events", {
        dialect: frozen,
      });
      expect(result.diagnostics).toEqual([]);
    }
  });
});
