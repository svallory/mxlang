/**
 * A tag Angular does not support in embedded MX is refused with core's one
 * sentence, "`<X>` is not supported in embedded MX on Angular.", then the
 * host's hint when it has one. Message, code, position and end are pinned for
 * a page, a tag module, `<effect>` (no hint), `<script>` and `<return>`.
 */
import { describe, expect, it } from "vitest";
import { compile, compileTagModule } from "../src/index.ts";

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

const page = (source: string) =>
  refusal(() => compile(source, "/fixtures/page.mx"));
const tag = (source: string) =>
  refusal(() => compileTagModule(source, "/fixtures/tags/badge.mx"));

const CODE = "MX_UNSUPPORTED_CONSTRUCT";

describe("Angular: a tag the host does not support", () => {
  it.each([
    [
      "<let/x=1/>",
      "`<let>` is not supported in embedded MX on Angular. Use Angular's `signal`/`WritableSignal` in the component class, or a `@Input()`.",
      4,
    ],
    [
      "<script>go()</script>",
      "`<script>` is not supported in embedded MX on Angular. Write client code in the component class.",
      7,
    ],
    [
      "<await>y</await>",
      "`<await>` is not supported in embedded MX on Angular. Use `@defer` with an `@placeholder`/`@loading` block instead.",
      6,
    ],
  ])("%s: the first sentence, then the hint", (source, message, endColumn) => {
    const expected = {
      message,
      code: CODE,
      line: 1,
      column: 0,
      end: { line: 1, column: endColumn },
    };
    expect(page(source)).toEqual(expected);
    expect(tag(source)).toEqual(expected);
  });

  it("<try> keeps its explanation in the hint", () => {
    expect(page("<try>x<@catch>y</@catch></try>")).toMatchObject({
      message:
        "`<try>` is not supported in embedded MX on Angular. Handle the error in the component and render the fallback with `<if>`; Angular has no template-level error boundary, and `@defer`'s `@error` block only covers a failed lazy chunk load, not a render error.",
      code: CODE,
    });
  });

  it.each(["<effect/>", "<effect>go()</effect>", "<effect() { go() }/>"])(
    "<effect> %s has the first sentence only, never a fix-it",
    (source) => {
      for (const error of [page(source), tag(source)]) {
        expect(error.message).toBe(
          "`<effect>` is not supported in embedded MX on Angular.",
        );
        expect(error.message).not.toContain("<script>");
        expect(error.code).toBe(CODE);
        expect(error.fixes).toBeUndefined();
      }
    },
  );

  it("<effect> is positioned at the tag name with its end", () => {
    expect(page("<div>\n  <effect() { go() }/>\n</div>")).toMatchObject({
      line: 2,
      column: 2,
      end: { line: 2, column: 9 },
    });
  });

  describe("<return>", () => {
    it("on a page: the first sentence, a hint, the code, today's position", () => {
      expect(page("<span>hi</span>\n<return value=42/>\n")).toMatchObject({
        message:
          "`<return>` is not supported in embedded MX on Angular. Declare the value as a `@Input()`/class member, or expose it as a `static`/`export`.",
        code: CODE,
        // Unchanged: the refusal points at the returned value (`42`), as the
        // language server's range for it does.
        line: 2,
        column: 14,
      });
    });

    it("in a tag module: a hint that names the tag's module", () => {
      expect(tag("<span>hi</span>\n<return value=42/>\n")).toMatchObject({
        message:
          "`<return>` is not supported in embedded MX on Angular. Declare the value as an `@Input()`, or expose it as a `static`/`export` from the tag's module.",
        code: CODE,
        // Unchanged: the refusal points at the returned value (`42`), as the
        // language server's range for it does.
        line: 2,
        column: 14,
      });
    });
  });
});
