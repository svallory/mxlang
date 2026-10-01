// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import { describe, expect, it } from "vitest";
import { emit } from "./helpers.ts";

/**
 * Marko 6.3.51 evaluates `<for by=>` before the loop, so a read of the tag's
 * own param is an error ("The `by=` attribute is evaluated before the loop
 * runs"). Angular's `track` is the one place a row expression is allowed, but
 * only through the arrow form (`by=(p => p.id)`), whose param is the row; the
 * bare `by=p.id` read is rejected like everywhere else, at the name.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    emit(source, "x.ng.mx");
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("<for by=> reads a loop param (angular)", () => {
  it.each([
    ["member", "<for|x| of=items by=x.id><p>${x.id}</p></for>", "x", 20],
    ["bare", "<for|x| of=items by=x><p>${x}</p></for>", "x", 20],
    ["call argument", "<for|x| of=items by=f(x)><p>${x.id}</p></for>", "x", 22],
    ["range to", "<for|i| to=3 by=i.n><p>${i}</p></for>", "i", 16],
  ])("rejects %s at the name read", (_label, source, name, column) => {
    const error = failure(source);
    expect(error.message).toContain(
      `The \`by=\` attribute is evaluated before the loop runs, so \`${name}\` is not in scope.`,
    );
    expect(error).toMatchObject({ line: 1, column });
  });

  it("still lowers the forms Angular supports to `track`", () => {
    expect(emit('<for|x| of=items by="id"><p>${x.id}</p></for>')).toContain(
      "track x.id",
    );
    expect(
      emit("<for|x| of=items by=(x) => x.id><p>${x.id}</p></for>"),
    ).toContain("track x.id");
  });
});
