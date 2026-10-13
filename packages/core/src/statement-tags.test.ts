// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
// Decision 168 / #395 r2: every translator declares the statement tags, a
// translator that does not is refused rather than papered over, and a statement
// is checked the way Marko checks it.
import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import { newCtx } from "./core.ts";
import { withStatementTags } from "./core-taglib.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { markoCompiler } from "./marko-frontend.ts";
import { tagTable } from "./tag-table.ts";
import { lookup as targets } from "./test-targets.ts";

/** A third-party target's translator: not built with `createTranslator`, no taglibs. */
const bare = () => ({ taglibs: [], tagDiscoveryDirs: [], translate: {} });

const policy = (): Policy => ({
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
  resolveDefaultTag: () => "input",
});

const NAMES = ["import", "static", "export", "client", "server", "class"];

describe("a translator not built with createTranslator", () => {
  it("gets the six statement tags in the tag table core builds from it", () => {
    const lookup = tagTable(bare(), undefined);
    for (const name of NAMES) {
      expect(lookup?.getTag(name)?.parseOptions?.statement, name).toBe(true);
    }
  });

  it("keeps the translator it is given when it declares its own statements", () => {
    const own = { ...bare(), statementTags: false as const };
    expect(withStatementTags(own)).toBe(own);
  });

  it("returns the same wrapped object for the same translator (Marko keys on identity)", () => {
    const t = bare();
    expect(withStatementTags(t)).toBe(withStatementTags(t));
  });

  it("refuses a statement its parse read as attributes, positioned, instead of recovering it", () => {
    const source = "\nstatic function f(a: number): string { return '' }\n";
    const ast = markoCompiler().compileSync(source, "/f/t.mx", {
      output: "source",
      ast: true,
      translator: bare(),
      // biome-ignore lint/suspicious/noExplicitAny: the compiler's options are untyped here
    } as any).ast;
    const ctx = newCtx(
      source,
      printExpression,
      policy(),
      undefined,
      "/f/t.mx",
      targets,
    );
    expect(() => lower(ctx, ast.program.body)).toThrow(
      /`static` was parsed as a tag with attributes/,
    );
  });
});

describe("a statement is checked like Marko checks it", () => {
  const lowerSource = (source: string) => {
    const { body } = parseFragment(source, { filename: "/f/t.mx" });
    const ctx = newCtx(
      source,
      printExpression,
      policy(),
      tagTable(bare(), undefined),
      "/f/t.mx",
      targets,
    );
    return lower(ctx, body);
  };

  it("refuses JSX with MX's own message, at the `<`", () => {
    try {
      lowerSource("static const el = <b>hi</b>\n");
    } catch (error) {
      const e = error as { message: string; line: number; column: number };
      expect(e.message).toBe(
        "JSX is not read inside a `static` statement: its text is TypeScript. Write the markup as a tag in the template, or in a `<define>`",
      );
      expect([e.line, e.column]).toEqual([1, 18]);
      return;
    }
    throw new Error("expected a compile error");
  });

  it("finds the `<` of a JSX value that starts on a later line", () => {
    try {
      lowerSource("static const el =\n  <b>hi</b>\n");
    } catch (error) {
      const e = error as { message: string; line: number; column: number };
      expect(e.message).toContain(
        "JSX is not read inside a `static` statement",
      );
      expect([e.line, e.column]).toEqual([2, 2]);
      return;
    }
    throw new Error("expected a compile error");
  });

  it("keeps Babel's own message for a parse error that is not JSX", () => {
    expect(() => lowerSource("static const a = 1 +\n")).toThrow(
      "Unexpected token",
    );
  });

  it("joins a line ending in an operator when the result is valid", () => {
    const ir = lowerSource("static const t = 1 +\n2\n<div/>\n");
    expect(ir.hoisted.map((s) => s.code)).toEqual(["const t = 1 +\n2"]);
  });

  it("refuses the join that swallows a template line, at that line", () => {
    try {
      lowerSource("static const ok = 2 >\n<div>${ok}</div>\n");
    } catch (error) {
      const e = error as { message: string; line: number; column: number };
      expect(e.message).toBe("Missing semicolon.");
      expect([e.line, e.column]).toEqual([2, 6]);
      return;
    }
    throw new Error("expected a compile error");
  });
});

describe("a decorator in a module statement is refused", () => {
  const compile = (source: string) =>
    compileSource(
      source,
      "/tmp/decorators.mx",
      { tags: {}, isElement: () => true, isComponent: () => false },
      { targets, emitIr: () => "" },
    );
  const lowerSource = (source: string) => {
    const { body } = parseFragment(source, { filename: "/f/t.mx" });
    const ctx = newCtx(
      source,
      printExpression,
      policy(),
      tagTable(bare(), undefined),
      "/f/t.mx",
      targets,
    );
    return lower(ctx, body);
  };
  const D = "static function d() { return (c: any) => c }\n";
  const failure = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error as {
        message: string;
        diagnosticCode?: string;
        line: number;
        column: number;
        end?: { line: number; column: number };
      };
    }
    throw new Error("expected a compile error");
  };

  // Stock Marko 6.4.4 (compiler 5.42.11) has no decorators parser plugin: each
  // of these is its syntax error, at the first `@`.
  //   source, 1-based line of the `@`, 0-based column, end column of the first decorator
  const CASES: [string, string, number, number, number][] = [
    ["static class", `${D}static @d() class C {}\n<div/>\n`, 2, 7, 11],
    ["static member", `static class C { @d m() {} }\n<div/>\n`, 1, 17, 19],
    ["server class", "server @d() class C {}\n<div/>\n", 1, 7, 11],
    ["client class", "client @d() class C {}\n<div/>\n", 1, 7, 11],
    ["server member", "server class C { @d m() {} }\n<div/>\n", 1, 17, 19],
    ["client member", "client class C { @d m() {} }\n<div/>\n", 1, 17, 19],
    ["static block", "static { @d class C {} }\n<div/>\n", 1, 9, 11],
    ["export class", "export @d class C {}\n<div/>\n", 1, 7, 9],
    [
      "class expression",
      "static const K = class { @d m() {} }\n<div/>\n",
      1,
      25,
      27,
    ],
    ["property", "static class C { @d x = 1 }\n<div/>\n", 1, 17, 19],
    ["accessor", "static class C { @d accessor x = 1 }\n<div/>\n", 1, 17, 19],
    ["parameter", "static class C { m(@d x) {} }\n<div/>\n", 1, 19, 21],
    ["several decorators", "static @d @e class C {}\n<div/>\n", 1, 7, 9],
    [
      "member of a later statement",
      "static class A {}\nstatic class C {\n  @d.x(1)\n  m() {}\n}\n<div/>\n",
      3,
      2,
      9,
    ],
  ];

  it.each(CASES)(
    "refuses %s, on the `@` with the decorator as its span (lowerSource)",
    (_label, source, line, column, endColumn) => {
      const e = failure(() => lowerSource(source));
      expect(e.diagnosticCode).toBe("MX_INVALID_STATEMENT");
      expect(e.message).toMatch(/^Decorators are not read inside an? `\w+`/);
      expect(e.message).toContain("Move the decorated class");
      expect([e.line, e.column]).toEqual([line, column]);
      expect(e.end?.line).toBe(line);
      expect(e.end?.column).toBe(endColumn);
    },
  );

  it.each(CASES)(
    "refuses %s through compile",
    (_label, source, line, column, endColumn) => {
      const e = failure(() => compile(source));
      expect(e.diagnosticCode).toBe("MX_INVALID_STATEMENT");
      expect([e.line, e.column]).toEqual([line, column]);
      expect(e.end?.column).toBe(endColumn);
    },
  );

  it("names the keyword the statement was written with", () => {
    expect(
      failure(() => lowerSource("server @d() class C {}\n<div/>\n")).message,
    ).toContain("inside a `server` statement");
    expect(
      failure(() => lowerSource("export @d class C {}\n<div/>\n")).message,
    ).toContain("inside an `export` statement");
  });

  it("ends the span of a multi-line decorator on its last line", () => {
    const e = failure(() =>
      lowerSource("static class C {\n  @d(\n    1,\n  ) m() {}\n}\n<div/>\n"),
    );
    expect([e.line, e.column]).toEqual([2, 2]);
    expect(e.end).toEqual({ line: 4, column: 3 });
  });

  it("still reads a class with no decorator", () => {
    const ir = lowerSource("static class K { m() {} }\n<div/>\n");
    expect(ir.hoisted.map((s) => s.code)).toContain("class K { m() {} }");
  });

  it("keeps a plain syntax error that is not a decorator as Babel's own", () => {
    expect(() => lowerSource("static class K { @ }\n<div/>\n")).toThrow();
    expect(
      failure(() => lowerSource("static const a = 1 +\n")).diagnosticCode,
    ).toBe("MX_INVALID_STATEMENT");
  });
});
