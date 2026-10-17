import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * A named custom tag takes one plain argument (Marko 6.4.4
 * `assertAttributesOrSingleArg`): several arguments are refused over the
 * second through the last, a lone spread over the spread, and attribute tags
 * do not count as "attributes or body". A real compile keeps an attribute tag
 * as a body child of the call, so these rows go through `compilePreactMx`, the
 * path a user hits. `§` marks the first blamed character, `¶` the end.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;
const IMPORT = 'import Panel from "./panel.mx"\n';
const MULTIPLE = "Tag does not support multiple arguments.";
const SPREAD = "Tag does not support spread arguments.";
const WITH_BODY =
  "Tag does not support arguments when attributes or body present.";

function refuses(marked: string, message: string): void {
  const start = marked.indexOf("§");
  const unmarked = marked.replace("§", "");
  const end = unmarked.indexOf("¶");
  const text = `${IMPORT}${unmarked.replace("¶", "")}\n`;
  const at = (offset: number) => {
    const lines = text.slice(0, offset).split("\n");
    return { line: lines.length, column: lines[lines.length - 1]?.length ?? 0 };
  };
  let error: { message: string } | undefined;
  try {
    compilePreactMx(text, "/fixtures/test.mx");
  } catch (caught) {
    error = caught as { message: string };
  }
  expect(error).toBeDefined();
  expect(error?.message.replace(ANSI, "")).toBe(message);
  expect(error).toMatchObject({
    ...at(IMPORT.length + start),
    end: at(IMPORT.length + end),
  });
}

describe("a named custom tag takes one plain argument (preact)", () => {
  it.each([
    ["<Panel(a, §b¶)/>", MULTIPLE],
    ["<Panel(§...xs¶)/>", SPREAD],
    ["Panel(a, §b¶)", MULTIPLE],
    ["Panel(§...xs¶)", SPREAD],
    ["<Panel(\n  a,\n  §b¶\n)/>", MULTIPLE],
  ])("refuses %j", (marked, message) => {
    refuses(marked, message);
  });

  it.each([
    ["<Panel(a, §b¶)><@x/></Panel>", MULTIPLE],
    ["<Panel(§...xs¶)><@x/></Panel>", SPREAD],
    ["<Panel(a, §b¶)>\n  <@x/>\n  <@y/>\n</Panel>", MULTIPLE],
    ["<Panel(a, §b¶)><if=c><@x/></if></Panel>", MULTIPLE],
    ["Panel(a, §b¶)\n  @x", MULTIPLE],
    ["Panel(§...xs¶)\n  @x", SPREAD],
  ])(
    "refuses %j beside attribute tags, as it does without them",
    (marked, message) => {
      refuses(marked, message);
    },
  );

  it.each([
    "<Panel(§a, b¶)><@x/>text</Panel>",
    "<Panel(§a, b¶) c=1><@x/></Panel>",
  ])(
    "still says arguments beside attributes or a body first for %j",
    (marked) => {
      refuses(marked, WITH_BODY);
    },
  );

  it("takes one plain argument, an empty list and a trailing comma", () => {
    for (const call of ["<Panel(a)/>", "<Panel()/>", "<Panel(a,)/>"]) {
      expect(() =>
        compilePreactMx(`${IMPORT}${call}\n`, "/fixtures/test.mx"),
      ).not.toThrow();
    }
  });
});
