import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

// A tag named after an `Object.prototype` member crashed Marko's taglib lookup
// with a raw TypeError (divergences.md). It is an ordinary tag name now: it
// compiles, or fails, exactly as an ordinary unknown tag does.
function outcome(n: string): string {
  try {
    compileSolidMx(`<${n}/>\n`, { filename: "p.solid.mx" });
    return "ok";
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`.replaceAll(
      n,
      "NAME",
    );
  }
}

describe("tag named after an Object.prototype member", () => {
  it.each([
    "toString",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "__proto__",
  ])("<%s/> behaves like an ordinary tag", (name) => {
    expect(outcome(name)).toBe(outcome("plainName"));
  });
});
