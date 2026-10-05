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

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AttrTagDecl,
  type CalleeInput,
  type CalleeInputResult,
  calleeReturnsValue,
  type ResolveContext,
  readCalleeInput,
  resetCalleeInputCache,
  resolveSpecifier,
} from "./callee-input.ts";
import { compileSource } from "./compile.ts";
import type { MxWarning } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import { newCtx, printExpression } from "./index.ts";
import type { ComponentTarget, Ir } from "./ir.ts";
import { lookup } from "./test-targets.ts";
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

function probed(name: string, foundExtension: string): string[] {
  const base = fixture(name);
  const extensions = ["", ".mx", ".tsx", ".ts", ".jsx", ".js"];
  return extensions
    .slice(0, extensions.indexOf(foundExtension) + 1)
    .map((extension) => base + extension);
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
): { file?: string; sourceStart: number; sourceEnd: number } {
  const start = from.indexOf(needle, offset);
  if (start === -1)
    throw new Error(`fixture text lacks ${JSON.stringify(needle)}`);
  const match = readdirSync(FIXTURES, { withFileTypes: true }).find(
    (entry) =>
      entry.isFile() && readFileSync(fixture(entry.name), "utf8") === from,
  );
  return {
    ...(match ? { file: fixture(match.name) } : {}),
    sourceStart: start,
    sourceEnd: start + needle.length,
  };
}

function namedTarget(name: string): { kind: "name"; name: string } {
  return { kind: "name", name };
}

function context(extra: Partial<ResolveContext> = {}): ResolveContext {
  // Every read runs under the test's own registered set: the reader asks it
  // which packages export `AttrTag` and which file-kind segments exist, so it
  // is part of the context rather than something the tests leave out.
  return { importer: CALLER, targets: lookup, ...extra };
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

      lookup,
    );
    const { input, dependencies } = readCalleeInput(
      namedTarget("Row"),
      context({ imports: new Map([["Row", "./uses-ts-import"]]), ctx }),
    );
    expect(dependencies).toEqual([
      fixture("uses-ts-import.ts"),
      ...probed("row-config", ".ts"),
    ]);
    // The read files are also recorded on the lowering Ctx, which is what
    // CompileResult.dependencies drains.
    expect([...(ctx.dependencies ?? [])].sort()).toEqual(
      [fixture("uses-ts-import.ts"), ...probed("row-config", ".ts")].sort(),
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
    const ctx = newCtx(
      fixtureSource("uses-mx-import.mx"),
      printExpression,
      declarations(),
      undefined,
      CALLER,

      lookup,
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
            span: refSpan(
              fixtureSource("uses-mx-import.mx"),
              "AttrTag<IconConfig>",
            ),
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
              file: fixture("nested.ts"),
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

  it("returns unresolved for an import that cannot be resolved, but still reports every probed candidate as a dependency", () => {
    // Every extension/index candidate `resolveSpecifier` tried is recorded,
    // not just the literal specifier: creating any one of them (or an editor
    // opening an unsaved buffer at that exact path — see the
    // `withCalleeInputSources` retry tests below) must invalidate this
    // caller, and none of those candidate paths is known until probing runs.
    const { input, dependencies } = readCalleeInput(
      namedTarget("Missing"),
      context({ imports: new Map([["Missing", "./does-not-exist"]]) }),
    );
    expect(dependencies.length).toBeGreaterThan(0);
    expect(dependencies).toContain(fixture("does-not-exist"));
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
    const aliasedSource = fixtureSource("aliased.ts");
    expect(input).toEqual({
      kind: "declared",
      path: aliased,
      attrTags: new Map([
        [
          "aliased",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(aliasedSource, 'AttrTag<{ as: "renderable" }>'),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);

    // A specifier the tool resolver declines falls through to the ordinary
    // relative probing.
    const viaBuiltin = readCalleeInput(
      namedTarget("Card"),
      context({
        imports: new Map([["Card", "./inline"]]),
        resolveImport: () => undefined,
      }),
    );
    expect(viaBuiltin.input).toEqual(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./inline"]]) }),
      ).input,
    );
  });

  it("resolves a bare package returned by resolveImport as a package", () => {
    expect(
      resolveSpecifier("virtual-core", {
        importer: CALLER,
        targets: lookup,
        resolveImport: (specifier) =>
          specifier === "virtual-core" ? "@mxlang/core" : undefined,
      }),
    ).toBe(fileURLToPath(new URL("../dist/index.js", import.meta.url)));
  });

  it("returns none for a callee whose file kind has no reader", () => {
    expect(
      readCalleeInput(
        namedTarget("NoInput"),
        context({ imports: new Map([["NoInput", "./no-input.v.mx"]]) }),
      ),
    ).toEqual({
      input: { kind: "none", path: fixture("no-input.v.mx") },
      dependencies: [fixture("no-input.v.mx")],
    } satisfies CalleeInputResult);
  });

  it("returns none for an unregistered file-kind callee instead of Marko-parsing it", () => {
    // A host module is a TypeScript module with a template region, never a
    // Marko template. With no reader registered for the extension the callee
    // must fall back to an untyped `none`, not through the plain `.mx` branch.
    for (const withCtx of [false, true]) {
      resetCalleeInputCache();
      const ctx = withCtx
        ? newCtx("", printExpression, declarations(), undefined, CALLER, lookup)
        : undefined;
      expect(
        readCalleeInput(
          namedTarget("Card"),
          context({ imports: new Map([["Card", "./no-input.u.mx"]]), ctx }),
        ),
      ).toEqual({
        input: { kind: "none", path: fixture("no-input.u.mx") },
        dependencies: [fixture("no-input.u.mx")],
      } satisfies CalleeInputResult);
    }
  });

  it("returns none for an untyped .marko callee", () => {
    expect(
      readCalleeInput(
        namedTarget("Panel"),
        context({ imports: new Map([["Panel", "./untyped.marko"]]) }),
      ),
    ).toEqual({
      input: { kind: "none", path: fixture("untyped.marko") },
      dependencies: [fixture("untyped.marko")],
    } satisfies CalleeInputResult);
  });

  it("resolves directory imports through index files", () => {
    const source = fixtureSource("directory/index.ts");
    expect(
      readCalleeInput(
        namedTarget("Directory"),
        context({ imports: new Map([["Directory", "./directory"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("directory/index.ts"),
      attrTags: new Map([
        [
          "item",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: {
              file: fixture("directory/index.ts"),
              sourceStart: source.indexOf('AttrTag<{ as: "renderable" }>'),
              sourceEnd:
                source.indexOf('AttrTag<{ as: "renderable" }>') +
                'AttrTag<{ as: "renderable" }>'.length,
            },
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("terminates on a type-import cycle", () => {
    const { input, dependencies } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./cycle-a"]]) }),
    );
    expect(dependencies).toEqual([
      fixture("cycle-a.ts"),
      ...probed("cycle-b", ".ts"),
      ...probed("cycle-a", ".ts").slice(0, -1),
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
    const directory = mkdtempSync(join(tmpdir(), "mx-callee-cache-"));
    const path = join(directory, "cache.ts");
    writeFileSync(path, fixtureSource("cache.ts"));
    const target = { kind: "name", name: "Card", resolvedPath: path } as const;
    const ctx = () => ({
      importer: join(directory, "caller.mx"),
      targets: lookup,
    });
    const first = readCalleeInput(target, ctx());
    const loweringCtx = newCtx(
      "",
      printExpression,
      declarations(),
      undefined,
      join(directory, "caller.mx"),
      lookup,
    );
    const hit = readCalleeInput(
      target,
      context({
        discovered: new Map([["Card", path]]),
        ctx: loweringCtx,
      }),
    );
    expect(hit).toBe(first);
    expect([...(loweringCtx.dependencies ?? [])]).toEqual([path]);

    const later = new Date(statSync(path).mtimeMs + 2000);
    utimesSync(path, later, later);
    try {
      const miss = readCalleeInput(target, ctx());
      expect(miss).not.toBe(first);
      expect(miss.input).toEqual(first.input);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keys resolver-backed cache entries by stable resolver identity", () => {
    const target = namedTarget("Card");
    const imports = new Map([["Card", "virtual-card"]]);
    const resolver = () => fixture("aliased.ts");
    const first = readCalleeInput(
      target,
      context({ imports, resolveImport: resolver }),
    );
    expect(
      readCalleeInput(target, context({ imports, resolveImport: resolver })),
    ).toBe(first);
    expect(
      readCalleeInput(
        target,
        context({
          imports,
          resolveImport: () => fixture("aliased.ts"),
        }),
      ),
    ).not.toBe(first);
  });

  it("invalidates a cached result when a followed dependency changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-callee-dependency-"));
    const main = join(directory, "main.ts");
    const dependency = join(directory, "config.ts");
    writeFileSync(
      main,
      'import type { Cfg } from "./config"; export interface Input { x?: AttrTag<Cfg> }',
    );
    writeFileSync(dependency, 'export type Cfg = { as: "data" };\n');
    const target = { kind: "name", name: "Card", resolvedPath: main } as const;
    const read = () =>
      readCalleeInput(target, {
        importer: join(directory, "caller.mx"),
        targets: lookup,
      });
    try {
      const first = read();
      writeFileSync(dependency, 'export type Cfg = { as: "renderable" };\n');
      const later = new Date(statSync(dependency).mtimeMs + 2000);
      utimesSync(dependency, later, later);
      const second = read();
      expect(second).not.toBe(first);
      expect(second.input).toMatchObject({
        kind: "declared",
        attrTags: new Map([
          ["x", expect.objectContaining({ as: "renderable" })],
        ]),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("invalidates when a previously probed dependency is created", () => {
    const directory = mkdtempSync(join(tmpdir(), "mx-callee-created-"));
    const main = join(directory, "main.ts");
    const dependency = join(directory, "later.ts");
    writeFileSync(
      main,
      'import type { Cfg } from "./later"; export interface Input { x?: AttrTag<Cfg> }',
    );
    const target = { kind: "name", name: "Card", resolvedPath: main } as const;
    const read = () =>
      readCalleeInput(target, {
        importer: join(directory, "caller.mx"),
        targets: lookup,
      });
    try {
      const first = read();
      expect(first.dependencies).toContain(dependency);
      writeFileSync(dependency, 'export type Cfg = { as: "renderable" };\n');
      const second = read();
      expect(second).not.toBe(first);
      expect(second.input).toMatchObject({
        kind: "declared",
        attrTags: new Map([
          ["x", expect.objectContaining({ as: "renderable" })],
        ]),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
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
    const source = fixtureSource("open-extends.ts");
    const { input } = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./open-extends"]]) }),
    );
    expect(input).toEqual({
      kind: "declared",
      path: fixture("open-extends.ts"),
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
    const source = fixtureSource("aliased.ts");
    const { input, dependencies } = readCalleeInput(
      namedTarget("Card"),
      context({ discovered: new Map([["Card", fixture("aliased.ts")]]) }),
    );
    expect(dependencies).toEqual([fixture("aliased.ts")]);
    expect(input).toEqual({
      kind: "declared",
      path: fixture("aliased.ts"),
      attrTags: new Map([
        [
          "aliased",
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

  it("keeps followed-file declarations and AttrTag bindings file-scoped", () => {
    const collision = fixtureSource("collision.ts");
    const dependency = fixtureSource("coll-dep.ts");
    const result = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./collision"]]) }),
    );
    expect(result.input).toEqual({
      kind: "declared",
      path: fixture("collision.ts"),
      attrTags: new Map([
        [
          "a",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(collision, "AttrTag<Cfg>"),
          },
        ],
        [
          "b",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(collision, "AttrTag<Local>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
    expect(dependency).toContain('as: "data"');

    const leakSource = fixtureSource("leak.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./leak"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("leak.ts"),
      attrTags: new Map([
        [
          "a",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(leakSource, "AttrTag<Cfg>"),
          },
        ],
        [
          "b",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(leakSource, "AttrTag", leakSource.indexOf("b?:")),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("flattens an alias-typed Input intersection", () => {
    const source = fixtureSource("alias-input.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./alias-input"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("alias-input.ts"),
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
            span: refSpan(source, "AttrTag"),
          },
        ],
      ]),
      otherProps: new Set(["title"]),
      open: false,
    } satisfies CalleeInput);
  });

  it("treats a local AttrTag declaration as an ordinary property type", () => {
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./local-type"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("local-type.ts"),
      attrTags: new Map(),
      otherProps: new Set(["x"]),
      open: false,
    } satisfies CalleeInput);
  });

  it("accepts AttrTag | undefined and rejects other AttrTag compounds", () => {
    const source = fixtureSource("union.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./union"]]) }),
      ).input,
    ).toEqual({
      kind: "invalid",
      path: fixture("union.ts"),
      errors: new Map([
        [
          "b",
          {
            message: "declare this attribute tag's config literally",
            span: refSpan(source, "AttrTag<{}> & { extra: 1 }"),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("returns invalid with the callee file for a TypeScript parse error", () => {
    const source = fixtureSource("parse-error.ts");
    const position = source.indexOf(";");
    const result = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./parse-error"]]) }),
    );
    expect(result.input.kind).toBe("invalid");
    if (result.input.kind !== "invalid") return;
    expect(result.input.path).toBe(fixture("parse-error.ts"));
    expect([...result.input.errors]).toEqual([
      [
        "<parse>",
        {
          message: expect.stringContaining("Unexpected token"),
          span: {
            file: fixture("parse-error.ts"),
            sourceStart: expect.any(Number),
            sourceEnd: expect.any(Number),
          },
        },
      ],
    ]);
    expect(position).toBeGreaterThan(0);
  });

  it("follows interfaces for configs and attrs", () => {
    const configSource = fixtureSource("iface-config.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./iface-config"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("iface-config.ts"),
      attrTags: new Map([
        [
          "x",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(configSource, "AttrTag<Cfg>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);

    const attrsSource = fixtureSource("iface-attrs.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./iface-attrs"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("iface-attrs.ts"),
      attrTags: new Map([
        [
          "x",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map([
              [
                "icon",
                {
                  cardinality: "optional",
                  as: "data",
                  hasAttrs: false,
                  hasParams: false,
                  nested: new Map(),
                  nestedOpen: false,
                  span: refSpan(
                    attrsSource,
                    "AttrTag",
                    attrsSource.indexOf("icon"),
                  ),
                },
              ],
            ]),
            nestedOpen: false,
            span: refSpan(attrsSource, "AttrTag<{ attrs: Attrs }>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("follows type re-exports and rejects AttrTag from an unrecognised mx package", () => {
    const source = fixtureSource("reexport-input.ts");
    const result = readCalleeInput(
      namedTarget("Card"),
      context({ imports: new Map([["Card", "./reexport-input"]]) }),
    );
    expect(result.input).toEqual({
      kind: "declared",
      path: fixture("reexport-input.ts"),
      attrTags: new Map([
        [
          "a",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(source, "AttrTag<Cfg>"),
          },
        ],
        [
          "b",
          {
            cardinality: "optional",
            as: "renderable",
            hasAttrs: false,
            hasParams: false,
            nested: new Map(),
            nestedOpen: false,
            span: refSpan(
              fixtureSource("reexport-cfg.ts"),
              'AttrTag<{ as: "renderable" }>',
            ),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./mx-parser-import"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("mx-parser-import.ts"),
      attrTags: new Map(),
      otherProps: new Set(["x"]),
      open: false,
    } satisfies CalleeInput);
  });

  it("reads a static Input from an mx file with file-relative spans", () => {
    const source = fixtureSource("StaticInput.mx");
    const ctx = newCtx(
      source,
      printExpression,
      declarations(),
      undefined,
      CALLER,

      lookup,
    );
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({
          imports: new Map([["Card", "./StaticInput.mx"]]),
          ctx,
        }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("StaticInput.mx"),
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
            span: refSpan(source, 'AttrTag<{ as: "renderable" }>'),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("applies the property alias depth limit at four hops", () => {
    const source = fixtureSource("prop-depth4.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./prop-depth4"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("prop-depth4.ts"),
      attrTags: new Map([
        [
          "x",
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
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./prop-depth5"]]) }),
      ).input,
    ).toEqual({
      kind: "invalid",
      path: fixture("prop-depth5.ts"),
      errors: new Map([
        [
          "x",
          {
            message: "declare this attribute tag's config literally",
            span: refSpan(
              fixtureSource("prop-depth5.ts"),
              "T1",
              fixtureSource("prop-depth5.ts").indexOf("export interface"),
            ),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("applies the extends-base alias depth limit at four hops", () => {
    const source = fixtureSource("extends-depth4.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./extends-depth4"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("extends-depth4.ts"),
      attrTags: new Map([
        [
          "x",
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

  it("reports a positioned error, not a silent open, when a 5-hop extends chain hides an AttrTag beyond MAX_ALIAS_DEPTH", () => {
    const source = fixtureSource("extends-depth5.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./extends-depth5"]]) }),
      ).input,
    ).toEqual({
      kind: "invalid",
      path: fixture("extends-depth5.ts"),
      errors: new Map([
        [
          "<input>",
          {
            message: "declare this attribute tag's config literally",
            // The unresolvable hop is `B4 extends B5` -- the fifth
            // `resolveNamedType` call, past `MAX_ALIAS_DEPTH` (4) -- not
            // `Input extends B1` itself: `Input`'s own base (B1, hop 1)
            // resolves fine, and so do B1->B2, B2->B3 and B3->B4.
            span: refSpan(source, "B5", source.indexOf("interface B4")),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("applies the intersection-alias depth limit at four hops", () => {
    const source = fixtureSource("intersection-depth4.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./intersection-depth4"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("intersection-depth4.ts"),
      attrTags: new Map([
        [
          "x",
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
      otherProps: new Set(["y"]),
      open: false,
    } satisfies CalleeInput);
  });

  it("reports a positioned error, not a silent open, when a 5-hop intersection alias hides an AttrTag beyond MAX_ALIAS_DEPTH", () => {
    const source = fixtureSource("intersection-depth5.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./intersection-depth5"]]) }),
      ).input,
    ).toEqual({
      kind: "invalid",
      path: fixture("intersection-depth5.ts"),
      errors: new Map([
        [
          "<input>",
          {
            message: "declare this attribute tag's config literally",
            // The unresolvable hop is `P4 = P5` -- the fifth
            // `resolveNamedType` call, past `MAX_ALIAS_DEPTH` (4) -- not the
            // top-level `& P1` intersection part itself: `Input`'s own P1
            // part (hop 1) resolves fine, and so do P1->P2, P2->P3 and
            // P3->P4.
            span: refSpan(source, "P5", source.indexOf("type P4")),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("applies the attrs-config alias depth limit at four hops", () => {
    const source = fixtureSource("attrs-alias-depth4.ts");
    const badge: AttrTagDecl = {
      cardinality: "optional",
      as: "renderable",
      hasAttrs: false,
      hasParams: false,
      nested: new Map(),
      nestedOpen: false,
      span: refSpan(source, 'AttrTag<{ as: "renderable" }>'),
    };
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./attrs-alias-depth4"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("attrs-alias-depth4.ts"),
      attrTags: new Map([
        [
          "tab",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map([["badge", badge]]),
            nestedOpen: false,
            span: refSpan(source, "AttrTag<{ attrs: A1 }>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("reports a positioned error, not a silent open, when a 5-hop attrs-config alias hides a nested AttrTag beyond MAX_ALIAS_DEPTH", () => {
    const source = fixtureSource("attrs-alias-depth5.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./attrs-alias-depth5"]]) }),
      ).input,
    ).toEqual({
      kind: "invalid",
      path: fixture("attrs-alias-depth5.ts"),
      errors: new Map([
        [
          "tab",
          {
            message: "declare this attribute tag's config literally",
            // The unresolvable hop is `A4 = A5` -- the fifth
            // `resolveNamedType` call inside `scanAttrs`, past
            // `MAX_ALIAS_DEPTH` (4) -- not the `attrs: A1` reference itself:
            // A1 (hop 1) resolves fine, and so do A1->A2, A2->A3, A3->A4.
            span: refSpan(source, "A5", source.indexOf("type A4")),
          },
        ],
      ]),
    } satisfies CalleeInput);
  });

  it("marks an attrs config open, with no error, for a genuinely missing alias", () => {
    const source = fixtureSource("attrs-alias-missing.ts");
    expect(
      readCalleeInput(
        namedTarget("Card"),
        context({ imports: new Map([["Card", "./attrs-alias-missing"]]) }),
      ).input,
    ).toEqual({
      kind: "declared",
      path: fixture("attrs-alias-missing.ts"),
      attrTags: new Map([
        [
          "tab",
          {
            cardinality: "optional",
            as: "data",
            hasAttrs: true,
            hasParams: false,
            nested: new Map(),
            nestedOpen: true,
            span: refSpan(source, "AttrTag<{ attrs: MissingAttrs }>"),
          },
        ],
      ]),
      otherProps: new Set(),
      open: false,
    } satisfies CalleeInput);
  });

  it("marks qualified and non-literal extends open", () => {
    for (const name of ["qualified-extends", "extends-nonliteral"]) {
      const source = fixtureSource(`${name}.ts`);
      expect(
        readCalleeInput(
          namedTarget("Card"),
          context({ imports: new Map([["Card", `./${name}`]]) }),
        ).input,
      ).toEqual({
        kind: "declared",
        path: fixture(`${name}.ts`),
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
              span: refSpan(source, "AttrTag"),
            },
          ],
        ]),
        otherProps: new Set(),
        open: true,
      } satisfies CalleeInput);
    }
  });

  it("compile results carry an empty dependency list when no callee is read", () => {
    const result = compileSource("<div/>\n", CALLER, declarations(), {
      targets: lookup,
      emitIr: () => "",
    });
    expect(result.dependencies).toEqual([]);
  });

  it("compile uses a declared array plan and records the callee dependency", () => {
    let lowered: Ir | undefined;
    const result = compileSource(
      'import Card from "./compile-callee"\n<Card><@items/><@items/></Card>\n',
      CALLER,
      { ...declarations(), attrTags: 2 },
      {
        targets: lookup,
        emitIr: (ir) => {
          lowered = ir;
          return "";
        },
      },
    );
    const component = lowered?.body.find((node) => node.kind === "Component");
    expect(component).toMatchObject({
      kind: "Component",
      attrTagProps: [{ name: "items", cardinality: "array", as: "data" }],
    });
    expect(result.dependencies).toContain(fixture("compile-callee.ts"));
  });

  it("compile rejects a repeated declared singular tag", () => {
    expect(() =>
      compileSource(
        'import Card from "./compile-callee"\n<Card><@header/><@header/></Card>\n',
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).toThrowError("`<@header>` may appear at most once");
  });

  it("compile reports a broken callee and warns for an unresolved one", () => {
    expect(() =>
      compileSource(
        'import Card from "./parse-error"\n<Card><@x/></Card>\n',
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).toThrowError(fixture("parse-error.ts"));

    const warnings: MxWarning[] = [];
    compileSource(
      'import Card from "./missing-callee"\n<Card><@x/></Card>\n',
      CALLER,
      { ...declarations(), attrTags: 2 },
      { targets: lookup, emitIr: () => "", warnings },
    );
    expect(warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("not resolvable"),
      }),
    ]);
  });

  it("compile reports only a used invalid declaration with its callee line", () => {
    expect(() =>
      compileSource(
        'import Multi from "./multi-invalid"\n<Multi><@y/></Multi>\n',
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).not.toThrow();
    expect(() =>
      compileSource(
        'import Multi from "./multi-invalid"\n<Multi><@x/></Multi>\n',
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).toThrowError(
      `can't read \`<Multi>\`'s declaration of \`x\` (${fixture("multi-invalid.ts")}:3); declare this attribute tag's config literally`,
    );
  });

  it("compile reports a callee parse error with line and column", () => {
    // 1-based column, like `mx-tsc`'s `file(line,column)` (ruling #227):
    // the fixture's `;` on line 2 is the 24th character of that line.
    expect(() =>
      compileSource(
        'import Card from "./parse-error"\n<Card><@x/></Card>\n',
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).toThrowError(
      `can't read \`<Card>\`'s Input (${fixture("parse-error.ts")}:2:24): Unexpected token`,
    );
  });

  it("decision 116: a value import routed to a dynamic tag still resolves its declared Input", () => {
    // "./compile-callee" is a bare, extensionless specifier — not a
    // `.marko`/`.mx` default import — so `lower.ts`'s decision-116 routing
    // lowers `<Card>` as a dynamic tag (`ComponentTarget.kind: "dynamic"`),
    // not a direct `kind: "name"` call. `valueImportBinding` on that target
    // is what still lets `readCalleeInput` resolve `Card`'s real `Input`
    // for typed attribute-tag checking — the positive case (a declared
    // singular tag, given once, is accepted).
    expect(() =>
      compileSource(
        'import Card from "./compile-callee"\n<Card><@header/></Card>\n',
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).not.toThrow();
  });

  it("decision 116: a value import routed to a dynamic tag still reports a wrong-attribute diagnostic, naming the real tag", () => {
    // Same routing as above; `<@header>` given twice violates the callee's
    // declared singular cardinality. The diagnostic must still name `Card`
    // (via `targetName`'s `valueImportBinding` fallback), not "dynamic tag" —
    // an author reading this error wrote `<Card>`, never `<${...}>`.
    expect(() =>
      compileSource(
        'import Card from "./compile-callee"\n<Card><@header/><@header/></Card>\n',
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).toThrowError("`<@header>` may appear at most once");
  });

  it("decision 116: an authored dynamic tag stays untyped (no valueImportBinding to resolve)", () => {
    // An author's own `<${Card}/>` is `kind: "dynamic"` with no
    // `valueImportBinding` — decision 116 only sets that provenance flag for
    // its own synthesized routing, never for hand-written dynamic-tag
    // syntax. `readCalleeInput` must fall back to `{ kind: "none" }`
    // (untyped) exactly as before, so an over-repeated declared singular
    // tag is *not* rejected here — there is no way to know `Card`'s Input
    // for an arbitrary expression.
    let lowered: Ir | undefined;
    expect(() =>
      compileSource(
        [
          'import Card from "./compile-callee"',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko syntax.
          "<${Card}><@header/><@header/></${Card}>",
        ].join("\n"),
        CALLER,
        { ...declarations(), attrTags: 2 },
        {
          targets: lookup,
          emitIr: (ir) => {
            lowered = ir;
            return "";
          },
        },
      ),
    ).not.toThrow();
    const component = lowered?.body.find((node) => node.kind === "Component");
    expect(component).toMatchObject({
      kind: "Component",
      target: { kind: "dynamic" },
    });
  });

  it("reports a discovered callee's own bad config once as a per-tag error", () => {
    const path = fixture("bad-own-config.mx");
    const source = fixtureSource("bad-own-config.mx");
    expect(() =>
      compileSource(
        "<bad-cfg><@x/></bad-cfg>\n",
        CALLER,
        {
          ...declarations(),
          attrTags: 2,
        },
        {
          targets: lookup,
          emitIr: () => "",
          customTags: {
            "bad-cfg": {
              template: {
                filename: path,
                source,
                mtimeMs: statSync(path).mtimeMs,
              },
            } as CustomTag,
          },
        },
      ),
    ).toThrowError(
      `can't read \`<bad-cfg>\`'s declaration of \`x\` (${path}:1); declare this attribute tag's config literally`,
    );
  });

  it("compile uses the current unit's own Input for data-tag rendering", () => {
    expect(() =>
      compileSource(
        [
          'export interface Input { x?: AttrTag<{ as: "data" }> }',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko syntax.
          "<${input.x}/>",
        ].join("\n"),
        CALLER,
        { ...declarations(), attrTags: 2 },
        { targets: lookup, emitIr: () => "" },
      ),
    ).toThrowError(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko syntax.
      "render its body with `<${input.x.content}/>`",
    );
  });
});

describe("calleeReturnsValue", () => {
  const withFiles = (
    files: Record<string, string>,
    specifiers: [string, string][],
    run: (ctx: ReturnType<typeof newCtx>) => void,
  ) => {
    const directory = mkdtempSync(join(tmpdir(), "mx-callee-returns-"));
    try {
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(directory, name), text);
      }
      resetTemplateCache();
      const ctx = newCtx(
        "",
        printExpression,
        declarations(),
        undefined,
        join(directory, "caller.mx"),
        lookup,
      );
      ctx.importSpecifiers = new Map(specifiers);
      run(ctx);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const target = { kind: "name", name: "Counter" } as const;
  const returning = "<span>x</span>\n<return value=1/>\n";

  it("is true for an imported .mx unit that declares <return>", () => {
    withFiles(
      { "counter.mx": returning },
      [["Counter", "./counter.mx"]],
      (ctx) => expect(calleeReturnsValue(target, ctx)).toBe(true),
    );
  });

  it("is false for an imported .mx unit without <return>", () => {
    withFiles(
      { "counter.mx": "<span>x</span>\n" },
      [["Counter", "./counter.mx"]],
      (ctx) => expect(calleeReturnsValue(target, ctx)).toBe(false),
    );
  });

  it("is false for a .ts callee and for a barrel re-exporting a .mx", () => {
    withFiles(
      {
        "counter.mx": returning,
        "barrel.ts": 'export { default as Counter } from "./counter.mx";\n',
        "plain.ts": "export default function Counter() { return 1; }\n",
      },
      [["Counter", "./barrel.ts"]],
      (ctx) => {
        expect(calleeReturnsValue(target, ctx)).toBe(false);
        ctx.importSpecifiers = new Map([["Counter", "./plain.ts"]]);
        expect(calleeReturnsValue(target, ctx)).toBe(false);
      },
    );
  });

  it("is false for an unresolved specifier, a missing binding and a dynamic target", () => {
    withFiles({}, [["Counter", "./missing.mx"]], (ctx) => {
      expect(calleeReturnsValue(target, ctx)).toBe(false);
      expect(calleeReturnsValue({ kind: "name", name: "Other" }, ctx)).toBe(
        false,
      );
      expect(
        calleeReturnsValue(
          { kind: "dynamic", expr: { code: "x" } } as never,
          ctx,
        ),
      ).toBe(false);
    });
  });

  it("is false for a callee that does not compile, leaving the error to readCalleeInput", () => {
    withFiles(
      { "counter.mx": "<if=>\n" },
      [["Counter", "./counter.mx"]],
      (ctx) => expect(calleeReturnsValue(target, ctx)).toBe(false),
    );
  });
});
