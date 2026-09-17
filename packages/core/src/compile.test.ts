import { describe, expect, it } from "vitest";
import { markoBabel } from "./core.ts";
import { printExpression } from "./index.ts";

/**
 * `printExpression` prints with Marko's own bundled Babel generator
 * (`markoBabel().generator`) — the same instance that parses Marko's nodes
 * in the first place. A node from any other Babel instance is not
 * guaranteed to print correctly here; these fixtures parse with
 * `markoBabel().parseExpression` so the node under test is one Marko itself
 * produced.
 *
 * Imported from `./index.ts`, not `./compile.ts`, so this pins the public
 * entry point every host actually calls through: deleting the re-export
 * from `index.ts` (leaving `compile.ts`'s own export intact) fails this
 * file rather than passing silently.
 */
describe("printExpression", () => {
  it("prints a member expression back to source text", () => {
    const node = markoBabel().parseExpression("a.b");
    expect(printExpression(node)).toBe("a.b");
  });

  it("prints an object literal", () => {
    const node = markoBabel().parseExpression('{ a: 1, b: "x" }');
    expect(printExpression(node)).toBe('{ a: 1, b: "x" }');
  });

  it("is the same function `newCtx` receives from `compileSource`'s translate visitor", () => {
    const { generator } = markoBabel();
    const node = markoBabel().parseExpression("a.b");
    expect(printExpression(node)).toBe(generator(node, { concise: true }).code);
  });
});
