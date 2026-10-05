import { parse as parseNpm } from "@babel/parser";
import { parse, parseBabel } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import { parseSolid } from "./test-helpers.ts";

function caught(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as SyntaxError & {
      loc: { line: number; column: number; index: number };
    };
  }
  throw new Error("expected a parse error");
}

describe("MX parser diagnostic text", () => {
  it("drops the raw Babel suffix on a region mismatch, keeping the 1-based opener", () => {
    const error = caught(() =>
      parseSolid(
        "export const A = <div><span>oops</div>;\n",
        "broken.solid.mx",
      ),
    );
    expect(error.message).toBe(
      'The closing "div" tag does not match the corresponding opening "span" tag at 1:23',
    );
    expect(error.loc).toMatchObject({ line: 1, column: 32, index: 32 });
  });

  it("drops the raw suffix from a surrounding-module failure in the prepass", () => {
    const error = caught(() =>
      parse("\nconst value = ;", "broken.solid.mx", { mx: true }),
    );
    expect(error.message).toBe("Unexpected token");
    expect(error.loc).toMatchObject({ line: 2, column: 14, index: 15 });
  });

  it("drops the raw suffix from recovered MX-module errors too", () => {
    const ast = parse("let x; let x;", "broken.solid.mx", {
      mx: true,
      errorRecovery: true,
    }) as unknown as { errors: SyntaxError[] };
    expect(ast.errors.map((error) => error.message)).toEqual([
      "Identifier 'x' has already been declared.",
    ]);
  });

  it("leaves the vendored Babel error text equivalent to upstream with MX off", () => {
    const source = "\nconst value = ;";
    const upstream = caught(() => parseNpm(source));
    expect(caught(() => parseBabel(source)).message).toBe(upstream.message);
    expect(
      caught(() => parse(source, "broken.ts", { mx: false })).message,
    ).toBe(upstream.message);
    expect(upstream.message).toBe("Unexpected token (2:14)");
  });
});
