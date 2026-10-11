/**
 * A contract hook's `ctx.fail(message, { at?, code? })`: the code reaches
 * `IrDiagnostic.code` through `TranslateError.diagnosticCode`, and the bare
 * position form is unchanged.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import { lowerSource } from "./ir-entry/index.ts";
import type { TemplateBackedTag } from "./template-tag.ts";
import { lookup as targets } from "./test-targets.ts";

// Two `box` calls, the second on line 2: `analyze` without `at` points at the
// first call (1:0), `transform` at the call it runs on, also the first (1:0).
const SOURCE = "<box/>\n<box/>\n";
const AT = { line: 2, column: 0 };

type FailFn = (message: string, ...rest: unknown[]) => never;
type Hook = (ctx: {
  fail: (message: string, ...rest: unknown[]) => never;
}) => never;

function tags(
  hook: Hook,
  where: "analyze" | "transform",
): Record<string, CustomTag> {
  return where === "analyze"
    ? { box: { analyze: (_calls, ctx) => hook(ctx) } }
    : { box: { transform: (_call, ctx) => hook(ctx) } };
}

function run(hook: Hook, where: "analyze" | "transform") {
  const { diagnostics } = lowerSource(SOURCE, "/u.mx", {
    customTags: tags(hook, where),
  });
  const [first] = diagnostics;
  return first
    ? {
        count: diagnostics.length,
        message: first.message,
        code: first.code,
        line: first.line,
        column: first.column,
        offset: first.offset,
      }
    : undefined;
}

describe.each(["analyze", "transform"] as const)("ctx.fail in %s", (where) => {
  // analyze: no `at` is the first call (1:0); transform: the failing call,
  // which is the first one to run (1:0) too.
  const DEFAULT = { line: 1, column: 0, offset: 0 };
  const PLACED = { line: 2, column: 0, offset: 7 };

  it("keeps the positional form, with no code", () => {
    const got = run((ctx) => ctx.fail("boom", AT), where);
    expect(got).toMatchObject({ code: undefined, ...PLACED });
    expect(got?.message).toContain("boom");
  });
  it("takes at and code", () => {
    const got = run(
      (ctx) => ctx.fail("boom", { at: AT, code: "X_ONE" }),
      where,
    );
    expect(got).toMatchObject({ code: "X_ONE", ...PLACED });
  });
  it("takes a code alone and positions as core does", () => {
    const got = run((ctx) => ctx.fail("boom", { code: "X_ONE" }), where);
    expect(got).toMatchObject({ code: "X_ONE", ...DEFAULT });
  });
  it("takes at alone, with no code", () => {
    const got = run((ctx) => ctx.fail("boom", { at: AT }), where);
    expect(got).toMatchObject({ code: undefined, ...PLACED });
  });
  it("takes no second argument", () => {
    expect(run((ctx) => ctx.fail("boom"), where)).toMatchObject({
      code: undefined,
      ...DEFAULT,
    });
  });
  it.each([
    ["a string", "nope", "got string"],
    ["null", null, "got null"],
    ["an array", [], "got object"],
    ["an unknown option", { code: "X", cod: "Y" }, "unknown option `cod`"],
    ["a malformed at", { at: { line: 1 } }, "`at` must be a position"],
    ["a numeric code", { code: 7 }, "`code` must be a non-empty string"],
    ["a position with a code", { ...AT, code: "X" }, "also has `code`"],
    ["a position with an at", { ...AT, at: AT }, "also has `at`"],
    ["a Date", new Date(), "non-plain object"],
    ["an inherited code", Object.create({ code: "X" }), "non-plain object"],
    ["a half position", { line: 2 }, "needs numeric `line` and `column`"],
  ])("refuses %s", (_name, arg, why) => {
    const got = run((ctx) => ctx.fail("boom", arg), where);
    expect(got?.message).toContain("takes a position or");
    expect(got?.message).toContain(why);
    expect(got).toMatchObject({ code: undefined, ...DEFAULT });
  });
  it("refuses an empty code", () => {
    const got = run((ctx) => ctx.fail("boom", { at: AT, code: "" }), where);
    expect(got?.message).toContain("`code` must be a non-empty string");
    expect(got).toMatchObject({ code: undefined, ...DEFAULT });
  });
});

describe("ctx.fail from a tag template's tag", () => {
  it("carries the code through the template compile path", () => {
    try {
      compileSource(
        "<box/>\n",
        "/app/page.mx",
        { tags: {}, isElement: () => true, isComponent: () => false },
        {
          targets,
          emitIr: () => "",
          customTags: {
            box: {
              template: { filename: "/tags/box.mx", source: "<div/>\n" },
              analyze: (_calls: unknown, ctx: { fail: FailFn }) =>
                ctx.fail("from template tag", { code: "X_TPL" }),
            } as unknown as TemplateBackedTag,
          },
        },
      );
      throw new Error("did not fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslateError);
      expect((error as TranslateError).diagnosticCode).toBe("X_TPL");
      expect((error as TranslateError).message).toContain("from template tag");
      expect([
        (error as TranslateError).line,
        (error as TranslateError).column,
      ]).toEqual([1, 0]);
    }
  });
});

describe("ctx.fail from a tag nested in a template", () => {
  it("keeps the code, file and position when the template's metadata compile fails", () => {
    try {
      compileSource(
        "<card>hi</card>\n",
        "/app/page.mx",
        { tags: {}, isElement: () => true, isComponent: () => false },
        {
          targets,
          emitIr: () => "",
          customTags: {
            card: {
              template: {
                filename: "/tags/card.mx",
                source: "<div>\n  <inner/>\n</div>\n",
              },
            } as unknown as TemplateBackedTag,
            inner: {
              transform: (_call: unknown, ctx: { fail: FailFn }) =>
                ctx.fail("x", { code: "X_IN" }),
            } as unknown as CustomTag,
          },
        },
      );
      throw new Error("did not fail");
    } catch (error) {
      const failure = error as TranslateError;
      expect(failure).toBeInstanceOf(TranslateError);
      expect(failure.diagnosticCode).toBe("X_IN");
      expect(failure.file).toBe("/tags/card.mx");
      expect([failure.line, failure.column]).toEqual([2, 2]);
    }
  });
});
