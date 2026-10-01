// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

/**
 * Marko 6.3.51 evaluates `<for by=>` once, before the loop, so the tag's params
 * are not in scope there ("The `by=` attribute is evaluated before the loop
 * runs, so `x` is not in scope", `runtime-tags/.../core/for.ts`). The error is
 * reported at the offending name, for every form of `<for>`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compileReactMx(source, "/fixtures/test.mx");
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

const compiles = (source: string): void => {
  expect(() => failure(source)).toThrow("expected a compile error");
};

describe("<for by=> reads a loop param (react)", () => {
  it.each([
    ["member", "<for|x| of=items by=x.id><p>${x.id}</p></for>", "x", 20],
    ["bare", "<for|x| of=items by=x><p>${x}</p></for>", "x", 20],
    [
      "optional member",
      "<for|x| of=items by=x?.id><p>${x.id}</p></for>",
      "x",
      20,
    ],
    [
      "computed member",
      "<for|x| of=items by=obj[x.id]><p>${x.id}</p></for>",
      "x",
      24,
    ],
    ["call argument", "<for|x| of=items by=f(x)><p>${x.id}</p></for>", "x", 22],
    [
      "conditional",
      "<for|x| of=items by=a ? x.id : 'b'><p>${x.id}</p></for>",
      "x",
      24,
    ],
    [
      "template literal",
      "<for|x| of=items by=`k${x.id}`><p>${x.id}</p></for>",
      "x",
      24,
    ],
    ["second param", "<for|x, i| of=items by=i><p>${x.id}</p></for>", "i", 23],
    [
      "destructured param",
      "<for|{ id }| of=items by=id><p>${id}</p></for>",
      "id",
      25,
    ],
    ["range to", "<for|i| to=3 by=i.n><p>${i}</p></for>", "i", 16],
    ["range until", "<for|i| until=3 by=i><p>${i}</p></for>", "i", 19],
    ["in", "<for|k, v| in=o by=k><p>${k}</p></for>", "k", 19],
  ])("rejects %s at the name read", (_label, source, name, column) => {
    const error = failure(source);
    expect(error.message).toContain(
      `The \`by=\` attribute is evaluated before the loop runs, so \`${name}\` is not in scope.`,
    );
    expect(error.message).toContain(`by=(${name}) => key`);
    expect(error.message).toContain('by="id"');
    expect(error).toMatchObject({ line: 1, column });
  });

  it("positions on the right line in a multi-line tag", () => {
    const error = failure(
      "<ul>\n  <for|x| of=items\n       by=x.id>\n    <li>${x.id}</li>\n  </for>\n</ul>",
    );
    expect(error).toMatchObject({ line: 3, column: 10 });
  });

  it("reports the first read when several appear", () => {
    const error = failure("<for|x, i| of=items by=f(i, x)><p>${x}</p></for>");
    expect(error.message).toContain("`i` is not in scope");
  });

  it("accepts every form Marko accepts", () => {
    for (const ok of [
      "<for|x| of=items by=(x) => x.id><p>${x.id}</p></for>",
      "<for|x, i| of=items by=(x, i) => `${i}-${x.id}`><p>${x.id}</p></for>",
      '<for|x| of=items by="id"><p>${x.id}</p></for>',
      "<for|x| of=items by=key><p>${x.id}</p></for>",
      "<for|x| of=items by=someFn><p>${x.id}</p></for>",
      "<for|x| of=items by=obj.x><p>${x.id}</p></for>",
      "<for|x| of=items by=(y) => x.id><p>${x.id}</p></for>",
      "<for|i| to=3 by=(i) => i><p>${i}</p></for>",
      "<for|k, v| in=o by=(k, v) => k><p>${k}</p></for>",
      "<for|x| of=items><p>${x.id}</p></for>",
    ]) {
      compiles(ok);
    }
  });
});
