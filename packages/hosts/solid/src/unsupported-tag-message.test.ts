/**
 * A tag Solid does not support in embedded MX is refused with core's one
 * sentence, "`<X>` is not supported in embedded MX on Solid.", then the host's
 * hint when it has one. Message, code, position and end are pinned, in a
 * `.solid.mx` region and in a whole tag unit.
 */
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

interface Refusal {
  message: string;
  code?: string;
  line: number;
  column: number;
  end?: { line: number; column: number };
  fixes?: unknown;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

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

const region = (source: string) =>
  refusal(() => compileSolidMx(source, { filename: "/fixtures/p.solid.mx" }));
const unit = (source: string) =>
  refusal(() => compileSolidUnit(source, { filename: "/fixtures/tag.mx" }));

const CODE = "MX_UNSUPPORTED_CONSTRUCT";

describe("Solid: a tag the host does not support", () => {
  it.each([
    [
      "<let/x=1/>",
      "`<let>` is not supported in embedded MX on Solid. Use Solid's `createSignal` in the surrounding TypeScript module.",
      4,
    ],
    [
      "<lifecycle onMount() {}/>",
      "`<lifecycle>` is not supported in embedded MX on Solid. Use Solid's lifecycle primitives in the surrounding TypeScript module.",
      10,
    ],
    [
      "<script>go()</script>",
      "`<script>` is not supported in embedded MX on Solid. Write client code in the surrounding TypeScript module.",
      7,
    ],
  ])("%s: the first sentence, then the hint", (source, message, endColumn) => {
    const expected = {
      message,
      code: CODE,
      line: 1,
      column: 0,
      end: { line: 1, column: endColumn },
    };
    expect(region(source)).toEqual(expected);
    expect(unit(source)).toEqual(expected);
  });

  it.each(["<effect/>", "<effect>go()</effect>", "<effect() { go() }/>"])(
    "<effect> %s has the first sentence only, never a fix-it",
    (source) => {
      for (const error of [region(source), unit(source)]) {
        expect(error.message).toBe(
          "`<effect>` is not supported in embedded MX on Solid.",
        );
        expect(error.message).not.toContain("<script>");
        expect(error.code).toBe(CODE);
        expect(error.fixes).toBeUndefined();
      }
    },
  );

  it("<effect> is positioned at the tag name with its end", () => {
    expect(region("<div>\n  <effect() { go() }/>\n</div>")).toMatchObject({
      line: 2,
      column: 2,
      end: { line: 2, column: 9 },
    });
  });
});
