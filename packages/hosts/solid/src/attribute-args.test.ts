import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip diagnostic colour
const ANSI = /\x1b\[[0-9;]*m/g;
// Core's attribute-args.test.ts owns the spelling/position matrix. Keep a
// positioned refusal through each host entry, plus host-specific routing below.
const compilers = {
  file: (source: string) =>
    compileSolidUnit(source, { filename: "/v/test.mx" }),
  region: (source: string) =>
    compileSolidMx(source, { filename: "/v/test.solid.mx" }),
};

for (const [entry, compile] of Object.entries(compilers)) {
  describe(`attribute arguments (solid ${entry})`, () => {
    it.each([["<button onClick(v)=() => {}/>", "onClick", 1, 8]])(
      "refuses %s instead of dropping its arguments",
      (source, name, line, column) => {
        let failure:
          | { message: string; line: number; column: number }
          | undefined;
        try {
          compile(source);
        } catch (error) {
          const e = error as { message: string; line: number; column: number };
          failure = {
            message: e.message.replace(ANSI, ""),
            line: e.line,
            column: e.column,
          };
        }
        expect(failure).toEqual({
          message: `Unsupported arguments on the \`${name}\` attribute.`,
          line,
          column,
        });
      },
    );

    it.each(["<define/X a(v)=1/>", "<const/x value(v)=1/>"])(
      "retains the existing structural behavior for %s",
      (source) => {
        const outcome = (text: string) => {
          try {
            compile(text);
            return "compiled";
          } catch (error) {
            return (error as Error).message.replace(ANSI, "");
          }
        };
        expect(outcome(source)).toBe(outcome(source.replace("(v)", "")));
      },
    );

    it("retains the existing loop-source argument error", () => {
      expect(() => compile('<for|x| of=[] by(v)="id"><i/></for>')).toThrow(
        "`<for by=...>` requires an expression value",
      );
    });

    it("keeps the builtin try contract error", () => {
      expect(() => compile("<try a(v)=1><i/></try>")).toThrow(
        "`<try>`: accepts no attributes",
      );
    });

    it("keeps Solid's comment error", () => {
      expect(() => compile("<html-comment a(v)=1>text</html-comment>")).toThrow(
        "an HTML comment (<html-comment>) cannot appear in a Solid component",
      );
    });

    if (entry === "region") {
      it("keeps the module-level refusal ahead of argument lists", () => {
        expect(() => compile('import C from "./card.js"\n<C a(v)=1/>')).toThrow(
          "module-level MX statements cannot appear inside a `.solid.mx` expression",
        );
      });
    }

    it("keeps method shorthand valid", () => {
      expect(() => compile("<button onClick(v) { return v }/>")).not.toThrow();
    });
  });
}

it("refuses argument lists on a component prop too", () => {
  expect(() =>
    compileSolidUnit('import C from "./card.js"\n<C onClick(v)=fn/>', {
      filename: "/v/test.mx",
    }),
  ).toThrow("Unsupported arguments on the `onClick` attribute.");
});
