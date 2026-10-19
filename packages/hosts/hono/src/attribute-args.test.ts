import { describe, expect, it } from "vitest";
import { compileHonoMx, compileHonoRegion } from "./index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip diagnostic colour
const ANSI = /\x1b\[[0-9;]*m/g;
const compilers = {
  file: (source: string) => compileHonoMx(source, "/v/test.mx"),
  region: (source: string) =>
    compileHonoRegion(source, { filename: "/v/test.hono.mx" }),
};

for (const [entry, compile] of Object.entries(compilers)) {
  describe(`attribute arguments (hono ${entry})`, () => {
    it.each([
      ["<button onClick(v)=() => {}/>", "onClick", 1, 8],
      ['<button class(v)="a"/>', "class", 1, 8],
      ["<button onClick()=fn/>", "onClick", 1, 8],
      ["<button onClick(v)/>", "onClick", 1, 8],
      ["<button\n  onClick(v)=fn/>", "onClick", 2, 2],
    ])(
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

    it("keeps method shorthand valid", () => {
      expect(() => compile("<button onClick(v) { return v }/>")).not.toThrow();
    });
  });
}

it("refuses argument lists on a component prop too", () => {
  expect(() =>
    compileHonoMx(
      'import C from "./card.js"\n<C onClick(v)=fn/>',
      "/v/test.mx",
    ),
  ).toThrow("Unsupported arguments on the `onClick` attribute.");
});
