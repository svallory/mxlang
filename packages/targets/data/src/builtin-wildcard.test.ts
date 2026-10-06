/**
 * One meaning of "built-in" (decision 147 addendum 2, decision 148): the
 * names data's declarations list in `builtinTags` (`object`) are built-ins for
 * a `children["*"]` wildcard exactly as they are for the `defaultTag` check.
 */

import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { dataDeclarations } from "./declarations.ts";
import { parseData } from "./parse.ts";

const tags: Record<string, CustomTag> = {
  entry: { attributes: { value: { type: "string" } } },
  holder: {
    parents: ["#root"],
    children: { "*": [{ contract: "entry" }] },
  },
};

const messages = (source: string) =>
  parseData(source, { customTags: tags }).diagnostics.map((d) => d.message);

describe("builtinTags and the wildcard", () => {
  it("data declares `object` as a built-in", () => {
    expect(dataDeclarations.builtinTags).toEqual(["object"]);
  });

  it("a catch-all `*` parent does not claim `<object>`, with the message every built-in gets", () => {
    const object = messages("<holder>\n  <object value='a'/>\n</holder>\n");
    const other = messages("<holder>\n  <let value='a'/>\n</holder>\n");
    expect(object).toHaveLength(1);
    expect(object[0]).toContain("`<object>` is a built-in tag");
    expect(other[0]).toContain("`<let>` is a built-in tag");
  });

  it("an ordinary name is still claimed by the catch-all", () => {
    expect(messages("<holder>\n  <thing value='a'/>\n</holder>\n")).toEqual([]);
  });
});
