import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { describe, expect, it } from "vitest";
import { annotateCloseTagOpener } from "./close-tag-opener.ts";
import { compileSource } from "./compile.ts";

/** Compiles `source` and returns the thrown message minus ANSI colour. */
function failure(source: string): string {
  try {
    // The parse fails before the rest of the policy or the host is read;
    // only the web elements' parse rules (`<br>` is void) matter.
    (compileSource as (...args: unknown[]) => unknown)(
      source,
      "/fixtures/x.mx",
      { nativeTags: WEB_ELEMENTS },
      {},
    );
  } catch (error) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
    return (error as Error).message.replace(/\u001b\[[0-9;]*m/g, "");
  }
  throw new Error("expected a compile error");
}

const markerLine = (message: string): string =>
  message.split("\n").find((line) => line.includes("does not match")) ?? "";

describe("a mismatched closing tag names the opener's position", () => {
  it("appends the 1-based line:column of the unclosed `<`", () => {
    const message = failure("<div>\n  <p>x\n</div>\n");
    expect(markerLine(message)).toMatch(
      /\^+ The closing "div" tag does not match the corresponding opening "p" tag at 2:3$/,
    );
  });

  it("keeps the error at the closer", () => {
    const message = failure("<div>\n  <p>x\n</div>\n");
    expect(message).toContain("x.mx:3:1");
  });

  it("names the innermost unclosed opener when several are open", () => {
    const message = failure("<div><section><p>x</div>\n");
    expect(markerLine(message)).toContain('opening "p" tag at 1:15');
  });

  it("counts columns in UTF-16 code units after a non-ASCII prefix", () => {
    // "é" is one unit, "😀" two.
    const message = failure("<div>é😀<p>x</div>\n");
    expect(markerLine(message)).toContain('opening "p" tag at 1:9');
  });

  it("does not count a self-closed or void sibling as the opener", () => {
    const message = failure("<div>\n<section>\n<br>\n<img/>\n</div>\n");
    expect(markerLine(message)).toContain('opening "section" tag at 2:1');
  });

  it("leaves other parse errors untouched", () => {
    const message = failure("<div>x\n");
    expect(message).not.toMatch(/ at \d+:\d+\s*$/m);
  });

  it("annotates an aggregate error that has no loc of its own", () => {
    // A generic arrow in an attribute is a second parse error, so Marko
    // throws an aggregate (`errors[]`, no `loc`/`label`).
    const source =
      "<div>\n  <p onClick=<T,>(x: T) => x>a</p>\n  <section>\n    <p>x\n</div>\n";
    let thrown: (Error & { errors?: Error[] }) | undefined;
    try {
      (compileSource as (...args: unknown[]) => unknown)(
        source,
        "/fixtures/x.mx",
        {},
        {},
      );
    } catch (error) {
      thrown = error as Error & { errors?: Error[] };
    }
    expect(thrown?.errors?.length).toBe(2);
    const strip = (text: string) =>
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
      text.replace(/\u001b\[[0-9;]*m/g, "");
    expect(markerLine(strip(thrown?.message ?? ""))).toContain(
      'opening "p" tag at 4:5',
    );
    expect(markerLine(strip(thrown?.errors?.[1]?.message ?? ""))).toContain(
      'opening "p" tag at 4:5',
    );
  });

  it("annotates a colourised code frame, keeping the escape codes intact", () => {
    // What `@marko/compiler` prints when CI/FORCE_COLOR turn colours on: the
    // reason is wrapped in bold-red codes that follow it to the end of the line.
    const reason =
      'The closing "div" tag does not match the corresponding opening "p" tag';
    const tail = "\u001b[22m\u001b[39m";
    const message = `\n    at x.mx:3:1\n    > 3 | </div>\n        | \u001b[31m\u001b[1m^^^^^^ ${reason}${tail}\n      4 |`;
    const error = Object.assign(new Error(message), {
      label: reason,
      loc: { start: { line: 3, column: 0 } },
    });
    annotateCloseTagOpener(error, "<div>\n  <p>x\n</div>\n");
    expect(error.message).toContain(`${reason} at 2:3${tail}\n`);
    expect(error.label).toBe(`${reason} at 2:3`);
  });
});
