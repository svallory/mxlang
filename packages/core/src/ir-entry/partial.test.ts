import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { type MxWarning, newCtx } from "../core.ts";
import type { CustomTag } from "../custom-tags.ts";
import atomFixture from "../fixtures/syntax/atom-fixture.ts";
import { parseFragment } from "../fragment.ts";
import { lowerChildren } from "../lower.ts";
import type { Dialect } from "../syntax-table.ts";
import {
  peekTemplateMetadata,
  resetTemplateCache,
  type TemplateBackedTag,
  templateCompileCount,
} from "../template-tag.ts";
import { lookup as targets } from "../test-targets.ts";
import { childrenWithTriggers, lowerTriggers } from "../triggers.ts";
import { checkIr } from "./checks.ts";
import {
  type LowerSourceOptions,
  type LowerSourceResult,
  lowerFile,
  lowerSource,
} from "./index.ts";
import { beginPartialIr, withPartialIr } from "./recovery.ts";

const FILE = "/partial/page.mx";
function names(result: LowerSourceResult): string[] {
  const visit = (
    nodes: NonNullable<LowerSourceResult["ir"]>["body"],
  ): string[] =>
    nodes.flatMap((node) =>
      node.kind === "DelegatedTag"
        ? [node.tag.name, ...visit(node.tag.children)]
        : [],
    );
  return visit(result.ir?.body ?? []);
}
function validPartial(
  source: string,
  options: LowerSourceOptions = {},
): LowerSourceResult {
  const result = lowerSource(source, FILE, { ...options, partial: true });
  expect(result.partial).toBe(true);
  expect(result.ir).toBeDefined();
  expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  expect(result.diagnostics.every((d) => d.code && d.offset >= 0)).toBe(true);
  expect(
    checkIr(result.ir!, source, {
      structural: "pass",
      unknownTags: "allow",
      declaredTags: new Set(),
    }),
  ).toEqual([]);
  return result;
}

const contractDocs = () => [
  readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
  readFileSync(
    new URL(
      "../../../../apps/docs/docs/architecture/ir-entry.md",
      import.meta.url,
    ),
    "utf8",
  ),
  readFileSync(
    new URL("../../../../apps/docs/docs/specification.md", import.meta.url),
    "utf8",
  ),
];

const messages = (result: LowerSourceResult) =>
  result.diagnostics.map((d) => stripVTControlCharacters(d.message));

describe("opt-in partial IR", () => {
  it("keeps a parent and valid siblings when its child fails", () => {
    const source = '<root><before a="yes"/><if/><after b=1/></root><tail/>';
    const result = validPartial(source);
    expect(names(result)).toEqual(["root", "before", "after", "tail"]);
    expect(messages(result)).toEqual(messages(lowerSource(source, FILE)));
    expect(lowerSource(source, FILE).ir).toBeUndefined();
    expect(lowerSource(source, FILE, { partial: false })).toEqual(
      lowerSource(source, FILE),
    );
    const root = result.ir!.body[0];
    if (root?.kind !== "DelegatedTag") throw new Error("root");
    expect(
      source.slice(root.tag.span.sourceStart, root.tag.span.sourceEnd),
    ).toBe('<root><before a="yes"/><if/><after b=1/></root>');
    for (const child of root.tag.children) {
      if (child.kind !== "DelegatedTag") throw new Error("child");
      expect(
        source.slice(
          child.tag.nameSpan.sourceStart,
          child.tag.nameSpan.sourceEnd,
        ),
      ).toBe(child.tag.name);
      expect(child.tag.args).toEqual([]);
      for (const attr of child.tag.attrs) {
        expect(attr.span).toBeDefined();
        if (attr.kind === "static" || attr.kind === "dynamic")
          expect(attr.valueSpan).toBeDefined();
      }
    }
  });

  it("omits the whole tag when its own attribute fails", () => {
    const source = '<before/><bad n="wrong"><inner/></bad><after/>';
    const options = {
      customTags: {
        bad: { attributes: { n: { type: "number" } } } as CustomTag,
      },
    };
    const result = validPartial(source, options);
    expect(names(result)).toEqual(["before", "after"]);
    expect(messages(result)).toEqual(
      messages(lowerSource(source, FILE, options)),
    );
  });

  it.each(["value", "expression", "attribute"])(
    "recovers a %s dialect hook failure and preserves surviving dialect nodes",
    (position) => {
      const nodeType = atomFixture.nodeTypes!.Atom!;
      const dialect: Dialect = {
        ...atomFixture,
        nodeTypes: {
          ...atomFixture.nodeTypes,
          Atom: {
            ...nodeType,
            lower(node, ctx) {
              if (node.name === "bad")
                return ctx.fail("bad fixture atom", {
                  code: "FIXTURE_BAD",
                  at: node.span,
                });
              return nodeType.lower!(node, ctx);
            },
          },
        },
      };
      const bad =
        position === "value"
          ? "x=~bad"
          : position === "expression"
            ? 'x=(~bad + "x")'
            : "~bad";
      const source = `<root><bad ${bad}/><good x=~ok/></root><tail/>`;
      const result = validPartial(source, { dialect });
      expect(names(result)).toEqual(["root", "good", "tail"]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "FIXTURE_BAD",
          message: "bad fixture atom",
        }),
      ]);
      const root = result.ir!.body[0];
      if (root?.kind !== "DelegatedTag") throw new Error("root");
      const good = root.tag.children[0];
      if (good?.kind !== "DelegatedTag") throw new Error("good");
      expect(good.tag.attrs[0]).toMatchObject({
        kind: "static",
        node: { type: "atom:Atom", name: "ok" },
        valueSpan: {
          sourceStart: source.indexOf("~ok"),
          sourceEnd: source.indexOf("~ok") + 3,
        },
      });
    },
  );

  it("omits failed line triggers without losing later triggers", () => {
    const dialect: Dialect = {
      id: "line",
      name: "Fixture",
      table: {
        lineTriggers: [
          {
            id: "line",
            chars: "!",
            match: "![a-z]+",
            standIn: "keep",
            node: { call: "line" },
          },
        ],
      },
      lowerTrigger(_id, text, _span, ctx) {
        if (text === "!bad")
          return ctx.fail("bad line", { code: "FIXTURE_LINE" });
        return ctx.child("good", []);
      },
    };
    const source = "!bad\n!ok\n<tail/>";
    const result = validPartial(source, { dialect });
    expect(names(result)).toEqual(["good", "tail"]);
    expect(result.ir!.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: { trigger: { id: "line", text: "!ok" } },
    });
  });

  it("omits only the tag whose own analyze failed", () => {
    const source = "<before/><checked/><checked/><after/>";
    const options: LowerSourceOptions = {
      customTags: {
        checked: {
          analyze(calls, ctx) {
            expect(calls).toHaveLength(2);
            throw ctx.fail("whole-file check", { code: "FIXTURE_ANALYZE" });
          },
        },
      },
    };
    const result = validPartial(source, options);
    expect(names(result)).toEqual(["before", "after"]);
    expect(result.diagnostics[0]).toMatchObject({
      code: "FIXTURE_ANALYZE",
      offset: source.indexOf("<checked"),
    });
    expect(messages(result)).toEqual(
      messages(lowerSource(source, FILE, options)),
    );
  });

  it.each([false, true])(
    "rolls back declarations from failed analyze (earlier declaration: %s)",
    (earlier) => {
      let declared: string[] | undefined;
      const source = `${earlier ? "<ahead/>" : ""}<checked/><healthy/><tail/>`;
      const result = validPartial(source, {
        dialect: {
          ...atomFixture,
          afterLower(unit) {
            declared = unit.declared.map((entry) => entry.name);
          },
        },
        customTags: {
          ahead: {
            analyze([call], ctx) {
              if (!call?.span) throw new Error("missing ahead span");
              ctx.declare("value", "earlier", { span: call.span });
            },
          },
          checked: {
            analyze([call], ctx) {
              if (!call?.span) throw new Error("missing checked span");
              ctx.declare("value", "leaked", { span: call.span });
              ctx.fail("analyze failed", { code: "FIXTURE_ANALYZE" });
            },
          },
          healthy: {
            analyze([call], ctx) {
              if (!call?.span) throw new Error("missing healthy span");
              ctx.declare("value", "kept", { span: call.span });
            },
          },
        },
      });
      expect(names(result)).toEqual([
        ...(earlier ? ["ahead"] : []),
        "healthy",
        "tail",
      ]);
      expect(result.diagnostics.map((d) => d.code)).toEqual([
        "FIXTURE_ANALYZE",
      ]);
      expect(declared).toEqual([...(earlier ? ["earlier"] : []), "kept"]);
    },
  );

  it("skips transforms and finalizers whose own analyze failed, not other tags", () => {
    const calls: string[] = [];
    const customTags: Record<string, CustomTag> = {
      checked: {
        analyze(_calls, ctx) {
          calls.push("checked.analyze");
          throw ctx.fail("analyze failed", { code: "PROBE_AN" });
        },
        transform(_call, ctx) {
          calls.push("checked.transform");
          if (!ctx.store.get("ready"))
            throw ctx.fail("store was not analyzed", { code: "PROBE_STORE" });
          return [];
        },
        finalize() {
          calls.push("checked.finalize");
          return [];
        },
      },
      healthy: {
        analyze(_calls, ctx) {
          calls.push("healthy.analyze");
          ctx.store.set("ready", true);
        },
        transform(_call, ctx) {
          calls.push("healthy.transform");
          if (!ctx.store.get("ready"))
            throw ctx.fail("store was not analyzed", { code: "PROBE_STORE" });
          return [];
        },
        finalize() {
          calls.push("healthy.finalize");
          return [];
        },
      },
    };
    const source = "<before/><checked/><checked/><healthy/><after/>";
    const plain = lowerSource(source, FILE, { customTags });
    expect(plain.ir).toBeUndefined();
    expect(plain).not.toHaveProperty("partial");
    expect(plain.diagnostics.map((d) => d.code)).toEqual(["PROBE_AN"]);
    expect(calls).toEqual(["checked.analyze"]);
    calls.length = 0;
    const result = validPartial(source, { customTags });
    // Successful transforms may emit nothing; the authored siblings keep spans.
    expect(names(result)).toEqual(["before", "after"]);
    expect(result.diagnostics).toEqual(plain.diagnostics);
    expect(calls).toEqual([
      "checked.analyze",
      "healthy.analyze",
      "healthy.transform",
      "healthy.finalize",
    ]);
    for (const text of contractDocs())
      expect(text).toMatch(/own `analyze` fails is omitted/);
  });

  it.each([false, true])(
    "skips an analyze-failed tag inside template units (nested: %s)",
    (nested) => {
      resetTemplateCache();
      const calls: string[] = [];
      const unitName = nested ? "outer" : "card";
      const card: TemplateBackedTag = {
        template: {
          filename: `/partial/tags/${unitName}.mx`,
          source: nested ? "<inner/>" : "<checked/>",
        },
      };
      const customTags: Record<string, CustomTag> = {
        [unitName]: card,
        ...(nested
          ? {
              inner: {
                template: {
                  filename: "/partial/tags/inner.mx",
                  source: "<checked/>",
                },
              } as TemplateBackedTag,
            }
          : {}),
        checked: {
          analyze(_calls, ctx) {
            calls.push("checked.analyze");
            ctx.fail("analyze failed", { code: "FIXTURE_ANALYZE" });
          },
          transform() {
            calls.push("checked.transform");
            throw new Error("store not analyzed");
          },
          finalize() {
            calls.push("checked.finalize");
            return [];
          },
        },
      };
      const source = `<checked/><${unitName}/><tail/>`;
      const plain = lowerSource(source, FILE, { customTags });
      expect(plain.ir).toBeUndefined();
      expect(calls).toEqual(["checked.analyze"]);
      calls.length = 0;
      const result = lowerSource(source, FILE, { customTags, partial: true });
      expect(result.diagnostics).toEqual(
        expect.arrayContaining(plain.diagnostics),
      );
      expect(result.partial).toBe(true);
      expect(names(result)).toEqual(["tail"]);
      // Recovery reaches the entry's ordinary template-call rejection, not a
      // cascade from invoking checked.transform against an unanalyzed store.
      expect(result.diagnostics.map((d) => d.code)).toEqual([
        "FIXTURE_ANALYZE",
        "MX_NOT_IN_DATA_FILE",
      ]);
      expect(calls).toEqual(["checked.analyze"]);
      expect(templateCompileCount()).toBe(nested ? 2 : 1);
      expect(peekTemplateMetadata(card.template.filename)).toBeUndefined();
      if (nested)
        expect(peekTemplateMetadata("/partial/tags/inner.mx")).toBeUndefined();
    },
  );

  it("keeps a default compile identical to a fresh process after recovered metadata", () => {
    resetTemplateCache();
    const filename = "/partial/tags/cache-probe.mx";
    const templateSource = "<checked>${input.content}</checked>";
    const source = "<checked/><card>hello</card>";
    const calls: string[] = [];
    let failAnalyze = true;
    const customTags: Record<string, CustomTag> = {
      card: {
        template: { filename, source: templateSource },
      } as TemplateBackedTag,
      checked: {
        analyze(_calls, ctx) {
          calls.push("analyze");
          if (failAnalyze) {
            failAnalyze = false;
            ctx.fail("first analyze fails", { code: "FIXTURE_ANALYZE" });
          }
        },
        transform(call) {
          calls.push("transform");
          return call.content?.children ?? [];
        },
        finalize() {
          calls.push("finalize");
          return [];
        },
      },
    };
    const recovered = lowerSource(source, FILE, { customTags, partial: true });
    expect(recovered.partial).toBe(true);
    expect(recovered.diagnostics.map((d) => d.code)).toContain(
      "FIXTURE_ANALYZE",
    );
    expect(calls).toEqual(["analyze"]);
    expect(templateCompileCount()).toBe(1);
    calls.length = 0;
    const warnings: MxWarning[] = [];
    const result = lowerSource(source, FILE, { customTags, warnings });
    const fresh = spawnSync(
      "bun",
      [
        "--eval",
        `
      import { lowerSource } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      const calls = [];
      const warnings = [];
      const customTags = {
        card: { template: ${JSON.stringify({ filename, source: templateSource })} },
        checked: {
          analyze() { calls.push("analyze"); },
          transform(call) { calls.push("transform"); return call.content?.children ?? []; },
          finalize() { calls.push("finalize"); return []; },
        },
      };
      const result = lowerSource(${JSON.stringify(source)}, ${JSON.stringify(FILE)}, { customTags, warnings });
      console.log(JSON.stringify({ result, calls, warnings }));
    `,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(fresh.error).toBeUndefined();
    expect(fresh.status, fresh.stderr).toBe(0);
    expect({ result, calls, warnings }).toEqual(JSON.parse(fresh.stdout));
    expect(warnings).toEqual([]);
    expect(result.diagnostics.filter((d) => d.severity === "warning")).toEqual(
      [],
    );
    expect(calls).toEqual(["analyze", "transform", "transform", "finalize"]);
    expect(templateCompileCount()).toBe(2);
    expect(peekTemplateMetadata(filename)).toMatchObject({
      readsContent: true,
    });
  }, 30_000);

  it.each([false, true])(
    "keeps nested metadata independent of outer recovery (partial: %s)",
    (partial) => {
      resetTemplateCache();
      const filename = "/partial/tags/nested-cache-probe.mx";
      const source = `${partial ? "<checked/>" : ""}<card>hello</card>`;
      const calls: string[] = [];
      let failAnalyze = false;
      let runNested = false;
      let nested: ReturnType<typeof compileNested> | undefined;
      const customTags: Record<string, CustomTag> = {
        card: {
          template: {
            filename,
            source: "<checked>${input.content}</checked>",
          },
        } as TemplateBackedTag,
        checked: {
          analyze(_calls, ctx) {
            calls.push("analyze");
            if (failAnalyze) {
              failAnalyze = false;
              ctx.fail("first analyze fails", { code: "FIXTURE_ANALYZE" });
            }
          },
          transform(call) {
            calls.push("transform");
            return call.content?.children ?? [];
          },
        },
        probe: {
          transform() {
            // Completed reduced facts never enter the shared cache.
            expect(peekTemplateMetadata(filename)).toBeUndefined();
            if (runNested) nested = compileNested();
            return [];
          },
        },
      };
      function compileNested() {
        const warnings: MxWarning[] = [];
        const before = calls.length;
        const result = lowerSource(source, "/other.mx", {
          customTags,
          ...(partial ? { partial: true } : {}),
          warnings,
        });
        return { result, warnings, calls: calls.slice(before) };
      }
      const cold = compileNested();
      expect(cold.warnings).toEqual([]);
      expect(cold.calls).toEqual(
        partial ? ["analyze", "transform", "transform"] : ["transform"],
      );
      expect(templateCompileCount()).toBe(1);
      function compileOuter() {
        resetTemplateCache();
        calls.length = 0;
        failAnalyze = true;
        const warnings: MxWarning[] = [];
        const result = lowerSource(
          "<checked/><card>hello</card><probe/><card>hello</card>",
          FILE,
          { customTags, partial: true, warnings },
        );
        return { result, warnings };
      }
      const control = compileOuter();
      expect(templateCompileCount()).toBe(1);
      expect(control.warnings.map((warning) => warning.code)).toEqual([
        "MX_BODY_DROPPED",
        "MX_BODY_DROPPED",
      ]);
      runNested = true;
      const recovered = compileOuter();
      // A clean shared replacement must not change the outer scope's facts.
      expect(recovered).toEqual(control);
      expect(recovered.result.partial).toBe(true);
      expect(recovered.result.diagnostics.map((d) => d.code)).toEqual([
        "FIXTURE_ANALYZE",
        "MX_NOT_IN_DATA_FILE",
        "MX_NOT_IN_DATA_FILE",
      ]);
      expect(nested).toEqual(cold);
      expect(calls).toEqual(["analyze", ...cold.calls]);
      expect(templateCompileCount()).toBe(2);
      // The outer scope must not evict a replacement compiled independently.
      expect(peekTemplateMetadata(filename)).toMatchObject({
        readsContent: true,
      });
    },
  );

  it.each(["nested default", "warm default"] as const)(
    "ignores completed shared metadata before the first recovered call (%s)",
    (order) => {
      function compile(cacheOrder: "cold" | typeof order) {
        resetTemplateCache();
        const filename = "/partial/tags/early-cache-probe.mx";
        const outerCalls: string[] = [];
        let activeCalls = outerCalls;
        let failAnalyze = false;
        let independent: ReturnType<typeof compileDefault> | undefined;
        const customTags: Record<string, CustomTag> = {
          card: {
            template: {
              filename,
              source: "<checked>${input.content}</checked>",
            },
          } as TemplateBackedTag,
          checked: {
            analyze(_calls, ctx) {
              activeCalls.push("analyze");
              if (failAnalyze) {
                failAnalyze = false;
                ctx.fail("first analyze fails", { code: "FIXTURE_ANALYZE" });
              }
            },
            transform(call) {
              activeCalls.push("transform");
              return call.content?.children ?? [];
            },
          },
          probe: {
            transform() {
              if (cacheOrder === "nested default")
                independent = compileDefault();
              return [];
            },
          },
        };
        function compileDefault() {
          const calls: string[] = [];
          const warnings: MxWarning[] = [];
          const before = templateCompileCount();
          activeCalls = calls;
          try {
            const result = lowerSource(
              "<card>hello</card>",
              "/independent.mx",
              {
                customTags,
                warnings,
              },
            );
            return {
              result,
              warnings,
              calls,
              compiles: templateCompileCount() - before,
            };
          } finally {
            activeCalls = outerCalls;
          }
        }
        const clean = compileDefault();
        expect(peekTemplateMetadata(filename)).toMatchObject({
          readsContent: true,
        });
        resetTemplateCache();
        if (cacheOrder === "warm default") independent = compileDefault();
        failAnalyze = true;
        const warnings: MxWarning[] = [];
        const before = templateCompileCount();
        const result = lowerSource(
          "<checked/><probe/><card>hello</card>",
          FILE,
          { customTags, partial: true, warnings },
        );
        const compiles =
          templateCompileCount() -
          before -
          (cacheOrder === "nested default" ? independent!.compiles : 0);
        return {
          outer: { result, warnings, calls: outerCalls, compiles },
          independent,
          clean,
        };
      }
      const cold = compile("cold");
      expect(cold.outer.warnings.map((warning) => warning.code)).toEqual([
        "MX_BODY_DROPPED",
      ]);
      expect(cold.outer.calls).toEqual(["analyze"]);
      expect(cold.outer.compiles).toBe(1);
      expect(cold.outer.result.partial).toBe(true);
      expect(cold.outer.result.diagnostics.map((d) => d.code)).toEqual([
        "FIXTURE_ANALYZE",
        "MX_NOT_IN_DATA_FILE",
      ]);
      expect(cold.clean.warnings).toEqual([]);
      expect(cold.clean.calls).toEqual(["transform"]);
      expect(cold.clean.compiles).toBe(1);
      const recovered = compile(order);
      expect(recovered.outer).toEqual(cold.outer);
      expect(recovered.independent).toEqual(cold.clean);
      expect(recovered.clean).toEqual(cold.clean);
    },
  );

  it.each([false, true])(
    "preserves an independent replacement of pending metadata (throws: %s)",
    (throws) => {
      resetTemplateCache();
      const filename = "/partial/tags/replaced-pending.mx";
      let nested: LowerSourceResult | undefined;
      const customTags: Record<string, CustomTag> = {
        card: {
          template: { filename, source: "<probe/>" },
        } as TemplateBackedTag,
        checked: {
          analyze(_calls, ctx) {
            ctx.fail("analyze fails", { code: "FIXTURE_ANALYZE" });
          },
        },
        probe: {
          transform(_call, ctx) {
            expect(peekTemplateMetadata(filename)?.pending).toBe(true);
            nested = lowerSource("<card>hi</card>", "/independent.mx", {
              customTags: {
                card: {
                  // A new snapshot must replace the pending old snapshot.
                  template: { filename, source: "${input.content}" },
                } as TemplateBackedTag,
              },
              warnings: [],
            });
            if (throws)
              ctx.fail("metadata fails", { code: "FIXTURE_METADATA" });
            return [];
          },
        },
      };
      const result = lowerSource("<checked/><card/>", FILE, {
        customTags,
        partial: true,
        warnings: [],
      });
      expect(nested?.diagnostics.map((d) => d.code)).toEqual([
        "MX_NOT_IN_DATA_FILE",
      ]);
      expect(result.diagnostics.map((d) => d.code)).toEqual([
        "FIXTURE_ANALYZE",
        throws ? "FIXTURE_METADATA" : "MX_NOT_IN_DATA_FILE",
      ]);
      expect(templateCompileCount()).toBe(2);
      expect(peekTemplateMetadata(filename)).toMatchObject({
        readsContent: true,
      });
      expect(peekTemplateMetadata(filename)).not.toHaveProperty("pending");
    },
  );

  it.each(["default", "clean partial", "recovered partial"])(
    "shares pending metadata across reentrant recovery scopes (%s)",
    (mode) => {
      resetTemplateCache();
      let depth = 0;
      let maxDepth = 0;
      let capHits = 0;
      const nested: LowerSourceResult[] = [];
      const filename = "/partial/tags/reentrant-card.mx";
      const customTags: Record<string, CustomTag> = {
        card: {
          template: { filename, source: "<probe/>${input.content}" },
        } as TemplateBackedTag,
        checked: {
          analyze(_calls, ctx) {
            ctx.fail("analyze fails", { code: "FIXTURE_ANALYZE" });
          },
        },
        probe: {
          transform() {
            depth++;
            maxDepth = Math.max(maxDepth, depth);
            try {
              // Bound a broken implementation without overflowing the stack.
              if (depth > 4) capHits++;
              else
                nested.push(
                  lowerSource("<checked/><card>hi</card>", "/nested.mx", {
                    customTags,
                    partial: true,
                    warnings: [],
                  }),
                );
            } finally {
              depth--;
            }
            return [];
          },
        },
      };
      const result = lowerSource(
        `${mode === "recovered partial" ? "<checked/>" : ""}<card>hi</card>`,
        FILE,
        { customTags, partial: mode !== "default", warnings: [] },
      );
      expect(capHits).toBe(0);
      expect(maxDepth).toBe(1);
      expect(depth).toBe(0);
      expect(templateCompileCount()).toBe(1);
      expect(nested).toHaveLength(1);
      expect(nested[0]?.partial).toBe(true);
      expect(nested[0]?.diagnostics.map((d) => d.code)).toEqual([
        "FIXTURE_ANALYZE",
        "MX_NOT_IN_DATA_FILE",
      ]);
      expect(result.diagnostics.map((d) => d.code)).toEqual([
        ...(mode === "recovered partial" ? ["FIXTURE_ANALYZE"] : []),
        "MX_NOT_IN_DATA_FILE",
      ]);
      if (mode === "recovered partial")
        expect(peekTemplateMetadata(filename)).toBeUndefined();
      else
        expect(peekTemplateMetadata(filename)).toMatchObject({
          readsContent: true,
        });
    },
  );

  it.each(["default", "clean partial", "recovered partial"])(
    "keeps metadata stores independent (%s)",
    (mode) => {
      const partial = mode !== "default";
      const recovered = mode === "recovered partial";
      const stores: unknown[] = [];
      const readiness: unknown[] = [];
      const card: TemplateBackedTag = {
        template: {
          filename: `/partial/tags/independent-${mode}.mx`,
          source: "<probe/>",
        },
      };
      const result = lowerSource(
        `${recovered ? "<failed/>" : ""}<probe/><card/><tail/>`,
        FILE,
        {
          partial,
          customTags: {
            card,
            failed: {
              analyze(_calls, ctx) {
                ctx.fail("analyze failed", { code: "FIXTURE_ANALYZE" });
              },
            },
            probe: {
              analyze(_calls, ctx) {
                ctx.store.set("ready", true);
              },
              transform(_call, ctx) {
                stores.push(ctx.store);
                readiness.push(ctx.store.get("ready"));
                return [];
              },
            },
          },
        },
      );
      if (recovered) {
        expect(result.partial).toBe(true);
        expect(result.diagnostics.map((d) => d.code)).toEqual([
          "FIXTURE_ANALYZE",
          "MX_NOT_IN_DATA_FILE",
        ]);
      }
      expect(readiness).toEqual([true, undefined]);
      expect(stores).toHaveLength(2);
      expect(stores[0]).not.toBe(stores[1]);
    },
  );

  it("retains declarations from successful analyze when its transform fails", () => {
    let declared: string[] | undefined;
    const result = validPartial("<checked/><tail/>", {
      dialect: {
        ...atomFixture,
        afterLower(unit) {
          declared = unit.declared.map((entry) => entry.name);
        },
      },
      customTags: {
        checked: {
          analyze([call], ctx) {
            if (!call?.span) throw new Error("missing checked span");
            ctx.declare("value", "kept", { span: call.span });
          },
          transform(_call, ctx) {
            throw ctx.fail("transform failed", { code: "FIXTURE_TRANSFORM" });
          },
        },
      },
    });
    expect(names(result)).toEqual(["tail"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "FIXTURE_TRANSFORM",
    ]);
    expect(declared).toEqual(["kept"]);
  });

  it("retains scratch diagnostics below an analyze-failed tag", () => {
    const source = "<checked><if/></checked><tail/>";
    const options: LowerSourceOptions = {
      customTags: {
        checked: {
          analyze(_calls, ctx) {
            ctx.fail("analyze failed", { code: "PROBE_AN" });
          },
        },
      },
    };
    const plain = lowerSource(source, FILE, options);
    expect(plain.diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_IF"]);
    const result = validPartial(source, options);
    expect(names(result)).toEqual(["tail"]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining(plain.diagnostics),
    );
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "MX_INVALID_IF",
      "PROBE_AN",
    ]);
  });

  it("does not roll back hook-private stores after an omitted transform", () => {
    let finalized: string[] = [];
    const result = validPartial("<checked/><checked bad/><tail/>", {
      customTags: {
        checked: {
          attributes: { bad: { type: "boolean" } },
          transform(call, ctx) {
            const bad = call.attrs.some(
              (attr) => attr.kind !== "spread" && attr.name === "bad",
            );
            ctx.store.set(bad ? "bad" : "good", true);
            if (bad) throw ctx.fail("bad call", { code: "FIXTURE_STORE" });
            return [];
          },
          finalize(ctx) {
            finalized = ["good", "bad"].filter((name) => ctx.store.get(name));
            return [];
          },
        },
      },
    });
    expect(names(result)).toEqual(["tail"]);
    expect(finalized).toEqual(["good", "bad"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["FIXTURE_STORE"]);
    for (const text of contractDocs())
      expect(text).toContain("Hook-private stores are not rolled back");
  });

  it("a clean opt-in call preserves every hook call count and result", () => {
    const calls: string[] = [];
    const customTags: Record<string, CustomTag> = {
      checked: {
        analyze(tagCalls, ctx) {
          calls.push(`analyze:${tagCalls.length}`);
          ctx.store.set("ready", true);
        },
        transform(_call, ctx) {
          expect(ctx.store.get("ready")).toBe(true);
          calls.push("transform");
          return [];
        },
        finalize() {
          calls.push("checked.finalize");
          return [];
        },
      },
      // Registration and authored order differ from the finalizers' name order.
      ahead: {
        transform() {
          calls.push("ahead.transform");
          return [];
        },
        finalize() {
          calls.push("ahead.finalize");
          return [];
        },
      },
    };
    const dialect: Dialect = {
      ...atomFixture,
      afterLower() {
        calls.push("afterLower");
      },
    };
    const source = "<checked/><ahead/><checked/><tail/>";
    const plain = lowerSource(source, FILE, { customTags, dialect });
    expect(plain.diagnostics).toEqual([]);
    expect(calls).toEqual([
      "analyze:2",
      "transform",
      "ahead.transform",
      "transform",
      "afterLower",
      "ahead.finalize",
      "checked.finalize",
    ]);
    calls.length = 0;
    const result = lowerSource(source, FILE, {
      customTags,
      dialect,
      partial: true,
    });
    expect(result).toEqual(plain);
    expect(result).not.toHaveProperty("partial");
    expect(calls).toEqual([
      "analyze:2",
      "transform",
      "ahead.transform",
      "transform",
      "afterLower",
      "ahead.finalize",
      "checked.finalize",
    ]);
  });

  it("keeps the tree beside an afterLower failure", () => {
    const source = "<before/><after/>";
    const result = validPartial(source, {
      dialect: {
        ...atomFixture,
        afterLower(unit) {
          unit.fail("unit check", { code: "FIXTURE_UNIT" });
        },
      },
    });
    expect(names(result)).toEqual(["before", "after"]);
    expect(result.diagnostics[0]?.code).toBe("FIXTURE_UNIT");
  });

  it("collects independent whole-file hook failures without discarding the tree", () => {
    const result = validPartial("<a/><b/><tail/>", {
      dialect: {
        ...atomFixture,
        afterLower(unit) {
          unit.fail("unit", { code: "FIXTURE_UNIT" });
        },
      },
      customTags: {
        a: {
          analyze(_calls, ctx) {
            throw ctx.fail("a", { code: "FIXTURE_A" });
          },
        },
        b: {
          analyze(_calls, ctx) {
            throw ctx.fail("b", { code: "FIXTURE_B" });
          },
        },
      },
    });
    expect(names(result)).toEqual(["tail"]);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "FIXTURE_A",
      "FIXTURE_B",
      "FIXTURE_UNIT",
    ]);
  });

  it("retains the lowered body when a finalizer fails", () => {
    const result = validPartial("<checked/><tail/>", {
      customTags: {
        checked: {
          analyze() {},
          finalize() {
            throw new Error("failed finalizer");
          },
        },
      },
    });
    expect(names(result)).toEqual(["checked", "tail"]);
    expect(result.diagnostics[0]?.code).toBe("MX_TAG_HOOK_ERROR");
    expect(messages(result)[0]).toContain("failed finalizer");
  });

  it("omits a transform failure as one tag, not its surrounding siblings", () => {
    const result = validPartial("<root><before/><bad/><after/></root>", {
      customTags: {
        bad: {
          transform(_call, ctx) {
            throw ctx.fail("transform", { code: "FIXTURE_TRANSFORM" });
          },
        },
      },
    });
    expect(names(result)).toEqual(["root", "before", "after"]);
    expect(result.diagnostics[0]?.code).toBe("FIXTURE_TRANSFORM");
  });

  it("analyzes surviving scratch calls before analyze-dependent transforms", () => {
    let analyzed = 0;
    let transformed = 0;
    const customTags: Record<string, CustomTag> = {
      checked: {
        analyze(calls, ctx) {
          analyzed++;
          expect(calls).toHaveLength(1);
          ctx.store.set("ready", true);
        },
        transform(_call, ctx) {
          if (!ctx.store.get("ready"))
            throw ctx.fail("store was not analyzed", { code: "PROBE_STORE" });
          transformed++;
          return [];
        },
      },
    };
    const source = "<root><if/><checked/></root><after/>";
    const result = validPartial(source, { customTags });
    expect(analyzed).toBe(1);
    expect(transformed).toBe(1);
    expect(names(result)).toEqual(["root", "after"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_IF"]);
    expect(
      lowerSource(source, FILE, { customTags }).diagnostics.map((d) => d.code),
    ).toEqual(["MX_INVALID_IF"]);
    expect(analyzed).toBe(1); // Default still stops before analyze.
  });

  it("does not analyze calls inside a failed scratch owner", () => {
    let analyzed = 0;
    const result = validPartial(
      '<bad n="wrong"><checked/></bad><checked/><after/>',
      {
        customTags: {
          bad: { attributes: { n: { type: "number" } } },
          checked: {
            analyze(calls) {
              analyzed++;
              expect(calls).toHaveLength(1);
            },
          },
        },
      },
    );
    expect(analyzed).toBe(1);
    expect(names(result)).toEqual(["checked", "after"]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("does not finalize a tag whose only call failed", () => {
    let finalized = 0;
    const result = validPartial("<bad/><after/>", {
      customTags: {
        bad: {
          analyze() {},
          transform(_call, ctx) {
            throw ctx.fail("bad call", { code: "FIXTURE_CALL" });
          },
          finalize() {
            finalized++;
            return [];
          },
        },
      },
    });
    expect(names(result)).toEqual(["after"]);
    expect(finalized).toBe(0);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["FIXTURE_CALL"]);
  });

  it.each([
    ["<script>let x = ;</script><after/>", "MX_INVALID_STATEMENT"],
    ['<script src="x.js"/><after/>', "MX_INERT_TAG_SHAPE"],
    [
      "<let/items=[]/><const/total=items.length/><script>items = []; log(total);</script><after/>",
      "MX_STALE_DERIVED_READ",
    ],
  ])("omits the owner of a recording-only check in %s", (source, code) => {
    const result = validPartial(source);
    expect(names(result)).toEqual(["after"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      code === "MX_STALE_DERIVED_READ" ? ["MX_NOT_IN_DATA_FILE", code] : [code],
    );
    expect(messages(result)).toEqual(
      expect.arrayContaining(messages(lowerSource(source, FILE))),
    );
  });

  it("rolls back failed subtree hoists without losing earlier hoists", () => {
    let childFinalized = 0;
    const result = validPartial("<good/><bad><child/></bad><after/>", {
      customTags: {
        good: {
          transform(_call, ctx) {
            ctx.hoist("const kept = 1;");
            return [];
          },
        },
        child: {
          transform(_call, ctx) {
            ctx.hoist("const childLeak = 1;");
            return [];
          },
          finalize() {
            childFinalized++;
            return [];
          },
        },
        bad: {
          transform(_call, ctx) {
            ctx.hoist("const leaked = 1;");
            throw ctx.fail("omit owner", { code: "FIXTURE_HOIST" });
          },
        },
      },
    });
    expect(names(result)).toEqual(["after"]);
    expect(result.ir?.prelude.map((node) => node.code)).toEqual([
      "const kept = 1;",
    ]);
    expect(childFinalized).toBe(0);
  });

  it("partial diagnostics include errors the default stops before", () => {
    const source = "<root><if=true><x/></if><if/></root>";
    const plain = lowerSource(source, FILE, { structural: "reject" });
    const result = validPartial(source, { structural: "reject" });
    expect(plain.diagnostics).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining(plain.diagnostics),
    );
    expect(names(result)).toEqual(["root"]);
    for (const text of contractDocs())
      expect(text).toMatch(
        /errors the default stops before are\s+also reported/,
      );
  });

  it("scopes failed trigger children to one partial root, not the AST", () => {
    const dialect: Dialect = {
      ...atomFixture,
      nodeTypes: {
        ...atomFixture.nodeTypes,
        Atom: {
          ...atomFixture.nodeTypes!.Atom!,
          lower(_node, ctx) {
            return ctx.fail("bad atom", { code: "FIXTURE_SCOPE" });
          },
        },
      },
    };
    const source = "<bad x=~bad/><after/>";
    const { body } = parseFragment(source, { filename: FILE, dialect });
    const declarations = {
      tags: {},
      isElement: () => true,
      isComponent: () => false,
    };
    const ctx = newCtx(
      source,
      () => "",
      declarations,
      undefined,
      FILE,
      targets,
    );
    ctx.errors = [];
    withPartialIr(
      declarations,
      () => {},
      () => {
        beginPartialIr(ctx);
        lowerTriggers(ctx, body);
        expect(childrenWithTriggers(body)).toEqual([body[1]]);
        expect(ctx.errors).toHaveLength(1);
      },
    );
    expect(childrenWithTriggers(body)).toEqual(body);
    const plain = newCtx(
      source,
      () => "",
      declarations,
      undefined,
      FILE,
      targets,
    );
    expect(() => lowerChildren(plain, body)).toThrow("bad atom");
  });

  it("reserved-name refusals return no tree even after partial recovery", () => {
    const result = lowerSource("<root><if/><after/></root>", FILE, {
      partial: true,
      customTags: { if: {} },
    });
    expect(result.ir).toBeUndefined();
    expect(result).not.toHaveProperty("partial");
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "MX_INVALID_IF",
      "MX_RESERVED_TAG",
    ]);
    for (const text of contractDocs()) expect(text).toContain("reserved-name");
  });

  it("keeps a nested non-partial entry independent and restores the outer scope", () => {
    const result = validPartial("<checked/><if/><tail/>", {
      customTags: {
        checked: {
          analyze() {
            const inner = lowerSource("<if/><inner/>", "/nested-default.mx");
            expect(inner.ir).toBeUndefined();
            expect(inner).not.toHaveProperty("partial");
            expect(inner.diagnostics.map((d) => d.code)).toEqual([
              "MX_INVALID_IF",
            ]);
          },
        },
      },
    });
    expect(names(result)).toEqual(["checked", "tail"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_IF"]);
  });

  it("an empty recovered body is still a partial IR", () => {
    expect(validPartial("<if/>").ir?.body).toEqual([]);
  });

  it.each([
    [
      "<root><unknown/><known/></root>",
      { unknownTags: "reject", customTags: { root: {}, known: {} } },
      ["root", "known"],
    ],
    [
      "<root><if=true><gone/></if><known/></root>",
      { structural: "reject" },
      ["root", "known"],
    ],
    ["<root><bad/v/><known/></root>", {}, ["root", "known"]],
    ['<root><bad.a class="b"/><known/></root>', {}, ["root", "known"]],
    ["<!doctype html><known/>", {}, ["known"]],
    ['import x from "x"\n<known/>', { imports: "reject" }, ["known"]],
  ] as [string, LowerSourceOptions, string[]][])(
    "omits entry-check rejects in %s",
    (source, options, kept) => {
      expect(names(validPartial(source, options))).toEqual(kept);
    },
  );

  it("reports independent lowering and unknown-tag errors once, positioned", () => {
    const source = "<root><if/><unknown/><bad n=1/><known/></root>";
    const result = validPartial(source, {
      unknownTags: "reject",
      customTags: { root: {}, known: {}, bad: { attributes: {} } },
    });
    expect(names(result)).toEqual(["root", "known"]);
    const keys = result.diagnostics.map(
      (d) => `${d.offset}:${d.code}:${d.message}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.diagnostics).toHaveLength(3);
  });

  it.each(["", "<if/>"])(
    "keeps unexplained unknown tags in allow mode beside %s",
    (failure) => {
      const source = `<root><bad/><good/>${failure}</root>`;
      const result = validPartial(source, {
        dialect: {
          ...atomFixture,
          explainUnknownTag(tag) {
            return tag.name === "bad"
              ? {
                  message: "bad vocabulary",
                  code: "FIXTURE_UNKNOWN",
                  at: tag.nameSpan,
                }
              : undefined;
          },
        },
      });
      expect(names(result)).toEqual(["root", "good"]);
      expect(
        result.diagnostics.filter((d) => d.code === "FIXTURE_UNKNOWN"),
      ).toHaveLength(1);
      expect(result.diagnostics).toHaveLength(failure ? 2 : 1);
    },
  );

  it("drops generated component imports from a recovered spanned tree", () => {
    const badge: TemplateBackedTag = {
      template: { filename: "/partial/tags/badge.mx", source: "<inner/>" },
    };
    const result = validPartial("<before/><badge/><after/>", {
      customTags: { badge },
    });
    expect(names(result)).toEqual(["before", "after"]);
    expect(result.ir?.imports).toEqual([]);
  });

  it("a clean opt-in call has exactly the default shape and contents", () => {
    const source = "<root a=~ok><child b=1/></root>";
    const options = { dialect: atomFixture };
    const result = lowerSource(source, FILE, { ...options, partial: true });
    expect(result).toEqual(lowerSource(source, FILE, options));
    expect(result).not.toHaveProperty("partial");
    expect(result.diagnostics).toEqual([]);
  });

  it("uses the same private recovery under the none preset", () => {
    const result = validPartial('<root><bad n="wrong"/><after/></root>', {
      tagRules: "none",
      customTags: { bad: { attributes: { n: { type: "number" } } } },
    });
    expect(names(result)).toEqual(["root", "after"]);
  });

  it("restores the outer recovery scope after a nested entry call", () => {
    const result = validPartial("<checked/><tail/>", {
      customTags: {
        checked: {
          analyze(_calls, ctx) {
            const inner = lowerSource("<if/><inner/>", "/nested.mx", {
              partial: true,
            });
            expect(inner.partial).toBe(true);
            expect(names(inner)).toEqual(["inner"]);
            throw ctx.fail("outer", { code: "FIXTURE_OUTER" });
          },
        },
      },
    });
    expect(names(result)).toEqual(["tail"]);
    expect(result.diagnostics[0]?.code).toBe("FIXTURE_OUTER");
    const plain = lowerSource("<if/><after/>", FILE);
    expect(plain.ir).toBeUndefined();
    expect(plain).not.toHaveProperty("partial");
  });

  it("does not promise partial IR when parsing or registration produced no tree", () => {
    for (const [source, options] of [
      ["<x>", {}],
      ["<x/>", { dialect: { id: "bad", table: { tagShorthands: "bad" } } }],
    ] as [string, LowerSourceOptions][]) {
      const result = lowerSource(source, FILE, { ...options, partial: true });
      expect(result.ir).toBeUndefined();
      expect(result).not.toHaveProperty("partial");
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("lowerFile has parity; unreadable files still throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-partial-"));
    try {
      const file = join(dir, "page.mx");
      const source = "<before/><if/><after/>";
      writeFileSync(file, source);
      expect(lowerFile(file, { partial: true })).toEqual(
        lowerSource(source, file, { partial: true }),
      );
      expect(lowerFile(file).ir).toBeUndefined();
      expect(() =>
        lowerFile(join(dir, "missing.mx"), { partial: true }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
