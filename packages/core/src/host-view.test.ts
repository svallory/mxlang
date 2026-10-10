/**
 * `hostTagViewOf` / `hostAttributeViewOf` (ast §6.4; decision 197, PR 6
 * slice S4 groundwork): the plain-data view the hooks move to.
 *
 * Differential against the Marko-shaped view every hook receives today
 * (`markoViewOf`): each input is compiled through `compileSource` with a
 * host that records, at hook time, both the Marko-shaped view and the new
 * view of the node behind it, and every field a host reads today must say
 * the same thing on both (ast §6.4's field table): the name, the reporting
 * position (`loc.start.index` vs `span.start`), the attributes after the
 * name-sugar rewrite (name, modifier, value), the tag variable, the
 * attribute tags, the params count and the dynamic name.
 */
import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import {
  type Ctx,
  DYNAMIC_TAG,
  fail,
  type Node,
  newCtx,
  rejectUnsupportedFields,
  TranslateError,
} from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { resolveUnnamedTags } from "./default-tag.ts";
import { parseFragment } from "./fragment.ts";
import { handleNode } from "./host-handle.ts";
import {
  bindingSpan,
  type HostAttributeView,
  type HostSpreadView,
  type HostTagView,
  hostAttributeViewOf,
  hostTagViewOf,
} from "./host-view.ts";
import { exprOf } from "./lower.ts";
import { mxNodeOf } from "./marko-view.ts";
import { lookup } from "./test-targets.ts";

const FILE = "/tmp/mx-core-test/host-view.mx";

function declarations(
  overrides: Partial<HostDeclarations> = {},
): HostDeclarations {
  return {
    tags: {},
    attrTags: 2,
    isElement: (name) => /^[a-z]/.test(name),
    isComponent: (name, ctx) => ctx.defines.has(name),
    ...overrides,
  };
}

function compile(source: string, decls: HostDeclarations): unknown {
  try {
    compileSource(source, FILE, decls, {
      targets: lookup,
      emitIr: () => "",
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** What a host reads off the Marko-shaped view of a tag, as plain data. */
function markoTag(ctx: Ctx, view: Node): unknown {
  const dynamic = view.name?.type !== "StringLiteral";
  return {
    name: dynamic ? "" : view.name.value,
    at: view.loc.start.index,
    // A `${"a"}` name carries a line/column `loc` and no offsets.
    nameSpan: [
      view.name.start ?? lineColumnOffset(ctx, view.name.loc?.start),
      view.name.end ?? lineColumnOffset(ctx, view.name.loc?.end),
    ],
    attributes: view.attributes.map((attr: Node) => markoAttribute(ctx, attr)),
    var: view.var ? [view.var.start, view.var.end] : null,
    attributeTags: view.attributeTags.map((tag: Node) => [
      tag.name.value,
      tag.loc.start.index,
    ]),
    params: view.body.params?.length
      ? [
          view.body.params.length,
          view.body.params[0].start,
          view.body.params.at(-1).end,
        ]
      : null,
    dynamicName: dynamic ? exprOf(ctx, view.name).code : null,
  };
}

function markoAttribute(ctx: Ctx, attr: Node): unknown {
  // A shorthand's record has no position on the Marko-shaped view; the new
  // view reports it at its value (the shorthand's text).
  const at =
    attr.loc?.start?.index ??
    attr.start ??
    lineColumnOffset(ctx, attr.value?.loc?.start);
  if (attr.type === "MarkoSpreadAttribute") {
    return { kind: "spread", at, value: exprOf(ctx, attr.value).code };
  }
  const synthesizedTrue =
    attr.value?.type === "BooleanLiteral" &&
    attr.value.value === true &&
    attr.value.start == null &&
    attr.value.loc == null;
  return {
    kind: "attribute",
    name: attr.name,
    modifier: attr.modifier ?? null,
    at,
    value: synthesizedTrue ? undefined : exprOf(ctx, attr.value).code,
  };
}

/** The offset of a 1-based line, 0-based column, read off `ctx.source`. */
function lineColumnOffset(
  ctx: Ctx,
  at: { line: number; column: number } | undefined,
): number | undefined {
  if (!at) return undefined;
  const lines = ctx.source.split("\n");
  let offset = 0;
  for (let line = 1; line < at.line; line++) {
    offset += (lines[line - 1]?.length ?? 0) + 1;
  }
  return offset + at.column;
}

/** The same reads off the new view. */
function hostTag(view: HostTagView): unknown {
  return {
    name: view.name,
    at: view.span.start,
    nameSpan: [view.nameSpan.start, view.nameSpan.end],
    attributes: view.attributes.map(hostAttribute),
    var: view.var ? [view.var.span.start, view.var.span.end] : null,
    attributeTags: view.attributeTags.map((tag) => [tag.name, tag.span.start]),
    params: view.params
      ? [view.params.count, view.params.span.start, view.params.span.end]
      : null,
    dynamicName: view.dynamicName?.code ?? null,
  };
}

function hostAttribute(entry: HostAttributeView | HostSpreadView): unknown {
  if (entry.kind === "spread") {
    return { kind: "spread", at: entry.span.start, value: entry.value.code };
  }
  return {
    kind: "attribute",
    name: entry.name,
    modifier: entry.modifier,
    at: entry.span.start,
    value: entry.value?.code,
  };
}

type Pair = [unknown, unknown];

/** Claims every tag in `names` and records both views at `resolveDelegatedTag`. */
function claimed(source: string, names: string[]): Pair[] {
  const pairs: Pair[] = [];
  const error = compile(
    source,
    declarations({
      resolveDefaultTag: () => "claim",
      isDelegatedTag: (name) => names.includes(name),
      resolveDelegatedTag(name, node, ctx) {
        const view = hostTagViewOf(ctx, mxNodeOf(node));
        pairs.push([markoTag(ctx, node), hostTag(view)]);
        return { name };
      },
    }),
  );
  if (error) throw error;
  return pairs;
}

const TAG_INPUTS: [string, string, string[]][] = [
  [
    "static, var, attributes",
    `<claim/v a=1 class="c">body</claim>\n`,
    ["claim"],
  ],
  ["default value and modifier", `<claim=1 b:mod=x c/>\n`, ["claim"]],
  ["spread first", `<claim ...rest d=2/>\n`, ["claim"]],
  ["bound attribute", `<claim value:=x/>\n`, ["claim"]],
  ["shorthand class and id", `<claim.a.b#main e=1/>\n`, ["claim"]],
  ["name sugar", `<claim:email type="email"/>\n`, ["claim"]],
  [
    "destructured var with a type",
    `<claim/{ a: input, b }: T=1/>\n`,
    ["claim"],
  ],
  ["params", `<claim|x, y|>\${x}</claim>\n`, ["claim"]],
  [
    "params with a pattern, a type and a default",
    `<claim|{ a }: T, b = 1|>\${a}</claim>\n`,
    ["claim"],
  ],
  ["unnamed, resolved to the default tag", `<p><.a x=1/></p>\n`, ["claim"]],
  ["attribute tags", `<claim><@a>1</@a><@b x=1/></claim>\n`, ["claim"]],
  [
    "control flow holding an attribute tag",
    `<claim>\n  <if=x><@a/></if>\n  <for|i| of=list><@b/></for>\n</claim>\n`,
    ["claim"],
  ],
  ["dynamic tag", `<\${Comp} x=2>y</>\n`, [DYNAMIC_TAG]],
  [
    "atom name: static, as on Marko's tree",
    `<\${:widget} b=1/>x\n`,
    ["widget"],
  ],
  [
    "string name: a template literal, still dynamic",
    `<\${"lit"} b=1/>\n`,
    [DYNAMIC_TAG],
  ],
  ["concise", `claim/v a=1\n  -- text\n`, ["claim"]],
  ["unicode before", `<p>é😀</p>\n<claim a="é"/>\n`, ["claim"]],
];

describe("hostTagViewOf agrees with the Marko-shaped view", () => {
  it.each(TAG_INPUTS)("%s", (_, source, names) => {
    const pairs = claimed(source, names);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [marko, host] of pairs) expect(host).toEqual(marko);
  });
});

describe("hostAttributeViewOf at the attribute hooks", () => {
  it("rejectModifier: same name, modifier and position", () => {
    const seen: Pair[] = [];
    compile(
      "<p>x</p>\n<div class:active=on/>\n",
      declarations({
        rejectModifier(attr) {
          const entry = hostAttributeViewOf(currentCtx as Ctx, mxNodeOf(attr));
          seen.push([
            markoAttribute(currentCtx as Ctx, attr),
            hostAttribute(entry),
          ]);
          return undefined;
        },
        resolveDelegatedTag: () => undefined,
        isDelegatedTag(_, ctx) {
          currentCtx = ctx;
          return false;
        },
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const [marko, host] of seen) expect(host).toEqual(marko);
  });
});

let currentCtx: Ctx | undefined;

describe("the view's contract", () => {
  function view(source: string): { ctx: Ctx; view: HostTagView } {
    let found: { ctx: Ctx; view: HostTagView } | undefined;
    compile(
      source,
      declarations({
        isDelegatedTag: (name) => name === "claim",
        resolveDelegatedTag(name, node, ctx) {
          found = { ctx, view: hostTagViewOf(ctx, mxNodeOf(node)) };
          return { name };
        },
      }),
    );
    if (!found) throw new Error("not reached");
    return found;
  }

  it("is frozen, cached per node and Ctx, and its handle has no fields", () => {
    const { ctx, view: tag } = view(`<claim a=1/>\n`);
    expect(Object.isFrozen(tag)).toBe(true);
    expect(Object.isFrozen(tag.attributes)).toBe(true);
    expect(hostTagViewOf(ctx, handleNode(tag))).toBe(tag);
    expect(Object.keys(tag.handle)).toEqual([]);
    expect(JSON.stringify(tag.handle)).toBe("{}");
    expect(Object.getPrototypeOf(tag.handle)).toBe(null);
  });

  it("has a span and no loc, so `fail` reports at span.start", () => {
    const { ctx, view: tag } = view(`<p></p>\n<div><claim a=1/></div>\n`);
    expect("loc" in tag).toBe(false);
    let error: unknown;
    try {
      fail("boom", tag);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(TranslateError);
    expect((error as TranslateError).span).toEqual({
      sourceStart: tag.span.start,
      sourceEnd: tag.span.end,
    });
    expect(ctx.source.slice(tag.span.start, tag.span.start + 6)).toBe("<claim");
  });

  it("a valueless attribute has no value; a default value is named value", () => {
    const { view: tag } = view(`<claim=1 flag/>\n`);
    const [first, second] = tag.attributes as HostAttributeView[];
    expect(first?.name).toBe("value");
    expect(first?.value?.code).toBe("1");
    expect(second?.name).toBe("flag");
    expect(second && "value" in second).toBe(false);
  });

  it("an unnamed tag's name is read through, not memoized: '' until resolveDefaultTag answers", () => {
    const source = "<.a x=1/>\n";
    const ctx = newCtx(
      source,
      printExpression,
      declarations({ resolveDefaultTag: () => "section" }),
      undefined,
      FILE,
      lookup,
    );
    const [node] = parseFragment(source).body;
    const tag = hostTagViewOf(ctx, node);
    expect(tag.name).toBe("");
    expect(tag.nameSpan).toEqual({ start: 1, end: 1 });
    resolveUnnamedTags(ctx, [node]);
    expect(tag.name).toBe("section");
    expect(hostTagViewOf(ctx, node)).toBe(tag);
    expect(tag.nameSpan).toEqual({ start: 1, end: 1 });
  });

  it("no var, no params, no attribute tags: null, null, []", () => {
    const { view: tag } = view(`<claim/>\n`);
    expect(tag.var).toBe(null);
    expect(tag.params).toBe(null);
    expect(tag.attributeTags).toEqual([]);
    expect(tag.dynamicName).toBe(null);
  });
});

describe("bindingSpan", () => {
  function varView(source: string): { ctx: Ctx; view: HostTagView } {
    let found: { ctx: Ctx; view: HostTagView } | undefined;
    compile(
      source,
      declarations({
        isDelegatedTag: (name) => name === "claim",
        resolveDelegatedTag(name, node, ctx) {
          found = { ctx, view: hostTagViewOf(ctx, mxNodeOf(node)) };
          return { name };
        },
      }),
    );
    if (!found) throw new Error("not reached");
    return found;
  }

  it.each([
    ["an identifier", "<claim/input=1/>\n", "input"],
    ["a renamed property", "<claim/{ a: input }=1/>\n", "input"],
    ["a shorthand property", "<claim/{ input }=1/>\n", "input"],
    ["an object rest", "<claim/{ a, ...input }=1/>\n", "input"],
    ["an array element after a hole", "<claim/[, input]=1/>\n", "input"],
    ["a default", "<claim/{ input = 2 }=1/>\n", "input"],
    ["an array rest", "<claim/[a, ...input]=1/>\n", "input"],
  ])(
    "finds the binding in %s, through the view and its handle",
    (_, source) => {
      const { ctx, view: tag } = varView(source);
      const span = bindingSpan(tag, "input");
      expect(span).not.toBe(null);
      expect(ctx.source.slice(span?.start, span?.end)).toBe("input");
      expect(bindingSpan(tag.handle, "input")).toEqual(span);
    },
  );

  it("null when the pattern binds no such name, or there is no var", () => {
    expect(bindingSpan(varView("<claim/{ a: b }=1/>\n").view, "a")).toBe(null);
    expect(bindingSpan(varView("<claim a=1/>\n").view, "input")).toBe(null);
  });

  it("takes a Babel pattern payload too (checkBinding's argument)", () => {
    const { ctx, view: tag } = varView("<claim/[b, input]=1/>\n");
    const pattern = (handleNode(tag) as Node).var;
    expect(pattern).toBeTruthy();
    const span = bindingSpan(tag, "input");
    expect(ctx.source.slice(span?.start, span?.end)).toBe("input");
  });
});

describe("core helpers resolve a host view like the Marko-shaped one", () => {
  /** The error `check` throws when handed `pick(markoView, hostView)`. */
  function errorWith(
    source: string,
    pick: (marko: Node, host: HostTagView) => unknown,
  ): unknown {
    const error = compile(
      source,
      declarations({
        isDelegatedTag: (name) => name === "claim",
        resolveDelegatedTag(_, node, ctx) {
          rejectUnsupportedFields(
            ctx,
            pick(node, hostTagViewOf(ctx, mxNodeOf(node))),
            "`<claim>`",
          );
          return { name: "claim" };
        },
      }),
    );
    expect(error).toBeInstanceOf(TranslateError);
    const { message, line, column } = error as TranslateError;
    return { message, line, column };
  }

  it.each([
    ["a tag variable", "<p/>\n<claim/v=1/>\n"],
    ["an attribute tag", "<claim><@a/></claim>\n"],
    ["arguments", "<claim(1, 2)/>\n"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    ["params", "<claim|x|>${x}</claim>\n"],
  ])("rejectUnsupportedFields: %s", (_, source) => {
    expect(errorWith(source, (_marko, host) => host)).toEqual(
      errorWith(source, (marko) => marko),
    );
    expect(errorWith(source, (_marko, host) => host.handle)).toEqual(
      errorWith(source, (marko) => marko),
    );
  });
});
