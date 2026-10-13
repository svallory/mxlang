// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
/**
 * A `<define>` is in scope only inside the body that declares it, as in Marko
 * 6.4.4 (the lead's stock probe, 2026-10-13): a `<define/Foo>` inside an
 * `<if>`, a `<for>`, an element or a component body binds `Foo` there and
 * nowhere after it. Before this, the name stayed in `ctx.defines` for the rest
 * of the file, so a later `<Foo/>` outside the block called the define even
 * when `Foo` was an import (the define was never in scope there), and with no
 * import it compiled instead of reporting an unresolved tag.
 */
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
import { tagTable } from "./tag-table.ts";
import { lookup as targets } from "./test-targets.ts";

const bare = () => ({ taglibs: [], tagDiscoveryDirs: [], translate: {} });

/** What a host's `isComponent` answers: a name the file binds. */
const policy = (): Policy => ({
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  resolveDefaultTag: () => "input",
});

function lowerSource(source: string) {
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
}

interface Call {
  /** `define` when the call reaches a `<define>`, else the target's own kind. */
  kind: string;
  params?: string[];
}

/** Every component call in source order, whatever it is nested in. */
function callsOf(nodes: readonly IrNode[], out: Call[] = []): Call[] {
  for (const node of nodes) {
    if (node.kind === "Component") {
      const target = node.target as { kind: string; params?: string[] };
      out.push({
        kind: target.kind,
        ...(target.params ? { params: target.params } : {}),
      });
    }
    walk(node, out);
  }
  return out;
}

function walk(node: unknown, out: Call[]): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of ["children", "branches", "content", "else"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "kind" in item) {
          callsOf([item as IrNode], out);
        } else {
          walk(item, out);
        }
      }
    } else if (value && typeof value === "object") {
      walk(value, out);
    }
  }
}

const IMPORT = 'import Foo from "./foo.js"\n';
const FOO = "<define/Foo><p>inner</p></define>";

/** The one call `source` makes after the block, in source order. */
function lastCall(source: string): Call {
  const calls = callsOf(lowerSource(source).body);
  const last = calls.at(-1);
  if (!last) throw new Error("no component call lowered");
  return last;
}

describe("a <define> is scoped to the body that declares it", () => {
  describe("an import of the same name is called after the block", () => {
    const BLOCKS: Array<[string, string]> = [
      ["<if>", `<if=input.a>${FOO}</if>`],
      ["<else>", `<if=input.a><p>a</p></if><else>${FOO}</else>`],
      ["<else if>", `<if=input.a><p>a</p></if><else if=input.b>${FOO}</else>`],
      ["<for>", `<for|i| of=[1]>${FOO}</for>`],
      ["a native element", `<div>${FOO}</div>`],
      ["a nested native element", `<section><div>${FOO}</div></section>`],
      ["another <define>", `<define/Bar>${FOO}</define>`],
    ];
    for (const [label, block] of BLOCKS) {
      it(`${label}: the outer <Foo/> is the import, not the define`, () => {
        const call = lastCall(`${IMPORT}${block}\n<Foo/>\n`);
        // A value import of a `.js` module is a dynamic tag, never a define.
        expect(call.kind).toBe("dynamic");
      });
    }

    it("an attribute tag body", () => {
      const call = lastCall(
        `${IMPORT}<define/Box><div/></define>\n<Box><@head>${FOO}</@head></Box>\n<Foo/>\n`,
      );
      expect(call.kind).toBe("dynamic");
    });

    it("a component body", () => {
      const call = lastCall(
        `${IMPORT}<define/Box><div><${"$"}{input.content}/></div></define>\n<Box>${FOO}</Box>\n<Foo/>\n`,
      );
      expect(call.kind).toBe("dynamic");
    });

    it("a <Foo/> inside a later sibling block is the import too", () => {
      const calls = callsOf(
        lowerSource(
          `${IMPORT}<if=input.a>${FOO}</if>\n<if=input.b><Foo/></if>\n`,
        ).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["dynamic"]);
    });
  });

  describe("inside the block the define still wins over the import", () => {
    it("a call inside the <if> reaches the define; the one after reaches the import", () => {
      const calls = callsOf(
        lowerSource(`${IMPORT}<if=input.a>${FOO}<Foo/></if>\n<Foo/>\n`).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["define", "dynamic"]);
    });

    it("a call inside a nested block of the declaring one still reaches the define", () => {
      const calls = callsOf(
        lowerSource(
          `${IMPORT}<if=input.a>${FOO}<div><for|i| of=[1]><Foo/></for></div></if>\n<Foo/>\n`,
        ).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["define", "dynamic"]);
    });

    it("a call before the block is the import", () => {
      const calls = callsOf(
        lowerSource(`${IMPORT}<Foo/>\n<if=input.a>${FOO}</if>\n`).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["dynamic"]);
    });
  });

  describe("with no import the outer <Foo/> is an unresolved tag", () => {
    const BLOCKS: Array<[string, string]> = [
      ["<if>", `<if=input.a>${FOO}</if>`],
      ["<else>", `<if=input.a><p>a</p></if><else>${FOO}</else>`],
      ["<for>", `<for|i| of=[1]>${FOO}</for>`],
      ["a native element", `<div>${FOO}</div>`],
      ["another <define>", `<define/Bar>${FOO}</define>`],
    ];
    for (const [label, block] of BLOCKS) {
      it(`${label}: <Foo/> after it is reported, at the call`, () => {
        const source = `${block}\n<Foo/>\n`;
        let error: { message: string; line: number } | undefined;
        try {
          lowerSource(source);
        } catch (e) {
          error = e as { message: string; line: number };
        }
        expect(error?.message).toMatch(
          /`<Foo>` has no matching import or `<define>` in scope/,
        );
        expect(error?.line).toBe(2);
      });
    }

    it("the same block with the call inside it compiles", () => {
      expect(() =>
        lowerSource(`<if=input.a>${FOO}<Foo/></if>\n`),
      ).not.toThrow();
    });
  });

  describe("a define of the same name at the top level survives a nested one", () => {
    it("the call after the block reaches the outer define, not the inner one", () => {
      const calls = callsOf(
        lowerSource(
          "<define/Foo|a|><p>${a}</p></define>\n<if=input.x><define/Foo|b, c|><p>${b}</p></define><Foo/></if>\n<Foo/>\n",
        ).body,
      );
      expect(calls).toEqual([
        { kind: "define", params: ["b", "c"] },
        { kind: "define", params: ["a"] },
      ]);
    });

    it("two sibling blocks each bind their own, neither leaks into the other", () => {
      expect(() =>
        lowerSource(`<if=input.a>${FOO}<Foo/></if>\n<if=input.b><Foo/></if>\n`),
      ).toThrow(/`<Foo>` has no matching import or `<define>` in scope/);
    });

    it("a top-level define is visible in every later block", () => {
      const calls = callsOf(
        lowerSource(
          `${FOO}\n<if=input.a><Foo/></if>\n<div><Foo/></div>\n<Foo/>\n`,
        ).body,
      );
      expect(calls.map((c) => c.kind)).toEqual(["define", "define", "define"]);
    });
  });
});
