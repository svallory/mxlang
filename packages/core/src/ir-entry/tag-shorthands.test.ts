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
