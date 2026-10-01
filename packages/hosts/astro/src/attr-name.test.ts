import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

// Marko 6.3.51 rejects an attribute name outside `[a-z_$][a-z0-9._:-]*`
// ("Invalid attribute name."); Angular syntax is not Marko, so `.amx` fails
// at the authored name too.
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;
const FENCE = "---\nconst x = 1;\n---\n"; // 3 fence lines: template starts on line 4

function failure(template: string) {
  try {
    lowerAstroMx(`${FENCE}${template}`, "Test.amx");
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

describe("invalid attribute names (astro)", () => {
  it.each([
    ["[prop]", '<div [prop]="x">hi</div>', "write `prop=`"],
    ["[attr.x]", '<div [attr.x]="y"/>', "write `x=`"],
    ["#ref", "<div #ref/>", "reference"],
    ["*ngIf", '<div *ngIf="x"/>', "<if=cond>"],
    ["$foo", "<foo $foo=1/>", "attribute name"],
    ["@foo", '<div @foo="y"/>', "attribute name"],
  ])("rejects %s at the authored name", (name, source, hint) => {
    const error = failure(source);
    expect(error.message).toContain(`Invalid attribute name \`${name}\``);
    expect(error.message).toContain(hint);
    expect(error).toMatchObject({ line: 4, column: 5 });
  });

  it("accepts the names Marko accepts", () => {
    for (const ok of ['<div data-x="1"/>', '<div a.b="1"/>', '<div _x="1"/>']) {
      expect(() => lowerAstroMx(`${FENCE}${ok}`, "Test.amx")).not.toThrow();
    }
  });
});
