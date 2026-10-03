import { describe, expect, it } from "vitest";
import { compilePreactMx as compile } from "./index.ts";

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

describe("preact: a missing close tag names the opener's position", () => {
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
});
