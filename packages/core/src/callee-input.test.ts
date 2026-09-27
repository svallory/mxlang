/**
 * The callee-`Input` reader (decision 106), driven against real fixture
 * files on disk. Every test asserts the full returned object — shape,
 * cardinality, nested declarations and callee spans — not a fragment, so a
 * field 1b codes against cannot drift silently.
 *
 * `.mx` callees read through the template-metadata compile/cache, so those
 * tests need a real lowering `Ctx` (`ResolveContext.ctx`) and therefore run
 * after `lower.ts` has registered the metadata compiler.
 */

import { readFileSync, statSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AttrTagDecl,
  type CalleeInput,
  type ResolveContext,
  readCalleeInput,
  resetCalleeInputCache,
} from "./callee-input.ts";
import { compileSource } from "./compile.ts";
import type { Policy } from "./declarations.ts";
import { newCtx, printExpression } from "./index.ts";
import type { ComponentTarget } from "./ir.ts";
import "./lower.ts";
import { resetTemplateCache } from "./template-tag.ts";

const FIXTURES = fileURLToPath(
  new URL("./fixtures/callee-input", import.meta.url),
);
/** The file doing the calling; only its directory matters for resolution. */
const CALLER = `${FIXTURES}/caller.mx`;

function fixture(name: string): string {
  return `${FIXTURES}/${name}`;
}

function fixtureSource(name: string): string {
  return readFileSync(fixture(name), "utf8");
}

function declarations(): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  };
}

/**
 * The span of one `AttrTag` type reference, as the reader reports it: Babel's
 * numeric offsets into the text the declaration was parsed from. `from` is
 * that text — a fixture file's source for `.ts`/`.tsx` callees, the sliced
 * `Input` statement for `.mx` callees.
 */
function refSpan(
  from: string,
  needle: string,
  offset = 0,
): { sourceStart: number; sourceEnd: number } {
  const start = from.indexOf(needle, offset);
  if (start === -1)
    throw new Error(`fixture text lacks ${JSON.stringify(needle)}`);
  return { sourceStart: start, sourceEnd: start + needle.length };
}

function namedTarget(name: string): { kind: "name"; name: string } {
  return { kind: "name", name };
}

function context(extra: Partial<ResolveContext> = {}): ResolveContext {
  return { importer: CALLER, ...extra };
}

afterEach(() => {
  resetCalleeInputCache();
  resetTemplateCache();
});

describe("readCalleeInput", () => {
  it("reads an inline literal config", () => {
    const source = fixtureSource("inline.ts");
    const { input, dependencies } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./inline"]]) }),
    );
    expect(dependencies).toEqual([fixture("inline.ts")]);
    expect(input).toEqual({
      kind: "declared",
      path: fixture("inline.ts"),
      attrTags: new Map([
        [
          "header",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, 'AttrTag<{ as: "renderable" }>'),
          },
        ],
        [
          "footer",
          {
            cardinality: "required",
            as: "data",
            hasAttrs: false,
            hasParams: true,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, "AttrTag<{ params: [year: number] }>"),
          },
        ],
        [
          "items",
          {
            cardinality: "array",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(
              source,
              'AttrTag<{ as: "data"; attrs: { id: string } }>',
            ),
          },
        ],
        [
          "groups",
          {
            cardinality: "array",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, "AttrTag<{ attrs: { label: string } }>"),
          },
        ],
        [
          "readonlyItems",
          {
            cardinality: "array",
            as: "data",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, "AttrTag", source.indexOf("readonlyItems")),
          },
        ],
        [
          "optionalItems",
          {
            cardinality: "array",
            as: "data",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, "AttrTag", source.indexOf("optionalItems")),
          },
        ],
      ]),
      otherProps: new Set(["title", "count"]),
      open: false,
    } satisfies CalleeInput);
  });

  it("follows a same-file alias two hops deep", () => {
    const source = fixtureSource("alias.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./alias"]]) }),
    );
    expect(input).toEqual({
      kind: "declared",
      path: fixture("alias.ts"),
      attrTags: new Map([
        [
          "header",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            // The span is the AttrTag reference inside `type Header = …`,
            // not the property's use of the alias name.
            span: refSpan(source, "AttrTag<HeaderConfig>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("follows an import type from a .ts file and records the dependency", () => {
    const source = fixtureSource("uses-ts-import.ts");
    const ctx = newCtx(
      fixtureSource("uses-ts-import.ts"),
      printExpression,
      declarations(),
      undefined,
      CALLER,
    );
    const { input, dependencies } = readCalleeInput(
      namedTarget("Row"),
      context({ imports: new Map([["Row", "./uses-ts-import"]]), ctx }),
    );
    expect(dependencies).toEqual([
      fixture("uses-ts-import.ts"),
      fixture("row-config.ts"),
    ]);
    // The read files are also recorded on the lowering Ctx, which is what
    // CompileResult.dependencies drains.
    expect([...(ctx.dependencies ?? [])].sort()).toEqual(
      [fixture("uses-ts-import.ts"), fixture("row-config.ts")].sort(),
    );
    expect(input).toEqual({
      kind: "declared",
      path: fixture("uses-ts-import.ts"),
      attrTags: new Map([
        [
          "row",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, "AttrTag<RowConfig>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("reads a .mx callee through the template metadata cache and follows an import type from it", () => {
    const inputCode = [
      "export interface Input {",
      "  icon?: AttrTag<IconConfig>;",
      "}",
    ].join("\n");
    const ctx = newCtx(
      fixtureSource("uses-mx-import.mx"),
      printExpression,
      declarations(),
      undefined,
      CALLER,
    );
    const { input, dependencies } = readCalleeInput(
      namedTarget("Icon"),
      context({ imports: new Map([["Icon", "./uses-mx-import.mx"]]), ctx }),
    );
    expect(dependencies).toEqual([
      fixture("uses-mx-import.mx"),
      fixture("mx-config.mx"),
    ]);
    expect(input).toEqual({
      kind: "declared",
      path: fixture("uses-mx-import.mx"),
      attrTags: new Map([
        [
          "icon",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            // Spans of a .mx callee are offsets into the sliced Input
            // statement, not the template file.
            span: refSpan(inputCode, "AttrTag<IconConfig>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("reads an exported Input from a .tsx callee and ignores non-exported ones", () => {
    const source = fixtureSource("tsx-callee.tsx");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./tsx-callee.tsx"]]) }),
    );
    expect(input).toEqual({
      kind: "declared",
      path: fixture("tsx-callee.tsx"),
      attrTags: new Map([
        [
          "header",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, 'AttrTag<{ as: "renderable" }>'),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("returns none for a .tsx callee that only exports Props", () => {
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./tsx-props"]]) }),
    );
    expect(input).toEqual({
      kind: "none",
      path: fixture("tsx-props.tsx"),
    } satisfies CalleeInput);
  });

  it("scans attrs recursively two levels deep, including an alias inside attrs", () => {
    const source = fixtureSource("nested.ts");
    const { input } = readCalleeInput(
      namedTarget("Tabs"),
      context({ imports: new Map([["Tabs", "./nested"]]) }),
    );
    const badge: AttrTagDecl = {
      cardinality: "optional",
      as: "renderable",
      hasAttrs: false,
      hasParams: false,
      nested: new Map(),
      nestedOpen: false,
      span: refSpan(source, "AttrTag<Badge>"),
    };
    const icon: AttrTagDecl = {
      cardinality: "optional",
      as: "data",
      hasAttrs: true,
      hasParams: false,
      nested: new Map([["badge", badge]]),
      nestedOpen: false,
      span: refSpan(source, "AttrTag<{ attrs: { badge?: AttrTag<Badge> } }>"),
    };
    expect(input).toEqual({
      kind: "declared",
      path: fixture("nested.ts"),
      attrTags: new Map([
        [
          "tabs",
          {
            cardinality: "array",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map([["icon", icon]]),
            nestedOpen: false,
            span: {
              sourceStart: source.indexOf("AttrTag<{"),
              sourceEnd: source.indexOf("}>[]") + 2,
            },
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("rejects a non-literal config with the callee span", () => {
    const source = fixtureSource("invalid-config.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./invalid-config"]]) }),
    );
    expect(input).toEqual({
      kind: "invalid",
      path: fixture("invalid-config.ts"),
      errors: new Map([
        [
          "x",
          {
            message: "declare this attribute tag's config literally",
            span: refSpan(source, "AttrTag<Picky>"),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("rejects a non-literal `as`", () => {
    const source = fixtureSource("invalid-as.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./invalid-as"]]) }),
    );
    expect(input).toEqual({
      kind: "invalid",
      path: fixture("invalid-as.ts"),
      errors: new Map([
        [
          "x",
          {
            message: "declare this attribute tag's config literally",
            span: refSpan(source, "AttrTag<{ as: AsType }>"),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("rejects non-tuple params", () => {
    const source = fixtureSource("invalid-params.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./invalid-params"]]) }),
    );
    expect(input).toEqual({
      kind: "invalid",
      path: fixture("invalid-params.ts"),
      errors: new Map([
        [
          "x",
          {
            message: "attribute tag params must be a tuple type",
            span: refSpan(source, "AttrTag<{ params: string[] }>"),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("rejects renderable with attrs, with the decision-106 wording", () => {
    const source = fixtureSource("invalid-renderable-attrs.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./invalid-renderable-attrs"]]) }),
    );
    expect(input).toEqual({
      kind: "invalid",
      path: fixture("invalid-renderable-attrs.ts"),
      errors: new Map([
        [
          "x",
          {
            message:
              'renderable attribute tags can\'t take attributes; declare as: "data"',
            span: refSpan(
              source,
              'AttrTag<{ as: "renderable"; attrs: { id: string } }>',
            ),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("returns unresolved for an import that cannot be resolved", () => {
    const { input, dependencies } = readCalleeInput(
      namedTarget("Missing"),
      context({ imports: new Map([["Missing", "./does-not-exist"]]) }),
    );
    expect(dependencies).toEqual([]);
    expect(input).toEqual({
      kind: "unresolved",
      specifier: "./does-not-exist",
    } satisfies CalleeInput);
  });

  it("tries resolveImport before the built-in resolution", () => {
    // "./inline" would resolve to inline.ts on its own; the tool resolver
    // redirects it, and its answer wins.
    const aliased = fixture("aliased.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({
        imports: new Map([["Card", "./inline"]]),
        resolveImport: (specifier) =>
          specifier === "./inline" ? aliased : undefined,
      }),
    );
    expect(input.kind).toBe("declared");
    if (input.kind !== "declared") return;
    expect(input.path).toBe(aliased);
    expect([...input.attrTags.keys()]).toEqual(["aliased"]);

    // A specifier the tool resolver declines falls through to the ordinary
    // relative probing.
    const viaBuiltin = readCalleeInput(
      namedTarget("Card"),
      context({
        imports: new Map([["Card", "./inline"]]),
        resolveImport: () => undefined,
      }),
    );
    expect(viaBuiltin.input.kind).toBe("declared");
    if (viaBuiltin.input.kind !== "declared") return;
    expect(viaBuiltin.input.path).toBe(fixture("inline.ts"));
    expect([...viaBuiltin.input.attrTags.keys()]).toEqual([
      "header",
      "footer",
      "items",
      "groups",
      "readonlyItems",
      "optionalItems",
    ]);
  });

  it("terminates on a type-import cycle", () => {
    const { input, dependencies } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./cycle-a"]]) }),
    );
    expect(dependencies).toEqual([
      fixture("cycle-a.ts"),
      fixture("cycle-b.ts"),
    ]);
    const source = fixtureSource("cycle-a.ts");
    // The alias chain A -> B -> A never reaches a literal. Because it is the
    // config of a recognised AttrTag, this is invalid rather than a plain prop.
    expect(input).toEqual({
      kind: "invalid",
      path: fixture("cycle-a.ts"),
      errors: new Map([
        [
          "x",
          {
            message: "declare this attribute tag's config literally",
            span: refSpan(source, "AttrTag<A>"),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("rejects an AttrTag config alias deeper than four hops", () => {
    const source = fixtureSource("depth.ts");
    const { input, dependencies } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./depth"]]) }),
    );
    expect(dependencies).toEqual([fixture("depth.ts")]);
    expect(input).toEqual({
      kind: "invalid",
      path: fixture("depth.ts"),
      errors: new Map([
        [
          "x",
          {
            message: "declare this attribute tag's config literally",
            span: refSpan(source, "AttrTag<C1>"),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("caches by path + mtime + source and misses after an mtime change", () => {
    const target = namedTarget("Card");
    const ctx = () => context({ imports: new Map([["Card", "./cache"]]) });
    const first = readCalleeInput(target, ctx());
    const loweringCtx = newCtx(
      "",
      printExpression,
      declarations(),
      undefined,
      CALLER,
    );
    const hit = readCalleeInput(
      target,
      context({
        imports: new Map([["Card", "./cache"]]),
        ctx: loweringCtx,
      }),
    );
    expect(hit).toBe(first);
    expect([...(loweringCtx.dependencies ?? [])]).toEqual([
      fixture("cache.ts"),
    ]);

    const path = fixture("cache.ts");
    const later = new Date(statSync(path).mtimeMs + 2000);
    utimesSync(path, later, later);
    try {
      const miss = readCalleeInput(target, ctx());
      expect(miss).not.toBe(first);
      expect(miss.input).toEqual(first.input);
    } finally {
      // Leave the fixture's mtime where the checkout had it: the cache keys
      // on content too, so any value works for other tests — but a restored
      // mtime keeps the tree byte-stable.
      const now = new Date();
      utimesSync(path, now, now);
    }
  });

  it("marks an Input with an index signature open", () => {
    const source = fixtureSource("open.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./open"]]) }),
    );
    expect(input).toEqual({
      kind: "declared",
      path: fixture("open.ts"),
      attrTags: new Map([
        [
          "known",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, "AttrTag"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: true,
    } satisfies CalleeInput);
  });

  it("marks an Input with an unresolvable extends open", () => {
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./open-extends"]]) }),
    );
    expect(input.kind).toBe("declared");
    if (input.kind !== "declared") return;
    expect(input.open).toBe(true);
    expect([...input.attrTags.keys()]).toEqual(["known"]);
  });

  it("does not recognise AttrTag imported from a non-mx module", () => {
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./bad-import"]]) }),
    );
    expect(input).toEqual({
      kind: "declared",
      path: fixture("bad-import.ts"),
      attrTags: new Map(),
      otherProps: new Set(["x"]),
      open: false,
    } satisfies CalleeInput);
  });

  it("recognises AttrTag imported type-only from @mxlang/core", () => {
    const source = fixtureSource("mx-import.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./mx-import"]]) }),
    );
    expect(input).toEqual({
      kind: "declared",
      path: fixture("mx-import.ts"),
      attrTags: new Map([
        [
          "x",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(
              source,
              "AttrTag",
              source.indexOf("export interface"),
            ),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("reads a discovered tag by its resolvedPath", () => {
    const { input, dependencies } = readCalleeInput(
      namedTarget("Card"),
      context({ discovered: new Map([["Card", fixture("inline.ts")]]) }),
    );
    expect(dependencies).toEqual([fixture("inline.ts")]);
    expect(input.kind).toBe("declared");
    if (input.kind !== "declared") return;
    expect(input.path).toBe(fixture("inline.ts"));
  });

  it("returns none for dynamic and define targets", () => {
    for (const target of [
      {
        kind: "dynamic",
        expr: { code: "input.x", shape: "other", node: null },
      },
      { kind: "define", name: "Row", params: [] },
    ] as ComponentTarget[]) {
      const { input } = readCalleeInput(target, context());
      expect(input).toEqual({ kind: "none" } satisfies CalleeInput);
    }
  });

  it("compile results carry an empty dependency list until the resolver is wired in", () => {
    const result = compileSource("<div/>\n", CALLER, declarations(), {
      emitIr: () => "",
    });
    expect(result.dependencies).toEqual([]);
  });
});
