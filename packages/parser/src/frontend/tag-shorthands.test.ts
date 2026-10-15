// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * `tagShorthands: false` at the front end: the dotted name is one static
 * tag name, with no shorthand part and no class attribute; the refused heads
 * are template errors that carry `MX_NO_TAG_SHORTHAND` / `MX_INVALID_TAG_NAME`
 * with the character they refuse underlined.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SYNTAX, type SyntaxTable } from "../template/syntax.ts";
import { type ParseOptions, parse } from "./parse.ts";
import { OPTIONS } from "./test-support/options.ts";

// biome-ignore lint/suspicious/noExplicitAny: test rows read nested fields
type Any = any;

const OFF: SyntaxTable = { ...DEFAULT_SYNTAX, tagShorthands: false };

const doc = (source: string, options: Partial<ParseOptions> = {}): Any =>
  parse(source, { ...OPTIONS, syntax: OFF, ...options });

/** Every error as `CODE origin [start,end)`. */
const errors = (d: Any): string[] =>
  d.errors.map((e: Any) => `${e.code} ${e.origin} [${e.start},${e.end})`);

describe("tagShorthands: false at the front end", () => {
  it("a dotted name is one static name: concise", () => {
    const d = doc("billing.InvoiceVoided\n  span\n");
    expect(d.errors).toEqual([]);
    const tag = d.body[0];
    expect(tag.type).toBe("MxTag");
    expect(tag.name).toMatchObject({
      kind: "static",
      value: "billing.InvoiceVoided",
    });
    expect(tag.shorthands).toEqual([]);
    expect(tag.attributes).toEqual([]);
    expect(tag.body[0].name.value).toBe("span");
  });

  it("a dotted name is one static name: HTML, with its closing tag", () => {
    const d = doc("<billing.InvoiceVoided>hi</billing.InvoiceVoided>");
    expect(d.errors).toEqual([]);
    expect(d.complete).toBe(true);
    const tag = d.body[0];
    expect(tag.name).toMatchObject({
      kind: "static",
      value: "billing.InvoiceVoided",
      span: { start: 1, end: 22 },
    });
    expect(tag.shorthands).toEqual([]);
    expect(tag.closeTag).not.toBeNull();
  });

  it("the dotted name keeps its attributes and an attribute tag keeps its dots", () => {
    const d = doc(
      "<billing.InvoiceVoided id=1><@a.b/></billing.InvoiceVoided>",
    );
    expect(d.errors).toEqual([]);
    const tag = d.body[0];
    expect(tag.attributes.map((a: Any) => a.name)).toEqual(["id"]);
    expect(tag.body[0].type).toBe("MxAttributeTag");
  });

  it("the closing tag must be the whole dotted name", () => {
    expect(errors(doc("<a.b></a>"))).toEqual([
      "MISMATCHED_CLOSING_TAG template [5,9)",
    ]);
    expect(errors(doc("<a></a.b>"))).toEqual([
      "MISMATCHED_CLOSING_TAG template [3,9)",
    ]);
  });

  it("the default row and `true` still split the name", () => {
    for (const syntax of [
      undefined,
      DEFAULT_SYNTAX,
      { ...DEFAULT_SYNTAX, tagShorthands: true },
    ]) {
      const d = doc("billing.InvoiceVoided", { syntax });
      expect(d.errors).toEqual([]);
      expect(d.body[0].name.value).toBe("billing");
      expect(d.body[0].shorthands).toHaveLength(1);
    }
  });

  it("the tag type of a dotted name comes from its whole name (tagShape is asked for it)", () => {
    const asked: string[] = [];
    const d = doc("hr.rule\np", {
      tagShape: (name) => {
        asked.push(name);
        return name === "hr.rule" ? "void" : "html";
      },
    });
    expect(asked).toContain("hr.rule");
    // The pre-scan itself must not stop at the dot; a restart would hide that.
    expect(asked).not.toContain("hr");
    expect(d.errors).toEqual([]);
    // A void tag has no body: `p` is its sibling.
    expect(d.body.map((n: Any) => n.name.value)).toEqual(["hr.rule", "p"]);
  });

  describe("the refused heads", () => {
    it.each([
      ["a#b", "MX_NO_TAG_SHORTHAND template [1,2)"],
      ["<a#b/>", "MX_NO_TAG_SHORTHAND template [2,3)"],
      ["a.b#c", "MX_NO_TAG_SHORTHAND template [3,4)"],
      ["#x", "MX_NO_TAG_SHORTHAND template [0,1)"],
      [".x", "MX_NO_TAG_SHORTHAND template [0,1)"],
      ["<.x/>", "MX_NO_TAG_SHORTHAND template [1,2)"],
      ["<#x/>", "MX_NO_TAG_SHORTHAND template [1,2)"],
      ["p\n  .x", "MX_NO_TAG_SHORTHAND template [4,5)"],
      ["a.", "MX_INVALID_TAG_NAME template [1,2)"],
      ["<a./>", "MX_INVALID_TAG_NAME template [2,3)"],
      ["a..b", "MX_INVALID_TAG_NAME template [1,3)"],
      ["${x}.y", "MX_INVALID_TAG_NAME template [4,5)"],
      ["<${x}.y/>", "MX_INVALID_TAG_NAME template [5,6)"],
    ])("%j", (source, expected) => {
      const d = doc(source);
      expect(errors(d)).toEqual([expected]);
      expect(d.complete).toBe(false);
    });

    it("the message states the rule and the fix", () => {
      expect(doc("a#b").errors[0].message).toMatch(
        /^`#` is not allowed in a tag name: this file's dialect has no `#id` shorthand; write the id as an attribute/,
      );
      expect(doc(".x").errors[0].message).toMatch(
        /^a tag name cannot start with `\.`.*write the class as an attribute/,
      );
      expect(doc("a.").errors[0].message).toMatch(
        /^a tag name cannot have an empty part.*`billing\.InvoiceVoided`/,
      );
      expect(doc("${x}.y").errors[0].message).toMatch(
        /^a `\.` cannot follow a `\$\{…\}` in a tag name/,
      );
    });

    it("none of the same sources is an error under the default row", () => {
      for (const source of [
        "a#b",
        ".x",
        "<#x/>",
        "a.b#c",
        "a.",
        "a..b",
        "${x}.y",
      ]) {
        expect(doc(source, { syntax: DEFAULT_SYNTAX }).errors).toEqual([]);
      }
    });
  });
});
