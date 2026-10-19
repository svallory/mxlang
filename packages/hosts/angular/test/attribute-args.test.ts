import { describe, expect, it } from "vitest";
import { compile, compileNgMx, compileTagModule } from "../src/index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip diagnostic colour
const ANSI = /\x1b\[[0-9;]*m/g;
const compilers = {
  page: (source: string) => compile(source, "/v/test.mx", { warnings: [] }),
  tag: (source: string) =>
    compileTagModule(source, "/v/test.mx", { warnings: [] }),
  region: (source: string) =>
    compileNgMx(
      `import { Component } from "@angular/core";\n@Component({ template: ${source} })\nexport class Test {}`,
      "/v/test.ng.mx",
    ),
};

for (const [entry, compileSource] of Object.entries(compilers)) {
  describe(`attribute arguments (angular ${entry})`, () => {
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
          compileSource(source);
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
          line: entry === "region" ? line + 1 : line,
          column: entry === "region" && line === 1 ? column + 23 : column,
        });
      },
    );

    it.each(["<define/X a(v)=1/>", "<const/x value(v)=1/>"])(
      "retains structural acceptance for %s",
      (source) => {
        expect(() => compileSource(source)).not.toThrow();
      },
    );

    it("retains the existing loop-source argument error", () => {
      expect(() =>
        compileSource('<for|x| of=[] by(v)="id"><i/></for>'),
      ).toThrow("`<for by=...>` requires an expression value");
    });

    it("keeps Angular's unsupported try error", () => {
      expect(() => compileSource("<try a(v)=1><i/></try>")).toThrow(
        "`<try>` is not supported in embedded MX on Angular",
      );
    });

    it("retains Angular's text-only comment acceptance", () => {
      expect(() =>
        compileSource("<html-comment a(v)=1>text</html-comment>"),
      ).not.toThrow();
    });

    if (entry === "region") {
      it("keeps the parser's import-region error ahead of argument lists", () => {
        expect(() =>
          compileSource('import C from "./card.js"\n<C a(v)=1/>'),
        ).toThrow(/Unexpected token|import/);
      });
    }

    it("preserves Angular's function-value policy, not an argument-list error", () => {
      expect(() => compileSource("<button onClick=save/>")).not.toThrow();
      expect(() => compileSource("<button onClick(v) { return v }/>")).toThrow(
        "Angular templates cannot contain a `function` expression",
      );
    });
  });
}

it("refuses argument lists on a component prop too", () => {
  expect(() =>
    compileTagModule(
      'import C from "./card.js"\n<C onClick(v)=fn/>',
      "/v/test.mx",
    ),
  ).toThrow("Unsupported arguments on the `onClick` attribute.");
});
