// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * Brief §1.2 B: the front-end `MX_*` rules (PR 2b, ast §3.13), one row each,
 * message and span calibrated byte-for-byte against today's front end
 * (`packages/core/src/name-sugar.ts`, `chunk-src.js`) — the offsets were
 * computed by script; a mismatch is a question to the lead, never an edit.
 * The same rows run against today's lowering in the parse-differential
 * package (`differential.test.ts`, "front-end rules against today's
 * lowering"), which is the live calibration; these rows pin the words.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type ParseOptions, parse, seams } from "./parse.ts";
import { clearShorthandProbe, frontEndRules as realRules } from "./rules.ts";
import { OPTIONS } from "./test-support/options.ts";

// biome-ignore lint/suspicious/noExplicitAny: test rows read nested fields
type Any = any;

const doc = (source: string, options: Partial<ParseOptions> = {}): Any => {
  clearShorthandProbe();
  return parse(source, { ...OPTIONS, ...options });
};

/** Every front-end error as `CODE [s,e) "message"` rows. */
const frontEnd = (d: Any): string[] =>
  d.errors
    .filter((e: Any) => e.origin === "front-end")
    .map(
      (e: Any) =>
        `${e.code} [${e.start},${e.end}) ${JSON.stringify(e.message)}`,
    );

describe("MX_TAG_NAME_MISSING (decision 163 addendum 9)", () => {
  it("a bare `,` line: the nameless node stays beside the error", () => {
    const d = doc(",");
    expect(frontEnd(d)).toEqual([
      `MX_TAG_NAME_MISSING [1,1) "a \`,\` continues the attributes of the tag above; there is no tag here"`,
    ]);
    expect(d.body[0]).toMatchObject({
      type: "MxTag",
      name: { kind: "unnamed" },
    });
  });

  it("an HTML-mode tag with no name (<,/>)", () => {
    expect(frontEnd(doc("<,/>"))).toEqual([
      `MX_TAG_NAME_MISSING [1,1) "a \`,\` continues the attributes of the tag above; there is no tag here"`,
    ]);
  });

  it("nested in another tag (<div><,>): the offset is the phantom's own", () => {
    expect(frontEnd(doc("<div><,>"))).toEqual([
      `MX_TAG_NAME_MISSING [6,6) "a \`,\` continues the attributes of the tag above; there is no tag here"`,
    ]);
  });

  it("a `,` after a tag continues that tag's attributes: no error", () => {
    expect(frontEnd(doc("div , x=1"))).toEqual([]);
  });
});

describe("MX_STATEMENT_IN_HTML_MODE (decision 149)", () => {
  it("<static x = 1/>: the statement example rides the message", () => {
    expect(frontEnd(doc("<static x = 1/>"))).toEqual([
      `MX_STATEMENT_IN_HTML_MODE [1,7) "\`static\` is a statement, not an html tag: write it at the root of the template without angle brackets, eg \`static const value = …\`."`,
    ]);
  });

  it("<import x/>", () => {
    expect(frontEnd(doc("<import x/>"))).toEqual([
      `MX_STATEMENT_IN_HTML_MODE [1,7) "\`import\` is a statement, not an html tag: write it at the root of the template without angle brackets, eg \`import Tag from \\"<tag>\\"\`."`,
    ]);
  });

  it("<export/x=1/>: the tag-variable variant names the <return> tag", () => {
    expect(frontEnd(doc("<export/x=1/>"))).toEqual([
      'MX_STATEMENT_IN_HTML_MODE [1,7) "The `export` statement does not support a tag variable. To publish a value to the parent template, use a `<return>` tag instead — `<return=x>` — and the parent names it with its own tag variable on this template\'s tag."',
    ]);
  });
});

describe("MX_ATTRIBUTE_TAG_AT_ROOT", () => {
  it("<@svg:rect/>", () => {
    expect(frontEnd(doc("<@svg:rect/>"))).toEqual([
      `MX_ATTRIBUTE_TAG_AT_ROOT [1,10) "@tags must be nested within another element."`,
    ]);
  });
});

describe("MX_SUGAR_NAME_MISSING", () => {
  it("an attribute `:` with no word: `write value:` hint included", () => {
    expect(frontEnd(doc("div x=a :"))).toEqual([
      `MX_SUGAR_NAME_MISSING [8,9) "\`:\` is name sugar and needs a name (\`:email\`); write \`value:\` for Marko's attribute of that name"`,
    ]);
  });

  it("a `.` with no word: the shorthand wording", () => {
    expect(frontEnd(doc("div x=a .\n  .b"))).toEqual([
      `MX_SUGAR_NAME_MISSING [8,9) "\`.\` needs a name after it (\`.main\`)"`,
    ]);
  });
});

describe("MX_SUGAR_NAME_INVALID", () => {
  it("a tag-name word with a stray character", () => {
    expect(frontEnd(doc("<my-widget:x@y/>"))).toEqual([
      `MX_SUGAR_NAME_INVALID [10,11) "\`:x@y\` in a tag name is not a name; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)"`,
    ]);
  });

  it("an attribute `:word` that is not an identifier", () => {
    expect(frontEnd(doc("div x=a :b%c"))).toEqual([
      `MX_SUGAR_NAME_INVALID [8,9) "\`:b%c\` is not name sugar; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)"`,
    ]);
  });
});

describe("MX_SUGAR_ARGUMENTS (decision 163 addendum 11)", () => {
  it("on `:name`: today's text literally says `:name` (calibrated)", () => {
    expect(frontEnd(doc("div :b(x)"))).toEqual([
      `MX_SUGAR_ARGUMENTS [4,5) "arguments are not allowed on \`:name\`: \`:b(…)\` is name sugar, not an attribute method"`,
    ]);
  });

  it("on `.name`: the authored name and the default-value hint", () => {
    expect(frontEnd(doc("<div x=a .b(c) d/>"))).toEqual([
      `MX_SUGAR_ARGUMENTS [9,10) "arguments are not allowed on \`.b\`: it is name sugar; a \`(params) { body }\` after it sets the default value"`,
    ]);
  });
});

describe("MX_SUGAR_BOUND (ast §3.6 rule 7)", () => {
  it("div :n:=y and div .c:=1: the sugar's own offset", () => {
    expect(frontEnd(doc("div :n:=y"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..."`,
    ]);
    expect(frontEnd(doc("div .c:=1"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..."`,
    ]);
  });

  it("<div:=x/>: the default attribute bound is the tag-adjacent `:`, not name sugar", () => {
    expect(frontEnd(doc("<div:=x/>"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..."`,
    ]);
  });

  it("div #i:=y: `#` is host policy, lowering's to raise — no front-end error", () => {
    expect(frontEnd(doc("div #i:=y"))).toEqual([]);
  });
});

describe("MX_SECOND_NAME", () => {
  it("a tag head: <a:b:c/> points at the second colon", () => {
    expect(frontEnd(doc("<a:b:c/>"))).toEqual([
      'MX_SECOND_NAME [4,5) "a tag takes one `:name`; this one already has a name (write the second as `name=\\"…\\"`)"',
    ]);
  });

  it("an attribute chain: div :b:c points at the chain's colon", () => {
    expect(frontEnd(doc("div :b:c"))).toEqual([
      'MX_SECOND_NAME [6,7) "a tag takes one `:name`; this one already has a name (write the second as `name=\\"…\\"`)"',
    ]);
  });
});

describe("MX_SUGAR_DYNAMIC (decision 174)", () => {
  it("a dynamic shorthand after the tag name names the tag-adjacent form", () => {
    expect(frontEnd(doc('div .a${"x:y"}'))).toEqual([
      'MX_SUGAR_DYNAMIC [4,5) "a dynamic shorthand works only tag-adjacent (`<div.a${\\"x>`), not as `.a${\\"x` after the tag name"',
    ]);
  });
});

describe("the seam", () => {
  beforeEach(() => {
    seams.frontEndRules = () => [];
  });
  it("replacing seams.frontEndRules suppresses every MX_* error", () => {
    expect(frontEnd(doc("div :b:c"))).toEqual([]);
    expect(frontEnd(doc(","))).toEqual([]);
  });
  it("the real rules run again after the seam is restored", () => {
    seams.frontEndRules = realRules;
    expect(frontEnd(doc("div :b:c"))).toHaveLength(1);
  });
});
