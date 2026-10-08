import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { isTranslateError, type TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
};

function compile(source: string, customTags?: Record<string, CustomTag>) {
  return compileSource(source, "/tmp/mx-error-recovery/page.mx", declarations, {
    targets,
    tagDiscoveryDirs: [],
    customTags,
    emitIr: () => "emitted",
  }).code;
}

function errorsOf(
  source: string,
  customTags?: Record<string, CustomTag>,
): TranslateError[] {
  try {
    compile(source, customTags);
  } catch (error) {
    if (!isTranslateError(error)) throw error;
    return [...(error.errors ?? [error])];
  }
  throw new Error("expected the compile to throw");
}

function thrown(source: string): TranslateError {
  try {
    compile(source);
  } catch (error) {
    if (isTranslateError(error)) return error;
    throw error;
  }
  throw new Error("expected the compile to throw");
}

const SCRIPTLET = "$ const a = 1";
const NO_CONDITION = "<if></if>";

describe("per-tag error recovery in lower (decision 162)", () => {
  it("reports three independent errors, ordered by position", () => {
    const source = [
      "<div>ok</div>",
      SCRIPTLET,
      "<p>fine</p>",
      NO_CONDITION,
      "<![CDATA[raw]]>",
      "<span>fine</span>",
    ].join("\n");
    const errors = errorsOf(source);
    expect(errors.map((error) => error.line)).toEqual([2, 4, 5]);
    expect(errors[0]?.message).toContain("scriptlets");
    expect(errors[1]?.message).toContain("without a condition");
    expect(errors[2]?.message).toContain("CDATA");
  });

  it("throws errors[0] itself, exactly what a single throw was", () => {
    const first = thrown(`${SCRIPTLET}\n${NO_CONDITION}`);
    const alone = thrown(SCRIPTLET);
    expect(first.errors?.[0]).toBe(first);
    expect(first.message).toBe(alone.message);
    expect(first.line).toBe(alone.line);
    expect(first.column).toBe(alone.column);
  });

  it("reports an error that is the only one as a one-entry list", () => {
    const error = thrown(SCRIPTLET);
    expect(error.errors).toEqual([error]);
  });

  it("skips a failed tag's whole subtree: its children raise nothing", () => {
    // The `<if>` fails on its missing condition; the scriptlet inside it
    // would fail too, but is never lowered.
    const errors = errorsOf(`<if>\n  ${SCRIPTLET}\n</if>`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("without a condition");
  });

  it("collects errors inside a tag that itself lowers fine", () => {
    const errors = errorsOf(
      `<div>\n  ${SCRIPTLET}\n  <p>ok</p>\n  <![CDATA[x]]>\n</div>\n${NO_CONDITION}`,
    );
    expect(errors.map((error) => error.line)).toEqual([2, 4, 6]);
  });

  it("collects errors from sibling branches of one if chain", () => {
    const errors = errorsOf(
      "<if=a>\n  <![CDATA[x]]>\n</if>\n<else>\n  $ const b = 1\n</else>",
    );
    expect(errors.map((error) => error.line)).toEqual([2, 5]);
  });

  it("keeps lowering after a failed if head, past its else branches", () => {
    const errors = errorsOf(
      `${NO_CONDITION}\n<else>\n  <p>x</p>\n</else>\n${SCRIPTLET}`,
    );
    expect(errors.map((error) => error.line)).toEqual([1, 5]);
  });

  it("leaves an error-free file untouched", () => {
    expect(
      compile("<div>ok</div>\n<if=a><p>x</p></if><else><p>y</p></else>"),
    ).toBe("emitted");
  });

  describe("a file that uses an analyze tag", () => {
    const marker: CustomTag = {
      analyze(calls, ctx) {
        if (calls.length > 1) throw ctx.fail("only one marker allowed");
      },
      transform: (_call, ctx) => [ctx.build.element("span", [], [])],
    };

    it("keeps the walk's first error as errors[0], not the hook's", () => {
      const errors = errorsOf("$ const a = 1\n<marker/>\n<marker/>", {
        marker,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("scriptlets");
    });

    it("keeps an independent walk error the hook would have hidden", () => {
      const errors = errorsOf("<marker/>\n<marker/>\n<if></if>", { marker });
      expect(errors.map((error) => error.line)).toEqual([3]);
      expect(errors[0]?.message).toContain("without a condition");
    });

    it("still reports the hook's own error when the walk is clean", () => {
      const errors = errorsOf("<marker/>\n<marker/>", { marker });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("only one marker allowed");
    });
  });

  describe("a consequence of an earlier error is not its own error", () => {
    it("a failed <define> head still binds the name for later calls", () => {
      const errors = errorsOf("<define/Foo(1)>x</define>\n<Foo/>\n<if></if>");
      expect(errors.map((error) => error.line)).toEqual([1, 3]);
      expect(errors[0]?.message).toContain("Tag does not support arguments");
      expect(
        errors.some((error) => error.message.includes("entry point")),
      ).toBe(false);
    });

    it("a nameless <define> is its own error and a later call is too", () => {
      const errors = errorsOf("<define>x</define>\n<Foo/>");
      expect(errors.map((error) => error.line)).toEqual([1, 2]);
    });

    it("a failed <const> or <let> leaves no second error for its readers", () => {
      for (const tag of ["const", "let"]) {
        const errors = errorsOf(
          `<${tag}/x=1 bogus=2/>\n<div>\${x}</div>\n<if></if>`,
        );
        expect(errors.map((error) => error.line)).toEqual([1, 3]);
      }
    });

    it("an import never fails after binding its name", () => {
      const errors = errorsOf('import Foo from "./nope.mx"\n<Foo/>\n<if></if>');
      expect(errors.map((error) => error.line)).toEqual([3]);
    });
  });
});
