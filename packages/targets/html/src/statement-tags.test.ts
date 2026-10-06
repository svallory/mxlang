// Decision 168: `class { … }` is one positioned "not supported" error on every
// target, html included (it replaces "Unable to find entry point").
import { expect, it } from "vitest";
import { compile } from "./index.ts";

it("refuses `class` with the not-supported message at its line", () => {
  try {
    compile("<div/>\nclass { x = 1 }\n", "/f/t.mx");
  } catch (error) {
    const e = error as { message: string; line: number };
    expect(e.message).toContain("`class { … }` is not supported in MX");
    expect(e.line).toBe(2);
    return;
  }
  throw new Error("expected a compile error");
});

it("still runs a `server` statement and drops a `client` one", () => {
  expect(compile("server console.log(1)\n<div/>", "/f/t.mx").code).toContain(
    "console.log(1)",
  );
  expect(
    compile("client console.log(1)\n<div/>", "/f/t.mx").code,
  ).not.toContain("console.log(1)");
});
