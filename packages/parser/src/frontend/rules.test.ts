// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * Brief §1.2 B: the front-end `MX_*` rules (PR 2b, ast §3.13), one row each,
 * message and span calibrated byte-for-byte against Marko's own parse-time
 * checks (`chunk-src.js`) — the offsets were computed by script; a mismatch is
 * a question to the lead, never an edit.
 * These rows pin the words; the live calibration is the parse-differential
 * package (`differential.test.ts`), which runs the whole grammar corpus and
 * every whole-file `.mx` fixture through today's lowering — a superset of
 * these inputs, not the same rows.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type ParseOptions, parse, seams } from "./parse.ts";
import { frontEndRules as realRules } from "./rules.ts";
import { OPTIONS } from "./test-support/options.ts";

// biome-ignore lint/suspicious/noExplicitAny: test rows read nested fields
type Any = any;

const doc = (source: string, options: Partial<ParseOptions> = {}): Any =>
  parse(source, { ...OPTIONS, ...options });

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

describe("MX_RESERVED_TAG_NAME", () => {
  it("<%>: today's text, kept (ast §3.13)", () => {
    expect(frontEnd(doc("<%>"))).toEqual([
      'MX_RESERVED_TAG_NAME [1,2) "<% scriptlets %> are no longer supported." ctx=null',
    ]);
  });
});

// A colon is part of a tag's name, as in Marko (stock `htmljs-parser` 5.18.0
// reads `<import:x>` as the one name `import:x`): no statement, no rule.
describe("a colon after a statement keyword", () => {
  it.each(["<import:x/>", "<import:/>", "<static:x/>"])(
    "%s is an ordinary tag name",
    (source) => {
      const d = doc(source);
      expect(frontEnd(d)).toEqual([]);
      expect(d.body[0].name).toMatchObject({
        kind: "static",
        value: source.slice(1, -2),
      });
    },
  );
});

describe("the seam", () => {
  beforeEach(() => {
    seams.frontEndRules = () => [];
  });
  it("replacing seams.frontEndRules suppresses every MX_* error", () => {
    expect(frontEnd(doc("<import x/>"))).toEqual([]);
    expect(frontEnd(doc(","))).toEqual([]);
  });
  it("the real rules run again after the seam is restored", () => {
    seams.frontEndRules = realRules;
    expect(frontEnd(doc("<import x/>"))).toHaveLength(1);
  });
});
