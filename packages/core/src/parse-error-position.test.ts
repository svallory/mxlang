import { describe, expect, it } from "vitest";
import { TranslateError } from "./core.ts";
import { dropOwnParserPosition } from "./parse-error-position.ts";

const babel = (message: string, line: number, column: number) =>
  Object.assign(new SyntaxError(message), { loc: { line, column, index: 0 } });

describe("dropOwnParserPosition", () => {
  it("drops a suffix equal to the parser's own loc", () => {
    const message =
      'closing "div" does not match opening "span" at 1:23 (1:32)';
    expect(dropOwnParserPosition(babel(message, 1, 32), message)).toBe(
      'closing "div" does not match opening "span" at 1:23',
    );
  });

  it("reads a Marko-style loc.start and tolerates SGR codes and whitespace", () => {
    const error = Object.assign(new Error("x"), {
      loc: { start: { line: 4, column: 27 } },
    });
    expect(dropOwnParserPosition(error, "boom (4:27)\u001b[0m \n")).toBe(
      "boom",
    );
  });

  it("keeps a suffix that differs from the loc (a foreign source's position)", () => {
    const message = "Unexpected token (3:14)";
    expect(dropOwnParserPosition(babel(message, 2, 3), message)).toBe(message);
  });

  it("keeps the text of a TranslateError, even when the numbers coincide", () => {
    const message = "`<broken>`: custom tag threw: Unexpected token (3:14)";
    expect(
      dropOwnParserPosition(new TranslateError(message, 3, 14), message),
    ).toBe(message);
    const located = Object.assign(new TranslateError(message, 3, 14), {
      loc: { line: 3, column: 14 },
    });
    expect(dropOwnParserPosition(located, message)).toBe(message);
  });

  it("keeps a plain Error's text: numeric line/column are not a parser loc", () => {
    // Bun gives every Error its JavaScript construction site as line/column.
    const error = Object.assign(new Error("only position (12:7)"), {
      line: 12,
      column: 7,
    });
    expect(dropOwnParserPosition(error, error.message)).toBe(error.message);
    expect(dropOwnParserPosition("string", "a (1:2)")).toBe("a (1:2)");
    expect(dropOwnParserPosition(null, "a (1:2)")).toBe("a (1:2)");
  });

  it("matches only a trailing (L:C)", () => {
    for (const text of ["call (foo)", "call (1)", "a (1:2) b", "plain"]) {
      expect(dropOwnParserPosition(babel(text, 1, 2), text)).toBe(text);
    }
  });
});
