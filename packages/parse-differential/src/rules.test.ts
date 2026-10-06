// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * One test per mapping rule (`rules.ts`): each pins what the rule does, on
 * the rule function where it has one and through a whole comparison where
 * the rule lives in the projection of today's tree.
 */
import { describe, expect, it } from "vitest";
import { compare } from "./differential.ts";
import { projectMarko } from "./marko.ts";
import { print } from "./neutral.ts";
import {
  compareTextRuns,
  lineStartsOf,
  offsetOf,
  RULES,
  rejoinAttributeName,
  splitAtFirstColon,
  splitChain,
  thrownTemplateError,
} from "./rules.ts";

const marko = (source: string) => print(projectMarko(source).document);

describe("the rule list", () => {
  it("names one ast §2 row per rule, each id once", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const rule of RULES) expect(rule.row).toMatch(/^A\d+/);
  });
});

describe("rejoin-attribute-name (A2)", () => {
  it("rejoins Marko's last-colon split", () => {
    expect(rejoinAttributeName("value", "fn")).toBe("value:fn");
    expect(rejoinAttributeName("a:b", "c")).toBe("a:b:c");
    expect(rejoinAttributeName("x", null)).toBe("x");
    expect(compare("<a class:x=1 a:b:c/>").equal).toBe(true);
  });
});

describe("default-attribute (A3)", () => {
  it("Marko's `value` default is the default value; with a modifier the : sugar", () => {
    expect(marko("<if=a></if>")).toContain(
      '  · attr (default) [3,5) name=[3,3) = "a"@[4,5)',
    );
    expect(marko("<a :mail/>")).toContain('  · sugar :"mail"@[3,8)');
    expect(compare("<if=a></if><a :b=1/>").equal).toBe(true);
  });
});

describe("unmerge-shorthands (A4)", () => {
  it("the merged class/id attributes are the tag-position sugar", () => {
    expect(marko("<a#i.b.c/>")).toEqual([
      'tag "a"@[1,2) [0,10)',
      '  · sugar #"i"',
      '  · sugar ."b"',
      '  · sugar ."c"',
    ]);
    expect(compare("<a.b#i.c/>").equal).toBe(true);
    expect(compare("<a.x${y}/>").equal).toBe(true);
  });
});

describe("unnamed-tag (A5)", () => {
  it("Marko's `div` over an empty name span is the unnamed tag", () => {
    expect(marko("<.c/>")[0]).toBe("tag (unnamed)@[1,1) [0,5)");
    expect(compare("<.c/><div/>").equal).toBe(true);
  });
});

describe("split-name-sugar (A6)", () => {
  it("splits at the first colon outside ${…}", () => {
    expect(splitAtFirstColon("a:b:c")).toEqual(["a", "b:c"]);
    expect(splitAtFirstColon("${a ? b : c}")).toEqual([
      "${a ? b : c}",
      undefined,
    ]);
    expect(splitChain(".c#m.d")).toEqual([
      { sigil: ".", word: "c" },
      { sigil: "#", word: "m" },
      { sigil: ".", word: "d" },
    ]);
    expect(compare("<input:email/><a.c:b/><b .c#m.d:y/>").equal).toBe(true);
  });
});

describe("attribute-tags-in-place (A7)", () => {
  it("attribute tags, their comments and control-flow holders return to the body", () => {
    expect(
      compare("<Card><!-- c --><@head/><if=a><@item/></if></Card>").equal,
    ).toBe(true);
  });
});

describe("statement-node (A8)", () => {
  it("a raw statement tag is a statement with its untrimmed range", () => {
    expect(marko("static const A = 1   \n<div/>")[0]).toBe(
      "statement [0,21) static trimmedEnd=18",
    );
    expect(compare('import x from "y"\nstatic a = 1').equal).toBe(true);
  });
});

describe("head-on-tag (A11)", () => {
  it("params and type parameters on the body are the tag's head", () => {
    expect(compare("<for<T>|item: T| of=xs>${item}</for>").equal).toBe(true);
  });
});

describe("positions-from-loc (A12)", () => {
  it("line/column to offset", () => {
    const starts = lineStartsOf("ab\ncd\r\nef");
    expect(starts).toEqual([0, 3, 7]);
    expect(offsetOf(starts, { line: 3, column: 1 })).toBe(8);
  });
});

describe("text-runs (A13)", () => {
  it("a Marko range sits in exactly one MX run; an extra MX run is whitespace", () => {
    const source = "<p>  a\n  b</p>\n";
    expect(compareTextRuns(source, [[3, 10]], [[3, 10]])).toEqual([]);
    expect(
      compareTextRuns(
        source,
        [[5, 6]],
        [
          [3, 10],
          [14, 15],
        ],
      ),
    ).toEqual([]);
    expect(compareTextRuns(source, [], [[3, 10]])).toHaveLength(1);
    expect(compare("<div>\n  <p>x</p>\n  hello\n</div>").equal).toBe(true);
  });
});

describe("open-tag-comments (A14)", () => {
  it("Babel comments on attributes are comment items in source order", () => {
    expect(compare("<div // c\n /* d */ a=1 /* e */></div>").equal).toBe(true);
  });
});

describe("dynamic-name (A17)", () => {
  it("a dynamic name compares by its authored text", () => {
    expect(compare("<${x}/><my-${x}/><${a}${b}/>").equal).toBe(true);
  });
});

describe("sugar-arguments (A6, decision 163 addendum 11)", () => {
  it("Marko's arguments on a sugar-named attribute are the last part's args", () => {
    expect(marko("<div .c(:a)/>")).toContain(
      '  · sugar ."c"@[5,7) args ":a"@[8,10)',
    );
    expect(compare("<div .c(:a)/><div #x.y(1)/><div :n(2)/>").equal).toBe(true);
  });
});

describe("template-error (A10)", () => {
  it("the message and range out of Marko's code frame", () => {
    const starts = lineStartsOf("<div></span>");
    expect(
      thrownTemplateError(
        {
          message:
            "\n  at f.mx:1:6\n  > 1 | <div></span>\n      |      ^^^^^^^ The closing tag\n    2 |",
          loc: { start: { line: 1, column: 5 }, end: { line: 1, column: 12 } },
        },
        starts,
      ),
    ).toEqual({ message: "The closing tag", start: 5, end: 12 });
    // A coloured frame (colour is on in CI and the gate).
    expect(
      thrownTemplateError(
        {
          message:
            "\n  > 1 | <a>\n      | \u001b[31m\u001b[1m^\u001b[22m\u001b[39m \u001b[31m\u001b[1mThe closing tag\u001b[22m\u001b[39m\u001b[0m",
          loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        },
        starts,
      ),
    ).toEqual({ message: "The closing tag", start: 0, end: 1 });
    expect(compare("<div></span>").equal).toBe(true);
  });
});
