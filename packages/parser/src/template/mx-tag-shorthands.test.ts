// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the cases are MX source, whose `${…}` is a placeholder, not a JS template
/**
 * `tagShorthands` (a syntax table field, `@unstable`) at the template
 * parser. `true` (the default) is today's grammar: `.class` and `#id` in a
 * tag head are shorthands. `false` is the JSX member-tag reading: `.`
 * continues the tag name, `#` is refused, and a head that starts with `.` or
 * `#` (an implicit `div`) is refused, never read as a shorthand.
 *
 * Each row is rendered as the events the parser announced, in order:
 * `<name>` (the open tag name), `class(.x)` / `id(#x)` (a shorthand), `</name>` (a
 * closing tag that matched), `ERR(start-end #code message)`.
 */
import { describe, expect, it } from "vitest";
import {
  createParser,
  DEFAULT_SYNTAX,
  ErrorCode,
  type SyntaxTable,
  validateSyntaxTable,
} from "./index.ts";

const OFF: SyntaxTable = { ...DEFAULT_SYNTAX, tagShorthands: false };
const ON: SyntaxTable = { ...DEFAULT_SYNTAX, tagShorthands: true };

function render(code: string, syntax?: SyntaxTable): string {
  const out: string[] = [];
  const parser = createParser(
    {
      onError: (e) =>
        out.push(`ERR(${e.start}-${e.end} #${e.code} ${e.message})`),
      onOpenTagName: (t) => {
        out.push(`<${code.slice(t.start, t.end)}>`);
      },
      onTagShorthandClass: (t) =>
        out.push(`class(${code.slice(t.start, t.end)})`),
      onTagShorthandId: (t) => out.push(`id(${code.slice(t.start, t.end)})`),
      onCloseTagName: (r) => out.push(`</${code.slice(r.start, r.end)}>`),
    },
    syntax ? { syntax } : undefined,
  );
  parser.parse(code);
  return out.join(" ");
}

const NO_ID =
  '`#` is not allowed in a tag name: this file\'s dialect has no `#id` shorthand; write the id as an attribute (`id="main"`) or drop the `#`';
const NO_LEAD_DOT =
  'a tag name cannot start with `.`: this file\'s dialect has no `.class` shorthand and no implicit `div`; name the tag and write the class as an attribute (`class="x"`)';
const EMPTY_PART =
  "a tag name cannot have an empty part: a `.` must be followed by a name, as in `billing.InvoiceVoided`, and cannot end the name or follow another `.`";
const AFTER_PLACEHOLDER =
  "a `.` cannot follow a `${…}` in a tag name: a dotted name is plain text (`billing.InvoiceVoided`), or write the whole name as one placeholder";

const NO_TAG_SHORTHAND = ErrorCode.MX_NO_TAG_SHORTHAND;
const INVALID_TAG_NAME = ErrorCode.MX_INVALID_TAG_NAME;

describe("tagShorthands: the field", () => {
  it("the default row is true", () => {
    expect(DEFAULT_SYNTAX.tagShorthands).toBe(true);
  });

  it("true reads as the default row, byte for byte (concise and HTML)", () => {
    for (const code of [
      "a.b#c",
      "<a.b#c></a>",
      ".x",
      "<#x/>",
      "a.",
      "<a..b/>",
      "${x}.y",
      "billing.InvoiceVoided\n  span.k",
    ]) {
      expect(render(code, ON)).toBe(render(code));
      expect(render(code, ON)).toBe(render(code, DEFAULT_SYNTAX));
    }
  });

  it("a table that omits the field reads as true", () => {
    const { tagShorthands: _omitted, ...bare } = DEFAULT_SYNTAX;
    expect(validateSyntaxTable(bare as SyntaxTable)).toEqual([]);
    expect(render("a.b", bare as SyntaxTable)).toBe(render("a.b"));
  });

  it("validates as a boolean", () => {
    expect(validateSyntaxTable(OFF)).toEqual([]);
    expect(validateSyntaxTable(ON)).toEqual([]);
    for (const bad of ["false", 0, null, {}, "no"]) {
      expect(
        validateSyntaxTable({
          ...DEFAULT_SYNTAX,
          tagShorthands: bad,
        } as unknown as SyntaxTable),
      ).toEqual([
        {
          field: "tagShorthands",
          message: "`tagShorthands` is a boolean",
        },
      ]);
    }
  });

  it("createParser throws a TypeError for a non-boolean", () => {
    expect(() =>
      createParser(
        {},
        {
          syntax: {
            ...DEFAULT_SYNTAX,
            tagShorthands: "off",
          } as unknown as SyntaxTable,
        },
      ),
    ).toThrow(/tagShorthands/);
  });
});

describe("tagShorthands: false, a dot continues the name", () => {
  it.each([
    // Concise.
    ["billing.InvoiceVoided", "<billing.InvoiceVoided>"],
    ["billing.InvoiceVoided x=1", "<billing.InvoiceVoided>"],
    ["a.b.c", "<a.b.c>"],
    ["billing.InvoiceVoided\n  span", "<billing.InvoiceVoided> <span>"],
    ["a.b(1)", "<a.b>"],
    ["a.b|x|", "<a.b>"],
    ["a.b/v", "<a.b>"],
    ["a.b,", "<a.b>"],
    ["a.b[x]", "<a.b>"],
    // HTML.
    ["<billing.InvoiceVoided/>", "<billing.InvoiceVoided>"],
    [
      "<billing.InvoiceVoided></billing.InvoiceVoided>",
      "<billing.InvoiceVoided> </billing.InvoiceVoided>",
    ],
    ["<a.b.c>text</a.b.c>", "<a.b.c> </a.b.c>"],
    ["<a.b x=1/>", "<a.b>"],
    // A `.` before a `${…}` keeps the name going; the part is dynamic.
    ["<a.${x}/>", "<a.${x}>"],
    ["a.${x}", "<a.${x}>"],
    // `@` tags keep their dots too.
    ["<div><@a.b/></div>", "<div> <@a.b> </div>"],
    // Lowercase, digits, `$` and `_` are ordinary name characters.
    ["a.b1._c.$d", "<a.b1._c.$d>"],
  ])("%j", (code, expected) => {
    expect(render(code, OFF)).toBe(expected);
  });

  it("the closing tag must be the whole dotted name", () => {
    expect(render("<a.b></a>", OFF)).toMatch(/^<a\.b> ERR\(\d+-\d+ #21 /);
    expect(render("<a></a.b>", OFF)).toMatch(/^<a> ERR\(\d+-\d+ #21 /);
    expect(render("<a.b></a.c>", OFF)).toMatch(/^<a\.b> ERR\(\d+-\d+ #21 /);
  });

  it("the same sources under the default row split the name", () => {
    expect(render("billing.InvoiceVoided", ON)).toBe(
      "<billing> class(.InvoiceVoided)",
    );
    expect(render("<a.b></a>", ON)).toBe("<a> class(.b) </a>");
  });
});

describe("tagShorthands: false, # is refused", () => {
  it.each([
    // `#` anywhere in a head: the error is the `#` itself. The open tag name
    // is announced only once the name is complete, so the tag that is
    // refused is not announced.
    ["a#b", `ERR(1-2 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["<a#b/>", `ERR(2-3 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["a.b#c", `ERR(3-4 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["<a.b#c></a.b>", `ERR(4-5 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["a#b#c", `ERR(1-2 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["<div><@a#b/></div>", `<div> ERR(8-9 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["div\n  span#k", `<div> ERR(10-11 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    // A head that starts with `#`: never an implicit div.
    ["#x", `ERR(0-1 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["<#x/>", `ERR(1-2 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    ["div\n  #x", `<div> ERR(6-7 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    // After a placeholder.
    ["${x}#y", `ERR(4-5 #${NO_TAG_SHORTHAND} ${NO_ID})`],
    // The `#` of an `#id` before a name part: the first `#` is the error.
    ["a.b.#c", `ERR(4-5 #${NO_TAG_SHORTHAND} ${NO_ID})`],
  ])("%j", (code, expected) => {
    expect(render(code, OFF)).toBe(expected);
  });

  it("the default row reads `#b` as an id shorthand", () => {
    expect(render("a#b", ON)).toBe("<a> id(#b)");
  });
});

describe("tagShorthands: false, a head starting with . is refused", () => {
  it.each([
    [".x", `ERR(0-1 #${NO_TAG_SHORTHAND} ${NO_LEAD_DOT})`],
    ["<.x/>", `ERR(1-2 #${NO_TAG_SHORTHAND} ${NO_LEAD_DOT})`],
    ["<.x></.x>", `ERR(1-2 #${NO_TAG_SHORTHAND} ${NO_LEAD_DOT})`],
    ["div\n  .x", `<div> ERR(6-7 #${NO_TAG_SHORTHAND} ${NO_LEAD_DOT})`],
    [".x.y", `ERR(0-1 #${NO_TAG_SHORTHAND} ${NO_LEAD_DOT})`],
    ["..x", `ERR(0-1 #${NO_TAG_SHORTHAND} ${NO_LEAD_DOT})`],
  ])("%j", (code, expected) => {
    expect(render(code, OFF)).toBe(expected);
  });

  it("an implicit div under the default row", () => {
    expect(render(".x", ON)).toBe("<> class(.x)");
  });
});

describe("tagShorthands: false, an empty part of a dotted name is refused", () => {
  it.each([
    // A trailing `.`.
    ["a.", `ERR(1-2 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["<a./>", `ERR(2-3 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["<a.>", `ERR(2-3 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["a. x=1", `ERR(1-2 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["a.b.", `ERR(3-4 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["a.\n  b", `ERR(1-2 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["a.(1)", `ERR(1-2 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["a.=1", `ERR(1-2 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    // `..` inside and at the end: the run of dots is the error.
    ["a..b", `ERR(1-3 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["<a..b/>", `ERR(2-4 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["a..", `ERR(1-3 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    ["a...b", `ERR(1-4 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
    // A `.` right after a `${…}`.
    ["${x}.y", `ERR(4-5 #${INVALID_TAG_NAME} ${AFTER_PLACEHOLDER})`],
    ["<${x}.y/>", `ERR(5-6 #${INVALID_TAG_NAME} ${AFTER_PLACEHOLDER})`],
    ["a${x}.y", `ERR(5-6 #${INVALID_TAG_NAME} ${AFTER_PLACEHOLDER})`],
    ["${x}.", `ERR(4-5 #${INVALID_TAG_NAME} ${AFTER_PLACEHOLDER})`],
    ["div\n  span.", `<div> ERR(10-11 #${INVALID_TAG_NAME} ${EMPTY_PART})`],
  ])("%j", (code, expected) => {
    expect(render(code, OFF)).toBe(expected);
  });

  it("a placeholder name with no dot is untouched", () => {
    expect(render("<${x}/>", OFF)).toBe("<${x}>");
    expect(render("<a-${x}-b.c/>", OFF)).toBe("<a-${x}-b.c>");
  });
});
