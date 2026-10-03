import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
const ANSI = /\u001b\[[0-9;]*m/g;

/** The `^^^ reason` line of the thrown error, ANSI stripped. */
function reasonLine(source: string): string {
  try {
    compile(source, "/fixtures/page.mx");
  } catch (error) {
    const message = (error as Error).message.replace(ANSI, "");
    return message.split("\n").find((l) => l.includes("does not match")) ?? "";
  }
  throw new Error("expected a compile error");
}

describe("html: a missing close tag names the opener's position", () => {
  it("reports the closer and adds the opener's line:column", () => {
    const line = reasonLine("<div>\n  <p>x\n</div>\n");
    expect(line).toMatch(
      /\^+ The closing "div" tag does not match the corresponding opening "p" tag at 2:3$/,
    );
  });

  it("names the innermost unclosed opener in a nested case", () => {
    expect(reasonLine("<div><section><p>x</div>\n")).toContain(
      'opening "p" tag at 1:15',
    );
  });

  // Statement tags (`export`, `static`, …) are parsed as JS by Marko's core
  // taglib, so TypeScript generics in them must not stop the replay.
  it.each([
    [
      "export interface with a generic",
      "export interface Input<T = string> { v: T }",
    ],
    [
      "export interface with extends",
      "export interface Input extends Base<string> { v: number }",
    ],
    [
      "static const with a generic annotation",
      "static const xs: Array<string> = []",
    ],
  ])("replays past %s", (_name, header) => {
    expect(reasonLine(`${header}\n<div>\n  <p>x\n</div>\n`)).toContain(
      'opening "p" tag at 3:3',
    );
  });
});
