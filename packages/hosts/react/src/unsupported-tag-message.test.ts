/**
 * A tag React does not support in embedded MX is refused with core's one
 * sentence, "`<X>` is not supported in embedded MX on React.", then the host's
 * hint when it has one. Whole file and region differ only in the hint.
 * Message, code, position and end are pinned.
 */
import { createTargetLookup } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compileReactMx, compileReactRegion } from "./index.ts";

const targets = createTargetLookup([descriptor]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

interface Refusal {
  message: string;
  code?: string;
  line: number;
  column: number;
  end?: { line: number; column: number };
  fixes?: unknown;
}

function refusal(run: () => unknown): Refusal {
  try {
    run();
  } catch (error) {
    const e = error as Refusal & { diagnosticCode?: string };
    return {
      message: stripAnsi(e.message),
      code: e.diagnosticCode,
      line: e.line,
      column: e.column,
      end: e.end,
      fixes: e.fixes,
    };
  }
  throw new Error("expected a compile error");
}

const whole = (source: string) =>
  refusal(() => compileReactMx(source, "/fixtures/whole.mx", { targets }));

// A region inside a module: file line 3 (0-based 2), column 4, offset 40.
const region = (source: string) =>
  refusal(() =>
    compileReactRegion(source, {
      filename: "/fixtures/Panel.react.mx",
      baseOffset: 40,
      baseLine: 2,
      baseColumn: 4,
      targets,
    }),
  );

const CODE = "MX_UNSUPPORTED_CONSTRUCT";

describe("React: a tag the host does not support", () => {
  it("a whole file: the first sentence, then the hint", () => {
    expect(whole("<let/x=1/>")).toEqual({
      message:
        "`<let>` is not supported in embedded MX on React. Use React's `useState` via `<const/x=useState(0)/>` or in the surrounding module.",
      code: CODE,
      line: 1,
      column: 0,
      end: { line: 1, column: 4 },
    });
  });

  it("a region: same first sentence, a hint that names the component", () => {
    expect(region("<div/>\n<let/x=1/>")).toEqual({
      message:
        "`<let>` is not supported in embedded MX on React. Use React's `useState` in the surrounding component.",
      code: CODE,
      line: 4,
      column: 0,
      end: { line: 4, column: 4 },
    });
  });

  it("<script> says where client code goes, whole file and region alike", () => {
    const expected = {
      message:
        "`<script>` is not supported in embedded MX on React. Write client code in a module the component imports.",
      code: CODE,
    };
    expect(whole("<script>go()</script>")).toMatchObject({
      ...expected,
      line: 1,
      column: 0,
      end: { line: 1, column: 7 },
    });
    expect(region("<div/>\n<script>go()</script>")).toMatchObject({
      ...expected,
      line: 4,
      column: 0,
    });
  });

  it.each([
    ["self-closing", "<effect/>"],
    ["bodied", "<effect>go()</effect>"],
    ["with a method", "<effect() { go() }/>"],
  ])("<effect> (%s) has the first sentence only, never a fix-it", (_n, tag) => {
    for (const error of [whole(tag), region(`<div/>\n${tag}`)]) {
      expect(error.message).toBe(
        "`<effect>` is not supported in embedded MX on React.",
      );
      expect(error.message).not.toContain("<script>");
      expect(error.code).toBe(CODE);
      expect(error.fixes).toBeUndefined();
    }
  });

  it("<effect> is positioned at the tag name with its end", () => {
    expect(whole("<div>\n  <effect() { go() }/>\n</div>")).toMatchObject({
      line: 2,
      column: 2,
      end: { line: 2, column: 9 },
    });
  });
});
