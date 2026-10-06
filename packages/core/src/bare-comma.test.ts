import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { isTranslateError } from "./core.ts";
import { parseFragment } from "./fragment.ts";
import { BARE_COMMA_MESSAGE } from "./stock-parser.ts";
import { lookup } from "./test-targets.ts";

/**
 * A concise line that holds only `,` continues the attributes of a tag above
 * it. With no tag above, the template parser ends an open tag that never got a
 * name and Marko threw `TypeError: undefined is not an object (evaluating
 * 'tag.name.value')` (grammar probe g1683). It is a positioned error now, on
 * both of core's parse entries.
 */

const host = {
  name: "bare-comma-test",
  attrTags: 0,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

function viaFragment(source: string): unknown {
  try {
    parseFragment(source);
  } catch (error) {
    return error;
  }
  return undefined;
}

function viaCompile(source: string): unknown {
  try {
    compileSource(source, "/tmp/bare-comma.mx", host, {
      targets: lookup,
      emitIr: () => "",
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

const ENTRIES = [
  ["parseFragment", viaFragment],
  ["compileSource", viaCompile],
] as const;

// [source, line (1-based), column (0-based) of the `,`]
const BARE: [string, number, number][] = [
  [",", 1, 0],
  [", --x", 1, 0],
  [",\n", 1, 0],
  ["-- hi\n,", 2, 0],
  ["<div/>\n,", 2, 0],
  ["div\n  -- t\n  ,", 3, 2],
  ["$ let a = 1\n,", 2, 0],
];

describe.each(ENTRIES)("a bare `,` line through %s", (_name, run) => {
  it.each(BARE)("%j is a positioned error", (source, line, column) => {
    const error = run(source);
    expect(isTranslateError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as { message: string }).message).toBe(BARE_COMMA_MESSAGE);
    expect(error).toMatchObject({ line, column });
  });

  it("names the rule", () => {
    expect(BARE_COMMA_MESSAGE).toBe(
      "a `,` continues the attributes of the tag above; there is no tag here",
    );
  });

  it.each([
    ["a tag above in the same body", "div\n\n,"],
    ["inside a concise tag body", "div\n  span\n    ,"],
    ["continuing a tag's attributes", "div\n  , a=1"],
    ["text in an html-mode body", "<div>\n  ,\n</div>"],
    ["inside a control-flow body", "<if=x>\n  ,\n</if>"],
    ["text after a closed html tag", "<div/>\n, a=1"],
    ["a comma in an attribute list", "div a=1, b=2"],
  ])("%s is not the bare-comma error", (_label, source) => {
    const error = run(source) as { message?: string } | undefined;
    expect(error?.message).not.toBe(BARE_COMMA_MESSAGE);
    expect(error).not.toBeInstanceOf(TypeError);
  });
});
