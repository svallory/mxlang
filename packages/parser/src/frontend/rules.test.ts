// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * Brief §1.2 B: the front-end `MX_*` rules (PR 2b, ast §3.13), one row each,
 * message and span calibrated byte-for-byte against today's front end
 * (`packages/core/src/name-sugar.ts`, `chunk-src.js`) — the offsets were
 * computed by script; a mismatch is a question to the lead, never an edit.
 * These rows pin the words; the live calibration is the parse-differential
 * package (`differential.test.ts`), which runs the whole grammar corpus and
 * every whole-file `.mx` fixture through today's lowering — a superset of
 * these inputs, not the same rows.
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
        `${e.code} [${e.start},${e.end}) ${JSON.stringify(e.message)} ctx=${JSON.stringify(e.context)}`,
    );

describe("MX_TAG_NAME_MISSING (decision 163 addendum 9)", () => {
  it("a bare `,` line: the nameless node stays beside the error", () => {
    const d = doc(",");
    expect(frontEnd(d)).toEqual([
      `MX_TAG_NAME_MISSING [1,1) "a \`,\` continues the attributes of the tag above; there is no tag here" ctx=null`,
    ]);
    expect(d.body[0]).toMatchObject({
      type: "MxTag",
      name: { kind: "unnamed" },
    });
  });

  it("an HTML-mode tag with no name (<,/>)", () => {
    expect(frontEnd(doc("<,/>"))).toEqual([
      `MX_TAG_NAME_MISSING [1,1) "a \`,\` continues the attributes of the tag above; there is no tag here" ctx=null`,
    ]);
  });

  it("nested in another tag (<div><,>): the offset is the phantom's own", () => {
    expect(frontEnd(doc("<div><,>"))).toEqual([
      `MX_TAG_NAME_MISSING [6,6) "a \`,\` continues the attributes of the tag above; there is no tag here" ctx=null`,
    ]);
  });

  it("a `,` after a tag continues that tag's attributes: no error", () => {
    expect(frontEnd(doc("div , x=1"))).toEqual([]);
  });
});

describe("MX_STATEMENT_IN_HTML_MODE (decision 149)", () => {
  it("<static x = 1/>: the statement example rides the message", () => {
    expect(frontEnd(doc("<static x = 1/>"))).toEqual([
      `MX_STATEMENT_IN_HTML_MODE [1,7) "\`static\` is a statement, not an html tag: write it at the root of the template without angle brackets, eg \`static const value = …\`." ctx=null`,
    ]);
  });

  it("<import x/>", () => {
    expect(frontEnd(doc("<import x/>"))).toEqual([
      `MX_STATEMENT_IN_HTML_MODE [1,7) "\`import\` is a statement, not an html tag: write it at the root of the template without angle brackets, eg \`import Tag from \\"<tag>\\"\`." ctx=null`,
    ]);
  });

  it("<export/x=1/>: the tag-variable variant names the <return> tag", () => {
    expect(frontEnd(doc("<export/x=1/>"))).toEqual([
      'MX_STATEMENT_IN_HTML_MODE [1,7) "The `export` statement does not support a tag variable. To publish a value to the parent template, use a `<return>` tag instead — `<return=x>` — and the parent names it with its own tag variable on this template\'s tag." ctx=null',
    ]);
  });
});

describe("MX_ATTRIBUTE_TAG_AT_ROOT", () => {
  it("<@svg:rect/>", () => {
    expect(frontEnd(doc("<@svg:rect/>"))).toEqual([
      `MX_ATTRIBUTE_TAG_AT_ROOT [1,10) "@tags must be nested within another element." ctx=null`,
    ]);
  });

  it("an attribute tag nested in a tag left open by end of input: not at root, only the end-of-input error", () => {
    // `div\n  @slot(a` — the front end finishes the open tags at the end of
    // input with their real ancestor (calibration F5), so the root rule
    // does not fire on the nested `@slot`; the input ending inside `(` is
    // reported (decision 161).
    expect(frontEnd(doc("div\n  @slot(a"))).toEqual([
      'MX_INPUT_ENDS_IN_DELIMITER [11,12) "the input ends inside `(`…`)` opened here" ctx=null',
    ]);
  });
});

describe("MX_SUGAR_NAME_MISSING", () => {
  it("an attribute `:` with no word: `write value:` hint included", () => {
    expect(frontEnd(doc("div x=a :"))).toEqual([
      `MX_SUGAR_NAME_MISSING [8,9) "\`:\` is name sugar and needs a name (\`:email\`); for an attribute named \`value:\`, write \`value:\`" ctx=null`,
    ]);
  });

  it("a `.` with no word: the shorthand wording", () => {
    expect(frontEnd(doc("div x=a .\n  .b"))).toEqual([
      `MX_SUGAR_NAME_MISSING [8,9) "\`.\` needs a name after it (\`.main\`)" ctx=null`,
    ]);
  });
});

describe("MX_SUGAR_NAME_INVALID", () => {
  it("a tag-name word with a stray character", () => {
    expect(frontEnd(doc("<my-widget:x@y/>"))).toEqual([
      `MX_SUGAR_NAME_INVALID [10,11) "\`:x@y\` in a tag name is not a name; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)" ctx=null`,
    ]);
  });

  it("an attribute `:word` that is not an identifier", () => {
    expect(frontEnd(doc("div x=a :b%c"))).toEqual([
      `MX_SUGAR_NAME_INVALID [8,9) "\`:b%c\` is not name sugar; \`:name\` takes an identifier (\`:email\`, \`:first-name\`)" ctx=null`,
    ]);
  });
});

describe("MX_SUGAR_ARGUMENTS (decision 163 addendum 11)", () => {
  it("on `:name`: today's text literally says `:name` (calibrated)", () => {
    expect(frontEnd(doc("div :b(x)"))).toEqual([
      `MX_SUGAR_ARGUMENTS [4,5) "arguments are not allowed on \`:name\`: \`:b(…)\` is name sugar, not an attribute method" ctx=null`,
    ]);
  });

  it("on `.name`: the authored name and the default-value hint", () => {
    expect(frontEnd(doc("<div x=a .b(c) d/>"))).toEqual([
      `MX_SUGAR_ARGUMENTS [9,10) "arguments are not allowed on \`.b\`: it is name sugar; a \`(params) { body }\` after it sets the default value" ctx=null`,
    ]);
  });
});

describe("MX_SUGAR_BOUND (ast §3.6 rule 7)", () => {
  it("div :n:=y and div .c:=1: the sugar's own offset", () => {
    expect(frontEnd(doc("div :n:=y"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..." ctx=null`,
    ]);
    expect(frontEnd(doc("div .c:=1"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..." ctx=null`,
    ]);
  });

  it("a compound chain reads the attachment item, not the first (calibration F2)", () => {
    // `:=` attaches to the LAST split item; the chain's authored sigil is
    // what decides the rule. A `.` sugar fires regardless of the value.
    expect(frontEnd(doc("div .c:n:=x"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..." ctx=null`,
    ]);
    expect(frontEnd(doc("div .c:n:=1"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..." ctx=null`,
    ]);
    expect(frontEnd(doc("div .a.b:=x"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..." ctx=null`,
    ]);
  });

  it("bindability is today's node-kind check, not a spelling rule (calibration F3)", () => {
    // Computed members, non-ASCII identifiers and parenthesized member
    // expressions bind today, so the sugar rule fires on them too.
    expect(frontEnd(doc("div :n:=obj[key]"))).toHaveLength(1);
    expect(frontEnd(doc("div :n:=obj[0]"))).toHaveLength(1);
    expect(frontEnd(doc("div :n:=é"))).toHaveLength(1);
    expect(frontEnd(doc("<a :n:=(obj.x)/>"))).toEqual([
      `MX_SUGAR_BOUND [3,4) "a bound value is not supported on name sugar; write name=... value:=..." ctx=null`,
    ]);
    // `true` and `this` are not bindable: Marko's own binding error fires
    // first today, lowering's to raise — the front end stays silent.
    expect(frontEnd(doc("<a :n:=true/>"))).toEqual([]);
    expect(frontEnd(doc("<a :n:=this/>"))).toEqual([]);
  });

  it("<div:=x/>: the default attribute bound is the tag-adjacent `:`, not name sugar", () => {
    expect(frontEnd(doc("<div:=x/>"))).toEqual([
      `MX_SUGAR_BOUND [4,5) "a bound value is not supported on name sugar; write name=... value:=..." ctx=null`,
    ]);
  });

  it("div #i:=y: `#` is host policy, lowering's to raise — no front-end error", () => {
    expect(frontEnd(doc("div #i:=y"))).toEqual([]);
  });
});

describe("MX_SECOND_NAME", () => {
  it("a tag head: <a:b:c/> points at the second colon", () => {
    expect(frontEnd(doc("<a:b:c/>"))).toEqual([
      'MX_SECOND_NAME [4,5) "a tag takes one `:name`; this one already has a name (write the second as `name=\\"…\\"`)" ctx=null',
    ]);
  });

  it("an attribute chain: div :b:c points at the chain's colon", () => {
    expect(frontEnd(doc("div :b:c"))).toEqual([
      'MX_SECOND_NAME [6,7) "a tag takes one `:name`; this one already has a name (write the second as `name=\\"…\\"`)" ctx=null',
    ]);
  });

  it("an unnamed head with two colons: <:b:c/> points at the second colon (calibration F4)", () => {
    expect(frontEnd(doc("<:b:c/>"))).toEqual([
      'MX_SECOND_NAME [3,4) "a tag takes one `:name`; this one already has a name (write the second as `name=\\"…\\"`)" ctx=null',
    ]);
  });
});

describe("MX_SUGAR_DYNAMIC (decision 174)", () => {
  it("a dynamic shorthand after the tag name names the tag-adjacent form", () => {
    expect(frontEnd(doc('div .a${"x:y"}'))).toEqual([
      'MX_SUGAR_DYNAMIC [4,5) "a dynamic shorthand works only tag-adjacent (`<div.a${\\"x>`), not as `.a${\\"x` after the tag name" ctx=null',
    ]);
  });
});

describe("MX_SUGAR_DYNAMIC (decision 174)", () => {
  it("a dynamic tag name falls back to `div`, today's fallback (calibration F7)", () => {
    expect(frontEnd(doc("<${t} .a${x}/>"))).toEqual([
      'MX_SUGAR_DYNAMIC [6,7) "a dynamic shorthand works only tag-adjacent (`<div.a${x}>`), not as `.a${x}` after the tag name" ctx=null',
    ]);
  });
});

describe("MX_COLON_BEFORE_DYNAMIC (decision 174)", () => {
  it("<a.x:${v}/>: the colon inside the shorthand's static head", () => {
    expect(frontEnd(doc("<a.x:${v}/>"))).toEqual([
      'MX_COLON_BEFORE_DYNAMIC [4,5) "a `:` before a `${…}` in a shorthand class or id is not allowed: a shorthand cannot contain `:` (write the value as `class=\\"…\\"`)" ctx=null',
    ]);
  });
});

describe("MX_SHORTHAND_INVALID", () => {
  it("<div .a|b/>: a stray character in the word", () => {
    expect(frontEnd(doc("<div .a|b/>"))).toEqual([
      'MX_SHORTHAND_INVALID [5,6) "`.a|b` is not a valid shorthand name" ctx=null',
    ]);
  });
});

describe("MX_SUGAR_ON_STATEMENT", () => {
  it("<import:/>: an empty word is the same error as a full one (calibration F4)", () => {
    expect(frontEnd(doc("<import:/>"))).toEqual([
      'MX_SUGAR_ON_STATEMENT [7,8) "a `:name` is not supported on the statement tag `import`: its text is code, not attributes — write `import …` at the root of the template instead" ctx=null',
    ]);
  });
});

describe("MX_RESERVED_TAG_NAME", () => {
  it("<%>: today's text, kept (ast §3.13)", () => {
    expect(frontEnd(doc("<%>"))).toEqual([
      'MX_RESERVED_TAG_NAME [1,2) "<% scriptlets %> are no longer supported." ctx=null',
    ]);
  });
});

describe("unnamed and shorthand trailing colons (calibration F4)", () => {
  it("<:1/>: the colon head's word is the tag's name", () => {
    expect(frontEnd(doc("<:1/>"))).toEqual([
      'MX_SUGAR_NAME_INVALID [1,2) "`:1` in a tag name is not a name; `:name` takes an identifier (`:email`, `:first-name`)" ctx=null',
    ]);
  });

  it("<:/>: a missing name after the head colon", () => {
    expect(frontEnd(doc("<:/>"))).toEqual([
      'MX_SUGAR_NAME_MISSING [1,2) "`:` in a tag name needs a name after it (`:email`)" ctx=null',
    ]);
  });

  it("<div.c:/>: a trailing colon after a shorthand makes no sugar node; the colon is read off the source", () => {
    expect(frontEnd(doc("<div.c:/>"))).toEqual([
      'MX_SUGAR_NAME_MISSING [6,7) "`:` in a shorthand class or id needs a name after it (`:email`)" ctx=null',
    ]);
  });

  it("<div.${x}:/>: the same after a dynamic shorthand", () => {
    expect(frontEnd(doc("<div.${x}:/>"))).toEqual([
      'MX_SUGAR_NAME_MISSING [9,10) "`:` in a shorthand class or id needs a name after it (`:email`)" ctx=null',
    ]);
  });
});

describe("the authored range in sugar messages (calibration F6)", () => {
  it("<div .c:bad%=1/>: the message names the whole authored sugar, value included", () => {
    expect(frontEnd(doc("<div .c:bad%=1/>"))).toEqual([
      'MX_SUGAR_NAME_INVALID [7,8) "`:bad%` in `.c:bad%=1` is not a name; `:name` takes an identifier (`:email`, `:first-name`)" ctx=null',
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
