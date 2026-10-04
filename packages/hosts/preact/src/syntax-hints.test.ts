import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * Marko's own errors say what is wrong, not what to write (audit item 14,
 * cases p06/p09). MX appends one fix hint, in place; every suggested fix is
 * compiled here. React and Hono share this emitter.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

function failure(source: string): {
  message: string;
  line?: number;
  column?: number;
} {
  try {
    compilePreactMx(source, "/fixtures/test.mx");
  } catch (error) {
    const e = error as { message: string; line?: number; column?: number };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("event binding syntax (preact)", () => {
  it.each([
    ['<button (click)="go()">x</button>', "onClick=go"],
    ["<button (click)=go>x</button>", "onClick=go"],
    ['<button (click)="go(1)">x</button>', "onClick=handler"],
    ['<button (click)="a.b()" class="c">x</button>', "onClick=handler"],
    ['<button (keyup)="save()">x</button>', "onKeyup=save"],
    ["<button (click)>x</button>", "onClick=handler"],
  ])("p06: %s -> write `%s`", (source, fix) => {
    const error = failure(source);
    expect(error.message).toBe(
      `tag arguments \`(...)\` on \`<button>\` are not supported in a standalone template; for an event handler write \`${fix}\``,
    );
    // Marko reports at the argument (`assertNoArgs`: `args[0].loc.start`), so
    // `<button (click)=…` points at `click` — column 9 — not at `<button`.
    expect(error).toMatchObject({ line: 1, column: 9 });
  });

  it("stays as it was for anything that is not a lone event name", () => {
    for (const source of [
      "<button(a, b)>x</button>",
      "<button(a.b)>x</button>",
      "<button(1)>x</button>",
    ]) {
      const error = failure(source);
      expect(error.message).toBe(
        "tag arguments `(...)` on `<button>` are not supported in a standalone template",
      );
      expect(error).toMatchObject({ line: 1, column: 8 });
    }
  });

  it("the handler forms it suggests compile", () => {
    for (const ok of [
      "<button onClick=go>x</button>",
      "<button onKeyup=save>x</button>",
      "<button onClick() { go() }>x</button>",
    ]) {
      expect(() => compilePreactMx(ok, "/fixtures/test.mx")).not.toThrow();
    }
  });
});

describe("scriptlets and attribute values (preact)", () => {
  it("p09: a syntax error in a `$` line says scriptlets are unsupported", () => {
    const { message } = failure("$ const x = {;\n<p>1</p>");
    expect(message).toContain(
      "EOF reached while parsing expression; scriptlets (`$ …`) are not supported; declare a value with `<const/x=…/>`",
    );
  });

  it("the form it suggests compiles", () => {
    expect(() =>
      compilePreactMx(`<const/x=1/>\n<p>\${x}</p>`, "/fixtures/test.mx"),
    ).not.toThrow();
  });

  it("an attribute with no value says it needs one", () => {
    expect(failure('<div id= class="a">x</div>').message).toContain(
      'Unexpected token, expected "{"; `id=` has no value; write `id="…"` or `id=expr`, or drop the `=`',
    );
  });
});
