import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { newCtx } from "./core.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

function check(source: string, vocabulary = false): void {
  const ctx = newCtx(
    source,
    printExpression,
    {
      tags: {},
      isElement: () => !vocabulary,
      isComponent: () => false,
      isDelegatedTag: () => vocabulary,
      resolveDelegatedTag: () => undefined,
    },
    undefined,
    "probe.mx",
    lookup,
  );
  lower(ctx, parseFragment(source, { filename: "probe.mx" }).body);
}
const onlyValue = (tag: string) =>
  `The \`<${tag}>\` tag only supports the \`value=\` attribute.`;

describe("builtin duplicate value validation (Marko 6.3.51)", () => {
  it("does not impose compiler-builtin rules on delegated vocabulary", () => {
    expect(() => check('<id value="one" label="two"/>', true)).not.toThrow();
    expect(() => check('<let value="one" value="two"/>', true)).not.toThrow();
  });
  for (const [source, message, column] of [
    ["<let/c=1 value:=c/>", "Invalid duplicate value attribute.", 9],
    ["<let/c=1 value=2/>", "Invalid duplicate value attribute.", 9],
    ["<const/c=1 value:=c/>", onlyValue("const"), 1],
    ["<const/c=1 value=2/>", onlyValue("const"), 1],
    ["<return=1 value=2/>", "Invalid duplicate value attribute.", 10],
    [
      "<return value=1 value:=input.x/>",
      "Invalid duplicate value attribute.",
      16,
    ],
    ["<id/c=1 value:=c/>", onlyValue("id"), 1],
  ] as const)
    it(source, () => {
      let error: unknown;
      try {
        check(source);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ message, line: 1, column });
    });
  it("positions a multiline duplicate on its authored value", () => {
    let error: unknown;
    try {
      check("<let/c=1\n  value:=c/>");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: "Invalid duplicate value attribute.",
      line: 2,
      column: 2,
    });
  });
});
