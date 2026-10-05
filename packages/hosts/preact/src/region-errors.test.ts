/**
 * `.preact.mx` region errors: the region rule (module-level MX and `<const>`
 * are refused, at the statement the author wrote) and the reactive-tag
 * errors, whose region variant points only at the hook in the surrounding
 * component. Messages are matched with ANSI stripped; positions are the
 * authored `.preact.mx` line (1-based) and column (0-based).
 */

import { join } from "node:path";
import { createTargetLookup } from "@mxlang/core";
import { print } from "@mxlang/parser";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const targets = createTargetLookup([descriptor]);
const FILE = "/fixtures/region-errors/Panel.preact.mx";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

function errorOf(
  source: string,
  file = FILE,
): {
  message: string;
  line: number;
  column: number;
} {
  try {
    print(source, file, {
      mx: true,
      mxRegionCompile: (input) =>
        compilePreactRegion(input.source, { ...input, targets }) as ReturnType<
          NonNullable<
            NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"]
          >
        >,
    });
  } catch (error) {
    const e = error as Error & { loc?: { line: number; column: number } };
    if (!e.loc) throw new Error(`expected a positioned error: ${e.message}`);
    return {
      // The parser appends ` (line:column)` to a positioned message.
      message: stripAnsi(e.message).replace(/ \(\d+:\d+\)$/, ""),
      line: e.loc.line,
      column: e.loc.column,
    };
  }
  throw new Error("expected a compile error, but the module compiled");
}

/** A component whose region spans lines 3-7 and holds `body` on line 5. */
const inRegion = (body: string) =>
  `import { useState } from "preact/hooks";\nexport function Panel() {\n  return (\n    <div>\n      ${body}\n    </div>\n  );\n}\n`;

const MODULE_LEVEL =
  "module-level MX statements cannot appear inside a `.preact.mx` expression; write them in the surrounding TypeScript module";

describe("region rule", () => {
  // A bridge-found region is one element, so module-level MX reaches the
  // region entry only through a direct caller handing it statements: the
  // hook's own contract. The region sits at file line 3 (0-based 2), column
  // 4, offset 40, so a position equal to the region start would be (3, 4).
  function hookError(source: string) {
    try {
      compilePreactRegion(source, {
        filename: FILE,
        baseOffset: 40,
        baseLine: 2,
        baseColumn: 4,
        targets,
      });
    } catch (error) {
      const e = error as Error & { line?: number; column?: number };
      return {
        message: stripAnsi(e.message).replace(/ \(\d+:\d+\)$/, ""),
        line: e.line,
        column: e.column,
      };
    }
    throw new Error("expected a compile error");
  }

  it.each([
    ["an import", 'import x from "./x.mx"'],
    ["a static block", "static const n = 1"],
    ["an export", "export const n = 1"],
    ["an Input interface", "export interface Input { n: number }"],
  ])(
    "refuses %s at its own line and column, not the region start",
    (_label, statement) => {
      expect(hookError(`<div/>\n${statement}\n<p/>`)).toEqual({
        message: MODULE_LEVEL,
        line: 4,
        column: 0,
      });
    },
  );

  it("refuses <return> as module-level", () => {
    // At the tag (file line 4, column 0), not at its value (column 8).
    expect(hookError("<div/>\n<return=1/>")).toEqual({
      message: MODULE_LEVEL,
      line: 4,
      column: 0,
    });
  });

  it("refuses a top-level <const>, pointing at the surrounding component", () => {
    expect(errorOf(inRegion("<const/n=useState(0)/>"))).toEqual({
      message:
        "`<const>` cannot declare a binding inside a `.preact.mx` expression; declare it in the surrounding component",
      line: 5,
      column: 6,
    });
  });

  it("refuses a <const> nested deeper in the region with the same message", () => {
    expect(
      errorOf(inRegion("<section>\n        <const/n=1/>\n      </section>")),
    ).toEqual({
      message:
        "`<const>` cannot declare a binding inside a `.preact.mx` expression; declare it in the surrounding component",
      line: 6,
      column: 8,
    });
  });

  it("keeps a <define> inside a callback refused (it would change scope)", () => {
    expect(
      errorOf(
        inRegion(
          "<for|n| of=[1]>\n        <define/Row><b/></define>\n      </for>",
        ),
      ),
    ).toEqual({
      message:
        "`<define>` inside `<for>`, `<if>`, an attribute-tag body or a `<define>` body cannot be lifted out of it in a `.preact.mx` region without changing its scope; declare it directly in the region's markup, outside those bodies",
      line: 6,
      column: 8,
    });
  });

  it("refuses a second <define> of the same name, at its name (Marko: Duplicate declaration)", () => {
    // Both lift into the region's one arrow, so this would be a second
    // `const Row`; Marko 6.3.51 reports `Duplicate declaration "Row"` at the
    // second define's name.
    expect(
      errorOf(
        inRegion(
          "<section><define/Row><b>1</b></define><Row/></section><section><define/Row><i>2</i></define><Row/></section>",
        ),
      ),
    ).toEqual({ message: 'Duplicate declaration "Row"', line: 5, column: 77 });
  });

  it("refuses a /var inside a <for> with the region's wording", () => {
    // `counter.mx` declares `<return>`, so `/doubled` is a real tag variable.
    const file = join(
      import.meta.dirname,
      "fixtures",
      "region",
      "tag-var",
      "loop.preact.mx",
    );
    const source = `import Counter from "./counter.mx";\nexport function Panel() {\n  return (\n    <div>\n      <for|n| of=[1]><Counter/doubled start=n/></for>\n    </div>\n  );\n}\n`;
    expect(errorOf(source, file)).toEqual({
      message:
        "`/var` on `<Counter>` inside `<for>`, `<if>`, an attribute-tag body or a `<define>` body is not supported in a `.preact.mx` region; bind it directly in the region's markup, outside those bodies",
      line: 5,
      column: 21,
    });
  });

  it("names the region, not a standalone template, when refusing a tag variable", () => {
    expect(errorOf(inRegion("<p/x>text</p>"))).toMatchObject({
      message: expect.stringContaining(
        "is not supported in a `.preact.mx` region",
      ),
      line: 5,
      column: 6,
    });
  });

  describe("duplicate bindings lifted into one region arrow", () => {
    // `counter.mx` declares `<return>`, so `/x` is a real tag variable. The
    // path is beside it; the region sits in `Panel`, body on file line 5.
    const file = join(
      import.meta.dirname,
      "fixtures",
      "region",
      "tag-var",
      "dup.preact.mx",
    );
    const withCounter = (body: string) =>
      `import Counter from "./counter.mx";\nexport function Panel() {\n  return (\n    <div>\n      ${body}\n    </div>\n  );\n}\n`;
    const row = "<define/Row><b>1</b></define>";
    const dup = (name: string) => `Duplicate declaration "${name}"`;

    it("refuses a /var and a /var of the same name in sibling elements, at the second name", () => {
      const body =
        "<section><Counter/x start=1/></section><p><Counter/x start=2/></p>";
      expect(errorOf(withCounter(body), file)).toEqual({
        message: dup("x"),
        line: 5,
        column: 57,
      });
    });

    it("refuses a /var after a <define> of the same name, at the var", () => {
      const body = `${row}<Counter/Row start=1/>`;
      expect(errorOf(withCounter(body), file)).toEqual({
        message: dup("Row"),
        line: 5,
        column: 44,
      });
    });

    it("refuses a <define> after a /var of the same name, at the define", () => {
      const body = `<Counter/Row start=1/>${row}`;
      expect(errorOf(withCounter(body), file)).toEqual({
        message: dup("Row"),
        line: 5,
        column: 36,
      });
    });

    it("refuses a destructured /var that collides with a <define>", () => {
      const body = `${row}<Counter/{ Row, other } start=1/>`;
      expect(errorOf(withCounter(body), file)).toEqual({
        message: dup("Row"),
        line: 5,
        column: 46,
      });
    });

    it("compiles the same name in two different regions of one file", () => {
      const source = `import Counter from "./counter.mx";\nexport function A() {\n  return (\n    <div><Counter/x start=1/></div>\n  );\n}\nexport function B() {\n  return (\n    <div><Counter/x start=2/></div>\n  );\n}\n`;
      const out = print(source, file, {
        mx: true,
        mxRegionCompile: (input) =>
          compilePreactRegion(input.source, {
            ...input,
            targets,
          }) as ReturnType<
            NonNullable<
              NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"]
            >
          >,
      });
      expect(out.code.match(/const x = /g)).toHaveLength(2);
    });

    it("names a <define> body when a /var or <define> is refused inside one", () => {
      expect(
        errorOf(
          withCounter("<define/Row><Counter/y start=1/></define><Row/>"),
          file,
        ),
      ).toEqual({
        message:
          "`/var` on `<Counter>` inside `<for>`, `<if>`, an attribute-tag body or a `<define>` body is not supported in a `.preact.mx` region; bind it directly in the region's markup, outside those bodies",
        line: 5,
        column: 18,
      });
      expect(
        errorOf(
          inRegion(
            "<define/Row><define/Inner><b/></define><Inner/></define><Row/>",
          ),
        ),
      ).toEqual({
        message:
          "`<define>` inside `<for>`, `<if>`, an attribute-tag body or a `<define>` body cannot be lifted out of it in a `.preact.mx` region without changing its scope; declare it directly in the region's markup, outside those bodies",
        line: 5,
        column: 18,
      });
    });
  });
});

describe("reactive-tag errors in a region name only the hook", () => {
  it.each([
    [
      "<let/count=0/>",
      "`<let>` is Marko reactive state; use Preact's `useState` in the surrounding component",
    ],
    [
      "<effect() { console.log(1) }/>",
      "`<effect>` is a Marko reactive effect; use Preact's `useEffect` in the surrounding component",
    ],
    [
      "<id/key/>",
      "`<id>` allocates an identifier for Marko's reactive runtime; use Preact's `useId` in the surrounding component",
    ],
    [
      "<lifecycle onMount() {}/>",
      "`<lifecycle>` is a Marko lifecycle hook; use Preact's `useEffect`/`useLayoutEffect` in the surrounding component",
    ],
  ])("%s", (tag, message) => {
    const error = errorOf(inRegion(tag));
    expect(error).toEqual({ message, line: 5, column: 6 });
    expect(error.message).not.toContain("<const");
  });
});

describe("whole-file reactive-tag errors are unchanged", () => {
  function wholeFileError(source: string): string {
    try {
      compilePreactMx(source, "/fixtures/whole.mx", { targets });
    } catch (error) {
      return stripAnsi((error as Error).message);
    }
    throw new Error("expected a compile error");
  }

  it.each([
    [
      "<let/count=0/>",
      "`<let>` is Marko reactive state; use Preact's `useState` via `<const/x=useState(0)/>` or in the surrounding module",
    ],
    [
      "<effect() { console.log(1) }/>",
      "`<effect>` is a Marko reactive effect; use Preact's `useEffect` via `<const/_=useEffect(...)/>` or in the surrounding module",
    ],
    [
      "<id/key/>",
      "`<id>` allocates an identifier for Marko's reactive runtime; use Preact's `useId`",
    ],
    [
      "<lifecycle onMount() {}/>",
      "`<lifecycle>` is a Marko lifecycle hook; use Preact's `useEffect`/`useLayoutEffect` instead",
    ],
  ])("%s", (tag, message) => {
    expect(wholeFileError(tag)).toContain(message);
  });
});
