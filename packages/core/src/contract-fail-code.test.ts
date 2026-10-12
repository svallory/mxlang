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
type HookCtx = { fail: FailFn };
type Hook = (ctx: HookCtx) => never;

function tags(
  hook: Hook,
  where: "analyze" | "transform",
): Record<string, CustomTag> {
  return where === "analyze"
    ? { box: { analyze: (_calls, ctx) => hook(ctx as unknown as HookCtx) } }
    : { box: { transform: (_call, ctx) => hook(ctx as unknown as HookCtx) } };
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

  it("keeps the positional form, with the default code", () => {
    const got = run((ctx) => ctx.fail("boom", AT), where);
    expect(got).toMatchObject({ code: "MX_TAG_ERROR", ...PLACED });
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
  it("takes at alone, with the default code", () => {
    const got = run((ctx) => ctx.fail("boom", { at: AT }), where);
    expect(got).toMatchObject({ code: "MX_TAG_ERROR", ...PLACED });
  });
  it("takes at as a source span, positioned at its start", () => {
    // `<box/>\n<box/>\n`: offset 8 is the second call's name, 2:1.
    const got = run(
      (ctx) =>
        ctx.fail("boom", {
          at: { sourceStart: 8, sourceEnd: 11 },
          code: "X_SPAN",
        }),
      where,
    );
    expect(got).toMatchObject({
      code: "X_SPAN",
      line: 2,
      column: 1,
      offset: 8,
    });
  });
  it("refuses a span outside the document", () => {
    const got = run(
      (ctx) => ctx.fail("boom", { at: { sourceStart: 5, sourceEnd: 99 } }),
      where,
    );
    expect(got?.message).toContain("span inside the document (0 to 14)");
    expect(got).toMatchObject({ code: "MX_TAG_HOOK_ERROR", ...DEFAULT });
  });
  it("refuses a code with MX's own `MX_` prefix", () => {
    const got = run(
      (ctx) => ctx.fail("boom", { at: AT, code: "MX_UNKNOWN_TAG" }),
      where,
    );
    expect(got?.message).toContain(
      "code `MX_UNKNOWN_TAG` starts with `MX_`, which is MX's own prefix",
    );
    expect(got).toMatchObject({ code: "MX_TAG_HOOK_ERROR", ...DEFAULT });
  });
  it("takes no second argument", () => {
    expect(run((ctx) => ctx.fail("boom"), where)).toMatchObject({
      code: "MX_TAG_ERROR",
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
    expect(got).toMatchObject({ code: "MX_TAG_HOOK_ERROR", ...DEFAULT });
  });
  it("refuses an empty code", () => {
    const got = run((ctx) => ctx.fail("boom", { at: AT, code: "" }), where);
    expect(got?.message).toContain("`code` must be a non-empty string");
    expect(got).toMatchObject({ code: "MX_TAG_HOOK_ERROR", ...DEFAULT });
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

describe.each(["analyze", "transform"] as const)(
  "ctx.fail(msg, { at: span }) in %s",
  (where) => {
    it("keeps the span and its end on the error, a position keeps no span", () => {
      const failed = (at: unknown): TranslateError => {
        try {
          compileSource(
            SOURCE,
            "/app/page.mx",
            { tags: {}, isElement: () => true, isComponent: () => false },
            {
              targets,
              emitIr: () => "",
              // `analyze` alone leaves a call nothing to expand to, an
              // earlier error; an empty `transform` keeps the hook's own.
              customTags: {
                box: {
                  transform: () => [],
                  ...tags((ctx) => ctx.fail("boom", { at }), where).box,
                },
              },
            },
          );
        } catch (error) {
          if (error instanceof TranslateError) return error;
          throw error;
        }
        throw new Error("did not fail");
      };
      const spanned = failed({ sourceStart: 8, sourceEnd: 11 });
      expect(spanned.span).toEqual({ sourceStart: 8, sourceEnd: 11 });
      expect([spanned.line, spanned.column]).toEqual([2, 1]);
      // The span's end, exclusive: offset 11 is line 2, column 4.
      expect(spanned.end).toEqual({ line: 2, column: 4 });
      expect(failed(AT).span).toBeUndefined();
    });
  },
);
