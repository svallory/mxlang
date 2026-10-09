import { describe, expect, it } from "vitest";
import { parse } from "./parse.ts";

/** Tag types are looked up as own properties (decision 182 addenda 2, 3). */
describe("a tag named after an Object.prototype member", () => {
  it.each([
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "toString",
    "valueOf",
  ])("<%s/> parses as an ordinary tag", (name) => {
    const document = parse(`<${name}/>`, {
      statementKeywords: new Set(),
      tagShape: () => "html",
    });
    expect(document.errors).toEqual([]);
    expect(document.body[0]).toMatchObject({ type: "MxTag" });
  });
});
