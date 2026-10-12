/**
 * `IrDiagnostic.end` where it used to be missing or short, and the two guards
 * that keep an end inside its own file (see `diagnostic-end.test.ts` for the
 * general rule: `end` is exclusive and in the file of the start).
 *
 * - a callee `Input` rule broken by a repeated attribute tag ends at the name;
 * - an unnamed tag (`<#a/>`) ends after its head, not at its `<`;
 * - an attribute with a parenthesised value ends after the `)`, on any line;
 * - `positionError` keeps an end from another file out, and never ends a range
 *   before it starts.
 *
 * The scan's own range (`ScanDiagnostic.end`) is pinned in
 * `reserved-tags.test.ts`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSource, type HostOptions } from "../compile.ts";
import { endErrorAt, newCtx, positionError, TranslateError } from "../core.ts";
import type { Policy } from "../declarations.ts";
import type { Attr, DelegatedTag } from "../ir.ts";
import { lookup, testTargetLookup } from "../test-targets.ts";
import { type IrDiagnostic, lowerSource, type Spanned } from "./index.ts";

let root = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mx-end-gaps-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `[line, column, offset]` of a diagnostic's start and of its end. */
function range(d: IrDiagnostic | undefined) {
  return {
    start: [d?.line, d?.column, d?.offset],
    end: d?.end && [d.end.line, d.end.column, d.end.offset],
  };
}

describe("a repeated attribute tag against a callee's Input ends at its name", () => {
  const CARD = `export interface Input {
  head: AttrTag<{ as: "renderable" }>
}
<div/>
`;

  /** The errors `compileSource` throws for `source` next to a `Card.mx` callee. */
  function compileErrors(source: string) {
    const dir = realpathSync(mkdtempSync(join(root, "d-")));
    writeFileSync(join(dir, "Card.mx"), CARD);
    try {
      compileSource(
        source,
        join(dir, "page.mx"),
        {
          tags: {},
          isElement: () => true,
          isComponent: (name: string, ctx: { defines: Set<string> }) =>
            ctx.defines.has(name),
          attrTags: 2,
          name: "TestHost",
        } as unknown as Policy,
        {
          targets: testTargetLookup(),
          customTags: {},
          tagDiscoveryDirs: [],
          emitIr: () => "",
          warnings: [],
        } as unknown as HostOptions,
      );
    } catch (cause) {
      const error = cause as TranslateError;
      return [...(error.errors?.length ? error.errors : [error])];
    }
    throw new Error("compileSource did not throw");
  }

  const shown = (e: TranslateError) => ({
    code: e.diagnosticCode,
    line: e.line,
    column: e.column,
    end: e.end,
  });

  it("the second `<@head>` ends after `head`", () => {
    const errors = compileErrors(
      "import Card from './Card.mx'\n<Card>\n  <@head>H</@head>\n  <@head>I</@head>\n</Card>\n",
    );
    expect(errors.map(shown)).toEqual([
      {
        code: "MX_REPEATED_ATTRIBUTE_TAG",
        line: 4,
        column: 4,
        end: { line: 4, column: 8 },
      },
    ]);
    expect(errors[0]?.message).toBe(
      "`<@head>` may appear at most once (`head` is declared `AttrTag`, not `AttrTag[]`)",
    );
  });

  it("a `<@head>` inside `<for>` ends after the `<for`", () => {
    const errors = compileErrors(
      "import Card from './Card.mx'\n<Card>\n  <for|i| of=[1]>\n    <@head>H</@head>\n  </for>\n</Card>\n",
    );
    expect(errors.map(shown)).toEqual([
      {
        code: "MX_REPEATED_ATTRIBUTE_TAG",
        line: 3,
        column: 2,
        end: { line: 3, column: 6 },
      },
    ]);
    expect(errors[0]?.message).toBe(
      "`<@head>` may not appear inside `<for>` (`head` is declared `AttrTag`, not `AttrTag[]`)",
    );
  });
});

describe("an unnamed tag's whole-tag range covers its head", () => {
  const CLOSED = { card: { children: { item: {} } } };
  const lower = (source: string) =>
    lowerSource(source, "/t.mx", { customTags: CLOSED }).diagnostics;

  it("`<#a/>` ends after `<#a`, not at its `<`", () => {
    expect(lower("<card>\n  <#a/>\n</card>").map(range)).toEqual([
      { start: [2, 2, 9], end: [2, 5, 12] },
    ]);
  });

  it("`<#a.b/>` ends after `<#a.b`", () => {
    expect(lower("<card>\n  <#a.b/>\n</card>").map(range)).toEqual([
      { start: [2, 2, 9], end: [2, 7, 14] },
    ]);
  });

  it("`<.x#y/>` ends after `<.x#y`", () => {
    expect(lower("<card>\n  <.x#y/>\n</card>").map(range)).toEqual([
      { start: [2, 2, 9], end: [2, 7, 14] },
    ]);
  });

  it("an unnamed tag with a body ends at its head, not at its close", () => {
    expect(lower("<card>\n  <#a>\n    x\n  </>\n</card>").map(range)).toEqual([
      { start: [2, 2, 9], end: [2, 5, 12] },
    ]);
  });

  it("a named tag still ends after its name", () => {
    expect(lower("<card>\n  <foo#a/>\n</card>").map(range)).toEqual([
      { start: [2, 2, 9], end: [2, 6, 13] },
    ]);
  });
});

describe("an attribute with a parenthesised value ends after the `)`", () => {
  it("MX_DUPLICATE_ATTRIBUTE on a multi-line `a=( … )` ends at offset 14, on line 3", () => {
    const { diagnostics } = lowerSource("<div a=(\n  1\n) a=2/>\n", "/t.mx");
    expect(diagnostics.map((d) => [d.code, d.severity, d.message])).toEqual([
      [
        "MX_DUPLICATE_ATTRIBUTE",
        "warning",
        "duplicate attribute `a`: the later one at 3:3 wins, so this one is dropped",
      ],
    ]);
    expect(range(diagnostics[0])).toEqual({
      start: [1, 5, 5],
      end: [3, 1, 14],
    });
  });

  it("a one-line `a=(1)` ends after its `)`", () => {
    const { diagnostics } = lowerSource("<div a=(1) a=2/>\n", "/t.mx");
    expect(range(diagnostics[0])).toEqual({
      start: [1, 5, 5],
      end: [1, 10, 10],
    });
  });

  it("an attribute without parentheses is unchanged", () => {
    const { diagnostics } = lowerSource("<div a=1 a=2/>\n", "/t.mx");
    expect(range(diagnostics[0])).toEqual({ start: [1, 5, 5], end: [1, 8, 8] });
  });

  function attrsOf(source: string): Attr[] {
    const result = lowerSource(source, "/v/a.mx");
    expect(result.diagnostics).toEqual([]);
    const node = result.ir?.body[0];
    if (node?.kind !== "DelegatedTag") throw new Error("no tag");
    return (node.tag as Spanned<DelegatedTag>).attrs;
  }

  it.each([
    ["x a=(\n  1\n) b=2\n", "a", "a=(\n  1\n)"],
    ["x a=(1) b=2\n", "a", "a=(1)"],
    ["x a=1 b=(\n 2\n)\n", "b", "b=(\n 2\n)"],
    ["x a=[\n 1\n] b=2\n", "a", "a=[\n 1\n]"],
    ["x a=1 b=2\n", "b", "b=2"],
  ])("`Attr.span` of %j covers the whole attribute", (source, name, text) => {
    const found = attrsOf(source).find(
      (a) => a.kind !== "spread" && a.name === name,
    );
    expect(source.slice(found?.span?.sourceStart, found?.span?.sourceEnd)).toBe(
      text,
    );
  });
});

describe("positionError's end guards", () => {
  const ctxFor = (source: string, filename = "test.mx") =>
    newCtx(
      source,
      () => "",
      {
        tags: {},
        isElement: () => true,
        isComponent: () => false,
      } as Policy,
      undefined,
      filename,
      lookup,
    );

  /** An error already placed at `line`:`column`, as a contract check places one. */
  const placed = (line: number, column: number, file?: string) =>
    new TranslateError("blamed", line, column, file);

  it("an offset into this file becomes the end, in lines and columns", () => {
    const ctx = ctxFor("ab\ncd\nef\n");
    const error = placed(1, 1);
    endErrorAt(error, 4);
    positionError(ctx, error);
    expect(error.end).toEqual({ line: 2, column: 1 });
  });

  it("an offset past the end of the source stops at the end of the source", () => {
    const ctx = ctxFor("ab\ncd");
    const error = placed(1, 0);
    endErrorAt(error, 999);
    positionError(ctx, error);
    expect(error.end).toEqual({ line: 2, column: 2 });
  });

  it("an error in another file gets no end from this file's offsets", () => {
    // The offset 4 is a place in `ab\ncd\n`, not in `/tags/box.mx`.
    const ctx = ctxFor("ab\ncd\nef\n", "/pages/page.mx");
    const error = placed(1, 0, "/tags/box.mx");
    endErrorAt(error, 4);
    positionError(ctx, error);
    expect(error.end).toBeUndefined();
  });

  it("an error in this file, named by its own path, still gets one", () => {
    const ctx = ctxFor("ab\ncd\nef\n", "/pages/page.mx");
    const error = placed(1, 0, "/pages/page.mx");
    endErrorAt(error, 4);
    positionError(ctx, error);
    expect(error.end).toEqual({ line: 2, column: 1 });
  });

  it("an end on an earlier line is the start: a range never ends before it starts", () => {
    const ctx = ctxFor("ab\ncd\nef\n");
    const error = placed(3, 1);
    endErrorAt(error, 0);
    positionError(ctx, error);
    expect(error.end).toEqual({ line: 3, column: 1 });
  });

  it("an end earlier on the same line is the start", () => {
    const ctx = ctxFor("abcdef\n");
    const error = placed(1, 4);
    endErrorAt(error, 2);
    positionError(ctx, error);
    expect(error.end).toEqual({ line: 1, column: 4 });
  });

  it("an end at the start is kept as it is", () => {
    const ctx = ctxFor("abcdef\n");
    const error = placed(1, 4);
    endErrorAt(error, 4);
    positionError(ctx, error);
    expect(error.end).toEqual({ line: 1, column: 4 });
  });
});
