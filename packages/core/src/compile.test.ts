import { describe, expect, it } from "vitest";
import { coreBabel } from "./babel.ts";
import { printExpression } from "./index.ts";

/**
 * `printExpression` prints with core's own Babel generator
 * (`coreBabel().generator`, decision 197); these fixtures parse with
 * `coreBabel().parseExpression`, the parser lowering uses beside the front
 * end's.
 *
 * Imported from `./index.ts`, not `./compile.ts`, so this pins the public
 * entry point every host actually calls through: deleting the re-export
 * from `index.ts` (leaving `compile.ts`'s own export intact) fails this
 * file rather than passing silently.
 */
describe("printExpression", () => {
  it("prints a member expression back to source text", () => {
    const node = coreBabel().parseExpression("a.b");
    expect(printExpression(node)).toBe("a.b");
  });

  it("prints an object literal", () => {
    const node = coreBabel().parseExpression('{ a: 1, b: "x" }');
    expect(printExpression(node)).toBe('{ a: 1, b: "x" }');
  });

  it("is the same function `newCtx` receives from `compileSource`'s translate visitor", () => {
    const { generator } = coreBabel();
    const node = coreBabel().parseExpression("a.b");
    expect(printExpression(node)).toBe(generator(node, { concise: true }).code);
  });
});
