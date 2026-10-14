/**
 * `LowerSourceOptions.stripTypes`: by default `lowerSource` erases TypeScript
 * before lowering (the nodes a dialect's hooks see carry no annotations, and a
 * top-level `as`, `!` or `satisfies` shrinks to its operand); `false` keeps
 * the authored TypeScript in the nodes and in `Expr.code`. The option reaches
 * a dialect's `nodeType.lower` and `afterLower`, and a tag-file hook's
 * `ctx.lower`, whose memo is keyed on it. Every pass the IR goes through takes
 * a typed source the same as an untyped one.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { clearScanCache, scanCached } from "../scan-cache.ts";
import type { Dialect, Trigger } from "../syntax-table.ts";
import { clearTagFileCache } from "../tag-file.ts";
import { dialectProject } from "../test-dialect-project.ts";
import { testTargetLookup } from "../test-targets.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

const targets = testTargetLookup();

interface Typed {
  type: string;
  typeAnnotation?: unknown;
  returnType?: unknown;
  expression?: Typed;
  params?: Typed[];
}
interface Attr {
  name: string;
  value: { code: string; node: Typed };
}

const SOURCE =
  "static const y: unknown = 1;\n" +
  "<x f=((a: number): number => a) g=(y as string) h=y! i=(y satisfies unknown)/>\n";

/** The `<x>` attributes of {@link SOURCE}, by name. */
function attrsOf(options?: LowerSourceOptions): Record<string, Attr["value"]> {
  const { ir, diagnostics } = lowerSource(SOURCE, "/f.mx", options);
  expect(diagnostics).toEqual([]);
  const tag = (ir as unknown as { body: { tag: { attrs: Attr[] } }[] }).body[0]
    ?.tag;
  return Object.fromEntries((tag?.attrs ?? []).map((a) => [a.name, a.value]));
}

describe("`stripTypes: false` keeps the authored TypeScript", () => {
  it("an arrow keeps its parameter and return annotations", () => {
    const f = attrsOf({ stripTypes: false }).f;
    expect(f?.node.type).toBe("ArrowFunctionExpression");
    expect(f?.node.returnType).toMatchObject({ type: "TSTypeAnnotation" });
    expect(f?.node.params?.[0]?.typeAnnotation).toMatchObject({
      type: "TSTypeAnnotation",
    });
    expect(f?.code).toBe("(a: number): number => a");
  });

  it.each([
    ["g", "TSAsExpression", "y as string"],
    ["h", "TSNonNullExpression", "y!"],
    ["i", "TSSatisfiesExpression", "y satisfies unknown"],
  ])("`%s` stays a %s, and `Expr.code` is `%s`", (name, type, code) => {
    const value = attrsOf({ stripTypes: false })[name];
    expect(value?.node.type).toBe(type);
    expect(value?.code).toBe(code);
  });

  it("a `static` statement keeps its text either way", () => {
    for (const stripTypes of [undefined, true, false]) {
      const { ir } = lowerSource(SOURCE, "/f.mx", {
        ...(stripTypes === undefined ? {} : { stripTypes }),
      });
      expect(ir?.hoisted[0]).toMatchObject({ code: "const y: unknown = 1;" });
    }
  });
});

describe("the default is byte-identical to today", () => {
  const stripped = {
    f: { code: "(a: number): number => a", type: "ArrowFunctionExpression" },
    g: { code: "y", type: "Identifier" },
    h: { code: "y", type: "Identifier" },
    i: { code: "y", type: "Identifier" },
  };

  it.each([
    ["omitted", undefined],
    ["true", true],
  ])("stripTypes %s", (_label, stripTypes) => {
    const attrs = attrsOf(stripTypes === undefined ? {} : { stripTypes });
    for (const [name, want] of Object.entries(stripped)) {
      expect(attrs[name]?.code).toBe(want.code);
      expect(attrs[name]?.node.type).toBe(want.type);
    }
    expect(attrs.f?.node.returnType).toBeNull();
    expect(attrs.f?.node.params?.[0]?.typeAnnotation).toBeNull();
  });

  it("`true` and omitted lower to the same IR", () => {
    const strip = (o: LowerSourceOptions) =>
      JSON.stringify(lowerSource(SOURCE, "/f.mx", o));
    expect(strip({ stripTypes: true })).toBe(strip({}));
  });
});

describe("a dialect's hooks", () => {
  const TRIGGER: Trigger = {
    id: "t",
    chars: "~",
    match: "~[a-z]+",
    standIn: "identifier",
    node: { type: "Tt", dialect: "tt" },
  } as Trigger;

  /** `~name=value` on a tag: `nodeType.lower` records the value node it is handed. */
  function dialectOf(seen: Typed[], afterLower?: Dialect["afterLower"]) {
    return {
      id: "tt",
      name: "Tt",
      table: { attributeTriggers: [TRIGGER] },
      nodeTypes: {
        Tt: {
          keys: ["value"],
          parse: (text: string) => ({ name: text.slice(1) }),
          print: (node: { name: string }) => `~${node.name}`,
          lower: (
            node: { name: string; value: { node: Typed } },
            ctx: { value: unknown; attribute: (...a: unknown[]) => never },
          ) => {
            seen.push(node.value.node);
            return ctx.attribute(node.name, ctx.value ?? true);
          },
        },
      },
      ...(afterLower ? { afterLower } : {}),
    } as unknown as Dialect;
  }

  const ARROW = "<x ~a=((a: number): number => a)/>\n";

  it("`nodeType.lower` sees the typed node with the option off, the stripped one by default", () => {
    const off: Typed[] = [];
    lowerSource(ARROW, "/f.mx", { dialect: dialectOf(off), stripTypes: false });
    expect(off[0]?.returnType).toMatchObject({ type: "TSTypeAnnotation" });
    expect(off[0]?.params?.[0]?.typeAnnotation).toMatchObject({
      type: "TSTypeAnnotation",
    });
    const on: Typed[] = [];
    lowerSource(ARROW, "/f.mx", { dialect: dialectOf(on) });
    expect(on[0]?.returnType).toBeNull();
    expect(on[0]?.params?.[0]?.typeAnnotation).toBeNull();
  });

  it("`afterLower` sees the typed node with the option off, the stripped one by default", () => {
    const tags: Record<string, CustomTag> = {
      x: { attributes: { f: {}, g: {} } },
    };
    const source = "<x f=((a: number) => a) g=(y as string)/>\n";
    const run = (stripTypes?: boolean) => {
      const nodes: Record<string, Typed> = {};
      const dialect = dialectOf([], (unit) => {
        for (const call of unit.calls) {
          for (const attr of call.attrs) {
            if ("spread" in attr || !attr.value) continue;
            nodes[attr.name] = (attr.value as unknown as { node: Typed }).node;
          }
        }
      });
      const { diagnostics } = lowerSource(source, "/f.mx", {
        customTags: tags,
        dialect,
        ...(stripTypes === undefined ? {} : { stripTypes }),
      });
      expect(diagnostics).toEqual([]);
      return nodes;
    };
    const off = run(false);
    expect(off.g?.type).toBe("TSAsExpression");
    expect(off.f?.params?.[0]?.typeAnnotation).toMatchObject({
      type: "TSTypeAnnotation",
    });
    const on = run();
    expect(on.g?.type).toBe("Identifier");
    expect(on.f?.params?.[0]?.typeAnnotation).toBeNull();
  });
});

describe("`ctx.lower` in a tag-file hook", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-strip-types-")));
    file = join(dir, "a.member.mx");
    clearScanCache();
    clearTagFileCache();
    (globalThis as unknown as { __types: unknown[] }).__types = [];
  });
  afterEach(() => {
    clearScanCache();
    clearTagFileCache();
    rmSync(dir, { recursive: true, force: true });
  });
  const seen = () => (globalThis as unknown as { __types: unknown[] }).__types;

  function project() {
    dialectProject(dir, {
      manifest: {
        id: "test",
        name: "Test",
        extensions: [".member.mx"],
        tagDirs: ["concepts"],
      },
      module: `export default {
  table: {},
  tagRules: "none",
  tagFile(input, ctx) {
    const none = ctx.lower();
    const off = ctx.lower({ stripTypes: false });
    const offAgain = ctx.lower({ stripTypes: false });
    const on = ctx.lower({ stripTypes: true });
    const ret = (r) => r.ir.body[0].tag.attrs[0].value.node.returnType;
    globalThis.__types.push({
      none: ret(none)?.type ?? null,
      off: ret(off)?.type ?? null,
      on: ret(on)?.type ?? null,
      sameOff: off === offAgain,
      noneIsOn: none === on,
      distinct: off !== none,
    });
    return { contract: {} };
  },
};`,
    });
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(
      join(dir, "concepts", "money.member.mx"),
      "<x f=((a: number): number => a)/>\n",
    );
  }

  it("sees types with `stripTypes: false`, and the two values are two memo entries", () => {
    project();
    lowerSource("<money/>\n", file, {
      customTags: scanCached(file, { targets }).customTags,
    });
    expect(seen()).toEqual([
      {
        none: null,
        off: "TSTypeAnnotation",
        on: null,
        sameOff: true,
        noneIsOn: false,
        distinct: true,
      },
    ]);
  });
});

describe("the passes over the IR take typed nodes", () => {
  const SOURCES = [
    "<x f=((a: number): number => a) g=(y as string) h=y! i=(y satisfies unknown)/>\n",
    "<x/>\nstatic const y: unknown = 1;\n",
    "<const/k: number = 1/>\n<x/>\n",
    "<const/k=(1 as number)/>\n<x/>\n",
    "<let/z: string = 'a'/>\n<x/>\n",
    "<x a=(1 satisfies number) b=(2)!/>\n",
  ];

  it.each(
    SOURCES.flatMap((source) =>
      (["pass", "reject"] as const).map(
        (structural) =>
          [JSON.stringify(source), source, structural] as [
            string,
            string,
            "pass" | "reject",
          ],
      ),
    ),
  )(
    "%s, structural %s: no crash, the diagnostics of the stripped lowering",
    (_label, source, structural) => {
      const diagnostics = (stripTypes: boolean) =>
        lowerSource(source, "/f.mx", { structural, stripTypes }).diagnostics;
      expect(diagnostics(false)).toEqual(diagnostics(true));
    },
  );

  it("the typed `<let>` default is refused with the same code under both", () => {
    for (const stripTypes of [true, false]) {
      expect(
        lowerSource("<let/z: string = 'a'/>\n<x/>\n", "/f.mx", {
          stripTypes,
        }).diagnostics.map((d) => d.code),
      ).toEqual(["MX_NOT_IN_DATA_FILE"]);
    }
  });

  it('`structural: "reject"` refuses the typed `<const>` and `static` under both', () => {
    for (const stripTypes of [true, false]) {
      for (const source of [
        "<const/k: number = 1/>\n<x/>\n",
        "static const y: unknown = 1;\n<x/>\n",
      ]) {
        expect(
          lowerSource(source, "/f.mx", {
            structural: "reject",
            stripTypes,
          }).diagnostics.map((d) => d.code),
        ).toEqual(["MX_STRUCTURAL_CONSTRUCT"]);
      }
    }
  });
});
