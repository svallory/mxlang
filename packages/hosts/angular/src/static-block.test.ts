/**
 * An Angular page has no module scope, so `static` is refused there. An empty
 * block hoists nothing, but it is still a module statement and is refused
 * with the same message as a non-empty one.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

function message(source: string): string {
  try {
    compile(source, "/f/t.ng.mx");
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a compile error");
}

describe("angular: an empty `static` block is still a module-level statement", () => {
  it.each([
    "static {}",
    "static { /* only a comment */ }",
    "static { let q = 1 }",
  ])("%s is refused", (statement) => {
    expect(message(`${statement}\n<div>x</div>\n`)).toMatch(
      /a `<Static>` cannot be emitted into an Angular template: an Angular template has no module scope/,
    );
  });
});
