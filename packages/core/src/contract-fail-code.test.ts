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

describe("analyze hooks of several tags", () => {
  const failing = (name: string) => ({
    analyze: (
      calls: readonly { loc: { line: number; column: number } }[],
      ctx: { fail: FailFn },
    ) => ctx.fail(`bad ${name}`, { at: calls[0]?.loc }),
  });
  const customTags = {
    box: failing("box"),
    crate: failing("crate"),
  } as unknown as Record<string, CustomTag>;

  it("one tag's failure does not hide another tag's", () => {
    const { diagnostics } = lowerSource("<box/>\n<crate/>\n", "/u.mx", {
      customTags,
    });
    expect(diagnostics.map((d) => d.message.replace(/^.*: /, ""))).toEqual([
      expect.stringContaining("bad box"),
      expect.stringContaining("bad crate"),
    ]);
    expect(diagnostics.map((d) => d.line)).toEqual([1, 2]);
  });

  // The tag that fails earliest in the file is the primary error, whatever
  // its name: `zeta` sorts after `alpha`, and stands on line 1.
  const ordered = {
    zeta: failing("zeta"),
    alpha: failing("alpha"),
  } as unknown as Record<string, CustomTag>;
  const ORDER_SOURCE = "<zeta/>\n<p/>\n<alpha/>\n";

  it("lists the failures in file order, not tag-name order", () => {
    const { diagnostics } = lowerSource(ORDER_SOURCE, "/u.mx", {
      customTags: ordered,
    });
    expect(diagnostics.map((d) => d.line)).toEqual([1, 3]);
  });

  it("throws the earliest failure in the file as the primary error", () => {
    let thrown: TranslateError | undefined;
    try {
      compileSource(
        ORDER_SOURCE,
        "/u.mx",
        { tags: {}, isElement: () => true, isComponent: () => false },
        {
          targets,
          emitIr: () => "",
          customTags: {
            zeta: { transform: () => [], ...ordered.zeta },
            alpha: { transform: () => [], ...ordered.alpha },
          } as unknown as Record<string, CustomTag>,
        },
      );
    } catch (error) {
      thrown = error as TranslateError;
    }
    expect(thrown?.line).toBe(1);
    expect(thrown?.message).toContain("bad zeta");
    expect((thrown?.errors ?? []).map((e) => e.line)).toEqual([1, 3]);
  });

  it("never leads with a related error from another file, and only the primary carries the list", () => {
    const COMPILED = "/u.mx";
    let kept: TranslateError | undefined;
    const box = {
      analyze: (calls: readonly { loc: { line: number } }[]) => {
        const main = new TranslateError("main box", calls[0]?.loc.line ?? 1, 0);
        const elsewhere = new TranslateError("elsewhere", 1, 0, "other.mx");
        main.errors = [main, elsewhere];
        kept = main;
        throw main;
      },
    };
    let thrown: TranslateError | undefined;
    try {
      compileSource(
        "<p/>\n<crate/>\n<p/>\n<p/>\n<box/>\n",
        COMPILED,
        { tags: {}, isElement: () => true, isComponent: () => false },
        {
          targets,
          emitIr: () => "",
          customTags: {
            box: { transform: () => [], ...box },
            crate: { transform: () => [], ...failing("crate") },
            p: { transform: () => [] },
          } as unknown as Record<string, CustomTag>,
        },
      );
    } catch (error) {
      thrown = error as TranslateError;
    }
    expect(thrown?.line).toBe(2);
    expect(thrown?.file === undefined || thrown.file === COMPILED).toBe(true);
    const list = thrown?.errors ?? [];
    expect(list.map((e) => [e.file, e.line])).toEqual([
      [undefined, 2],
      [undefined, 5],
      ["other.mx", 1],
    ]);
    expect(list.slice(1).every((e) => !e.errors?.length)).toBe(true);
    // The error the hook threw is left as it was: the aggregate is built from copies.
    expect(thrown).not.toBe(kept);
    expect(kept?.errors?.map((e) => e.message)).toEqual([
      "main box",
      "elsewhere",
    ]);
  });

  it("sorts an error that names the compiled file with one that does not by position", () => {
    const COMPILED = "/u.mx";
    const box = {
      analyze: () => {
        const main = new TranslateError("main box", 1, 0);
        const named = new TranslateError("named", 2, 0, COMPILED);
        main.errors = [main, named];
        throw main;
      },
    };
    let thrown: TranslateError | undefined;
    try {
      compileSource(
        "<box/>\n<p/>\n<crate/>\n",
        COMPILED,
        { tags: {}, isElement: () => true, isComponent: () => false },
        {
          targets,
          emitIr: () => "",
          customTags: {
            box: { transform: () => [], ...box },
            crate: { transform: () => [], ...failing("crate") },
            p: { transform: () => [] },
          } as unknown as Record<string, CustomTag>,
        },
      );
    } catch (error) {
      thrown = error as TranslateError;
    }
    expect((thrown?.errors ?? []).map((e) => e.line)).toEqual([1, 2, 3]);
  });

  it("places the end of a span error a hook keeps and rethrows in each compile, on a copy", () => {
    let kept: TranslateError | undefined;
    const box = {
      transform: () => [],
      analyze: (_calls: unknown, ctx: { fail: FailFn }) => {
        if (kept) throw kept;
        try {
          ctx.fail("kept", { at: { sourceStart: 8, sourceEnd: 11 } });
        } catch (error) {
          kept = error as TranslateError;
          throw kept;
        }
      },
    };
    const endOf = (source: string) => {
      try {
        compileSource(
          source,
          "/u.mx",
          { tags: {}, isElement: () => true, isComponent: () => false },
          {
            targets,
            emitIr: () => "",
            customTags: {
              box,
              p: { transform: () => [] },
            } as unknown as Record<string, CustomTag>,
          },
        );
      } catch (error) {
        const thrown = error as TranslateError;
        expect(thrown).not.toBe(kept);
        return thrown.end && [thrown.end.line, thrown.end.column];
      }
      throw new Error("did not fail");
    };
    // The span ends at offset 11: line 3, column 1 of the first source, line 2,
    // column 4 of the second. The kept error is never written to, so the second
    // compile places its own end instead of reading the first one's.
    expect(endOf("<p/>\n<p/>\n<box/>\n")).toEqual([3, 1]);
    expect(kept?.end).toBeUndefined();
    expect(endOf("<box/>\n<p/>\n")).toEqual([2, 4]);
  });

  it("copies the one error a single failing hook threw", () => {
    const kept = new TranslateError("kept", 1, 0);
    let thrown: TranslateError | undefined;
    try {
      compileSource(
        "<box/>\n",
        "/u.mx",
        { tags: {}, isElement: () => true, isComponent: () => false },
        {
          targets,
          emitIr: () => "",
          customTags: {
            box: {
              transform: () => [],
              analyze: () => {
                throw kept;
              },
            },
          } as unknown as Record<string, CustomTag>,
        },
      );
    } catch (error) {
      thrown = error as TranslateError;
    }
    expect(thrown?.message).toContain("kept");
    expect(thrown).not.toBe(kept);
  });

  it("keeps the related errors a failing hook carries", () => {
    const related = (line: number) =>
      new TranslateError(`related at ${line}`, line, 0);
    const carrier = {
      analyze: (calls: readonly { loc: { line: number } }[]) => {
        const main = new TranslateError("main", calls[0]?.loc.line ?? 1, 0);
        main.errors = [main, related(5), related(6)];
        throw main;
      },
    };
    const { diagnostics } = lowerSource("<box/>\n<crate/>\n", "/u.mx", {
      customTags: {
        box: carrier,
        crate: failing("crate"),
      } as unknown as Record<string, CustomTag>,
    });
    expect(diagnostics.map((d) => d.line)).toEqual([1, 2, 5, 6]);
    expect(diagnostics.map((d) => d.message.replace(/^.*: /, ""))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("related at 5"),
        expect.stringContaining("related at 6"),
      ]),
    );
  });
});
