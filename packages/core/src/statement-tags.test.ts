// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
// Decision 168 / #395 r2: every translator declares the statement tags, a
// translator that does not is refused rather than papered over, and a statement
// is checked the way Marko checks it.
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
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

  it("reads a decorated class (decorators-legacy), as before decision 168", () => {
    const ir = lowerSource(
      "static function d() { return (x: any) => x }\nstatic class K { @d() m() {} }\n<div/>\n",
    );
    expect(ir.hoisted.map((s) => s.code)).toContain("class K { @d() m() {} }");
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
