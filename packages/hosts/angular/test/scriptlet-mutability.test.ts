import { expect, it } from "vitest";
import { compile } from "../src/index.ts";

function parseReason(source: string) {
  try {
    compile(source, "/fixtures/Test.mx");
  } catch (error) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: compiler code frames may be coloured
    const message = (error as Error).message.replace(/\x1b\[[0-9;]*m/g, "");
    return message
      .split("\n")
      .find((line) => /\|\s+\^/.test(line))
      ?.replace(/^.*\^ /, "");
  }
  throw new Error("Expected a parse error");
}

it.each(["let", "var"])(
  "does not offer an immutable replacement for $ %s",
  (keyword) => {
    expect(() =>
      compile(`$ ${keyword} x = 1;\n<p>1</p>`, "/fixtures/Test.mx"),
    ).toThrow(
      /^scriptlets \(`\$ statement`\) are not supported in MX \(decision 54\)$/,
    );
    expect(parseReason(`$ ${keyword} x = ;\n<p>1</p>`)).toBe(
      "Unexpected token; scriptlets (`$ …`) are not supported",
    );
    expect(() => compile("<let/x=1/>", "/fixtures/Test.mx")).toThrow(
      "`<let>` is Marko reactive state",
    );
  },
);
