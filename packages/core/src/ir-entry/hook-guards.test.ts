/**
 * The hook contract's guards and carriers, through `lowerSource`, on a
 * test-local probe dialect: a `ctx.fail` or `ctx.attribute` span outside the
 * document, a diagnostic's `code`, the method-value forms (`method`,
 * `async-method`), and which diagnostics carry a `file`.
 */
import { describe, expect, it } from "vitest";
import memberFixture from "../fixtures/syntax/member-fixture.ts";
import type { Attr, DelegatedTag } from "../ir.ts";
import type { Dialect } from "../syntax-table.ts";
import { type LowerSourceOptions, lowerSource, type Spanned } from "./index.ts";

const BASE: LowerSourceOptions = { structural: "reject", imports: "pass" };

type SpannedTag = Spanned<DelegatedTag>;
type SpannedAttr = Spanned<Attr>;
type SpannedNode = { kind: string };

function tags(nodes: readonly SpannedNode[]): SpannedTag[] {
  return nodes.flatMap((node) =>
    node.kind === "DelegatedTag"
      ? [(node as unknown as { tag: SpannedTag }).tag]
      : [],
  );
}

/** The first tag named `name`, depth first. */
function find(nodes: readonly SpannedNode[], name: string): SpannedTag {
  for (const tag of tags(nodes)) {
    if (tag.name === name) return tag;
    try {
      return find(tag.children, name);
    } catch {
      // not under this one
    }
  }
  throw new Error(`no <${name}>`);
}

function attr(tag: SpannedTag, name: string): SpannedAttr {
  const found = tag.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name} on <${tag.name}>`);
  return found;
}

describe("hook-contract guards and carriers", () => {
  /** A module whose `!` attribute row calls `hook`. */
  const probe = (hook: NonNullable<Dialect["lowerTrigger"]>): Dialect => ({
    id: "probe",
    name: "Fixture",
    table: {
      attributeTriggers: [
        {
          id: "probe",
          chars: "!",
          match: "![a-z]+",
          standIn: "keep",
          node: { call: "probe" },
        },
      ],
    },
    lowerTrigger: hook,
  });

  it.each([
    [{ sourceStart: -5, sourceEnd: -1 }],
    [{ sourceStart: 500, sourceEnd: 600 }],
    [{ sourceStart: 3, sourceEnd: 2 }],
  ])(
    "`ctx.fail`'s `at` %j outside the document is the hook-contract error at the trigger",
    (at) => {
      const module = probe((_id, _text, _span, ctx) => ctx.fail("x", { at }));
      const { diagnostics } = lowerSource("<y !ab/>", "/v/x.mx", {
        dialect: module,
      });
      expect(diagnostics[0]).toMatchObject({
        message: expect.stringContaining(
          "`ctx.fail`'s `at` is a `{ sourceStart, sourceEnd }` span inside the document (0 to 8)",
        ),
        line: 1,
        column: 3,
        offset: 3,
      });
    },
  );

  it("`ctx.attribute`'s `at` outside the document is refused too", () => {
    const module = probe((_id, _text, _span, ctx) =>
      ctx.attribute("a", true, { at: { sourceStart: -5, sourceEnd: -1 } }),
    );
    const { diagnostics } = lowerSource("<y !ab/>", "/v/x.mx", {
      dialect: module,
    });
    expect(diagnostics[0]?.message).toContain(
      "`ctx.attribute`'s `at` is a `{ sourceStart, sourceEnd }` span inside the document",
    );
  });

  it("`ctx.fail`'s `code` reaches `IrDiagnostic.code`", () => {
    const module = probe((_id, _text, _span, ctx) =>
      ctx.fail("nope", { code: "FIXTURE001" }),
    );
    const { diagnostics } = lowerSource("<y !ab/>", "/v/x.mx", {
      dialect: module,
    });
    expect(diagnostics[0]).toMatchObject({
      message: "nope",
      code: "FIXTURE001",
    });
    // A diagnostic with no code carries none.
    expect(
      lowerSource("<y x=(/>", "/v/x.mx", {}).diagnostics[0],
    ).not.toHaveProperty("code");
  });

  it("a method value the hook drops is named a method value", () => {
    const module = probe((_id, _text, _span, ctx) => ctx.attribute("a", true));
    const { diagnostics } = lowerSource("<y !ab(p) { b }/>", "/v/x.mx", {
      dialect: module,
    });
    expect(diagnostics[0]?.message).toBe(
      "`!ab` takes no method value here: the `probe` trigger does not place it",
    );
  });

  it.each([
    ["<y async !ab(p) { await p }/>", 9, "(p) { await p }"],
    ["kind async !ab<T>(p: T) { await p }\n", 11, "<T>(p: T) { await p }"],
  ])(
    "%j: a placed async method is an async function whose span starts after the trigger",
    (source, triggerStart, valueText) => {
      const seen: unknown[] = [];
      const module = probe((_id, text, span, ctx) => {
        seen.push({ form: ctx.valueForm, value: ctx.value, span });
        return ctx.attribute(text.slice(1), ctx.value ?? true);
      });
      const { ir, diagnostics } = lowerSource(source, "/v/x.mx", {
        dialect: module,
      });
      expect(diagnostics).toEqual([]);
      expect(seen).toEqual([
        {
          form: "async-method",
          value: { kind: "method", async: true },
          span: { sourceStart: triggerStart, sourceEnd: triggerStart + 3 },
        },
      ]);
      const placed = attr(tags(ir?.body ?? [])[0] as SpannedTag, "ab");
      if (placed.kind !== "dynamic") throw new Error(placed.kind);
      const { sourceStart, sourceEnd } = placed.value.span;
      expect(source.slice(sourceStart, sourceEnd)).toBe(valueText);
      expect(placed.value.node).toMatchObject({
        type: "FunctionExpression",
        async: true,
      });
      expect(placed.value.code).toBe("async function (p) { await p; }");
    },
  );

  it("a method without `async` is the `method` form, not async", () => {
    const seen: unknown[] = [];
    const module = probe((_id, text, _span, ctx) => {
      seen.push(ctx.valueForm, ctx.value);
      return ctx.attribute(text.slice(1), ctx.value ?? true);
    });
    const { ir } = lowerSource("<y !ab(p) { p }/>", "/v/x.mx", {
      dialect: module,
    });
    expect(seen).toEqual(["method", { kind: "method", async: false }]);
    const placed = attr(tags(ir?.body ?? [])[0] as SpannedTag, "ab");
    expect(placed).toMatchObject({ value: { node: { async: false } } });
  });
});

describe("`IrDiagnostic.file` names only another file", () => {
  const PATHS: [string, LowerSourceOptions][] = [
    ["core's own grammar", BASE],
    ["the member fixture dialect", { ...BASE, dialect: memberFixture }],
  ];
  const SOURCES = [
    "enum values=[::x]\n",
    "<x :a:b/>",
    "<y x=(/>",
    "entity :A\n  <for of=[1]|x|>\n  </for>\n",
  ];
  it.each(
    PATHS.flatMap(([path, options]) =>
      SOURCES.map((source) => [path, source, options] as const),
    ),
  )(
    "%s, %j: a diagnostic in the parsed file has no `file`",
    (_, source, options) => {
      for (const file of ["/v/x.mesh.mx", "relative/x.mesh.mx"]) {
        const { diagnostics } = lowerSource(source, file, options);
        expect(diagnostics.length, file).toBeGreaterThan(0);
        for (const diagnostic of diagnostics) {
          expect(diagnostic, file).not.toHaveProperty("file");
        }
      }
    },
  );
});
