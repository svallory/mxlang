import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const emit = (source: string) => compilePreactMx(source, "/x/a.tsx").code;
// Agent shells set NO_COLOR=1; CI does not.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

describe("<textarea value> emission (Preact)", () => {
  it("moves a direct value into the content and drops the attribute", () => {
    const code = emit('<textarea value=input.v class="c"/>');
    expect(code).toContain(
      '<textarea class="c">{__mxTextareaContent(input.v)}</textarea>',
    );
    expect(code).not.toContain("value={");
  });

  it("routes a spread through the textarea merge, flagging a body", () => {
    expect(emit("<textarea ...input.a/>")).toMatch(/__mxTextarea\(.*, false\)/);
    expect(emit("<textarea ...input.a>x</textarea>")).toMatch(
      /__mxTextarea\(.*, true\)/,
    );
  });

  it("leaves other elements alone", () => {
    expect(emit("<input value=input.v/>")).not.toContain("__mxTextarea");
  });

  it("refuses an explicit value together with a body, at the value", () => {
    let error: { message: string; line?: number; column?: number } | undefined;
    try {
      emit("<textarea value=input.v>body</textarea>");
    } catch (caught) {
      error = caught as typeof error;
    }
    expect(plain(error?.message ?? "")).toContain(
      "A textarea cannot have both a value attribute and body content.",
    );
    expect([error?.line, error?.column]).toEqual([1, 10]);
  });
});
