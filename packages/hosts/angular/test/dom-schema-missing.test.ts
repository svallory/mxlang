/**
 * Without `@angular/compiler` anywhere (the optional peer not installed), a
 * compile that needs Angular's DOM schema fails loudly at the first attribute
 * that needs it, never with a silent `[name]` fallback. Module resolution is
 * stubbed to miss `@angular/compiler` only.
 */
import { stripVTControlCharacters } from "node:util";
import { TranslateError } from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (from: string | URL) => {
    const real = actual.createRequire(from);
    const missing = (id: string) => id.startsWith("@angular/compiler");
    const stub = ((id: string) => {
      if (missing(id)) throw new Error(`Cannot find module '${id}'`);
      return real(id);
    }) as NodeJS.Require;
    stub.resolve = ((id: string, options?: { paths?: string[] }) => {
      if (missing(id)) throw new Error(`Cannot find module '${id}'`);
      return real.resolve(id, options);
    }) as NodeJS.RequireResolve;
    return stub;
  };
  return { ...actual, createRequire, default: { ...actual, createRequire } };
});

const { compile } = await import("../src/index.ts");

describe("a missing @angular/compiler", () => {
  it("compiles templates that never consult the schema", () => {
    expect(() =>
      compile("<div data-x=a aria-label=b class=c title='t'/>", "x.mx"),
    ).not.toThrow();
  });

  it("fails at the first attribute that needs the schema, positioned, naming the fix", () => {
    let error: unknown;
    try {
      compile(
        "<div data-x=a>\n  <input maxlength=n disabled=d/>\n</div>",
        "x.mx",
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TranslateError);
    const { line, column } = error as TranslateError;
    const message = stripVTControlCharacters((error as TranslateError).message);
    expect(message).toContain("@angular/compiler was not found from");
    expect(message).toContain("bun add -d @angular/compiler");
    expect(message).toContain("[attr.name]");
    expect([line, column]).toEqual([2, 9]);
  });
});
