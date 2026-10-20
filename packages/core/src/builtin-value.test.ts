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

describe("builtin duplicate value validation (Marko 6.4.4)", () => {
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
    // Marko counts the parser's empty twin of a default method here, which is
    // why core resolves it in lowering and not in a front-end collapse.
    [
      "let/x [valueChange=f] (y) { go(y) }",
      "Invalid duplicate value attribute.",
      22,
    ],
    [
      "<let/x valueChange=f, (y) { go(y) }/>",
      "Invalid duplicate value attribute.",
      22,
    ],
    [
      "return [valueChange=f] (y) { go(y) }",
      "Invalid duplicate value attribute.",
      23,
    ],
    [
      "<return valueChange=f, (y) { go(y) }/>",
      "Invalid duplicate value attribute.",
      23,
    ],
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
  it.each([
    ["<id/x data-x=x/>", onlyValue("id"), "MX_INVALID_ATTRIBUTE", 1],
    [
      "<let/x=1 data-x=x/>",
      "The `<let>` tag only supports the `value=` attribute and its change handler.",
      "MX_INVALID_ATTRIBUTE",
      9,
    ],
    [
      "<let/x=x valueChange=1 extra=2/>",
      "The `<let>` tag only supports the `value=` attribute and its change handler.",
      "MX_INVALID_ATTRIBUTE",
      23,
    ],
    [
      "<const/x(x)=x/>",
      "Tag does not support arguments.",
      "MX_UNSUPPORTED_CONSTRUCT",
      9,
    ],
    [
      "<let/x(x)=x/>",
      "Tag does not support arguments.",
      "MX_UNSUPPORTED_CONSTRUCT",
      7,
    ],
    [
      "<id/x(x)/>",
      "Tag does not support arguments.",
      "MX_UNSUPPORTED_CONSTRUCT",
      6,
    ],
    ["<const/x ...x/>", onlyValue("const"), "MX_INVALID_ATTRIBUTE", 1],
    ["<id/x ...x/>", onlyValue("id"), "MX_INVALID_ATTRIBUTE", 1],
    [
      "<let/x ...x/>",
      "The `<let>` tag does not support spread attributes.",
      "MX_INVALID_ATTRIBUTE",
      7,
    ],
  ])(
    "reports builtin shape before self-read: %s",
    (source, message, diagnosticCode, column) => {
      expect(() => check(source)).toThrowError(
        expect.objectContaining({
          message,
          diagnosticCode,
          line: 1,
          column,
        }),
      );
    },
  );

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
