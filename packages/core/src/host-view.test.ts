/**
 * `hostTagViewOf` / `hostAttributeViewOf` (ast §6.4; decision 197, PR 6
 * slice S4 groundwork): the plain-data view the hooks move to.
 *
 * Differential against the Marko-shaped view every hook receives today
 * (`markoViewOf`): each input is compiled through `compileSource` with a
 * host that records, at hook time, both the Marko-shaped view and the new
 * view of the node behind it, and every field a host reads today must say
 * the same thing on both (ast §6.4's field table): the name, the range
 * (`loc.start.index`/`loc.end.index` vs `span`), the attributes after the
 * name-sugar rewrite (name, modifier, range, value), the tag variable, the
 * attribute tags, the params and the dynamic name. An attribute's
 * `nameSpan` has no Marko counterpart: it is checked against the IR's
 * `Attr.nameSpan`, which lowering computes by the same rule. What either
 * side cannot give (a shorthand record's range, a `<foo-${bar}>` name) is
 * pinned exactly below.
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
  type HostSpan,
  type HostSpreadView,
  type HostTagView,
  hostAttributeViewOf,
  hostTagViewOf,
} from "./host-view.ts";
import type { Ir } from "./ir.ts";
import { exprOf, lowerChildren } from "./lower.ts";
import { mxNodeOf } from "./marko-view.ts";
import { tagNameOf, tagVarOf } from "./tag-fields.ts";
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

function compile(
  source: string,
  decls: HostDeclarations,
  onIr?: (ir: Ir) => void,
): unknown {
  try {
    compileSource(source, FILE, decls, {
      targets: lookup,
      emitIr: (ir) => {
        onIr?.(ir);
        return "";
      },
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A Marko node's `[start, end]` offsets, from its `loc` or its own fields. */
function markoRange(ctx: Ctx, node: Node): [unknown, unknown] {
  return [
    node.loc?.start?.index ??
      node.start ??
      lineColumnOffset(ctx, node.loc?.start),
    node.loc?.end?.index ?? node.end ?? lineColumnOffset(ctx, node.loc?.end),
  ];
}

/** What a host reads off the Marko-shaped view of a tag, as plain data. */
function markoTag(ctx: Ctx, view: Node): unknown {
  const dynamic = view.name?.type !== "StringLiteral";
  return {
    name: dynamic ? "" : view.name.value,
    span: markoRange(ctx, view),
    // A `${"a"}` name carries a line/column `loc` and no offsets.
    nameSpan: markoRange(ctx, view.name),
    attributes: view.attributes.map((attr: Node) => markoAttribute(ctx, attr)),
    var: view.var ? [view.var.start, view.var.end] : null,
    attributeTags: view.attributeTags.map((tag: Node) => [
      tag.name.value,
      tag.loc.start.index,
      tag.loc.end.index,
    ]),
    // Marko lists no params for `<x||>` as for `<x>`; the view's
    // `{ count: 0 }` for the first is pinned in the contract tests.
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

/**
 * A shorthand's record (`<x.a#b>`'s merged `class`, its `id`, a sugar's
 * default value) has no position on the Marko-shaped view; the new view
 * reports it at its shorthand text, pinned exactly in "shorthand records".
 */
const POSITIONLESS = "positionless";

function markoAttribute(ctx: Ctx, attr: Node): unknown {
  const span =
    attr.loc != null || typeof attr.start === "number"
      ? markoRange(ctx, attr)
      : POSITIONLESS;
  if (attr.type === "MarkoSpreadAttribute") {
    return { kind: "spread", span, value: exprOf(ctx, attr.value).code };
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
    span,
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
    span: [view.span.start, view.span.end],
    nameSpan: [view.nameSpan.start, view.nameSpan.end],
    attributes: view.attributes.map(hostAttribute),
    var: view.var ? [view.var.span.start, view.var.span.end] : null,
    attributeTags: view.attributeTags.map((tag) => [
      tag.name,
      tag.span.start,
      tag.span.end,
    ]),
    params: view.params?.count
      ? [view.params.count, view.params.span.start, view.params.span.end]
      : null,
    dynamicName: view.dynamicName?.code ?? null,
  };
}

function hostAttribute(entry: HostAttributeView | HostSpreadView): unknown {
  const node = handleNode(entry);
  const span =
    node.loc != null || typeof node.start === "number"
      ? [entry.span.start, entry.span.end]
      : POSITIONLESS;
  if (entry.kind === "spread") {
    return { kind: "spread", span, value: entry.value.code };
  }
  return {
    kind: "attribute",
    name: entry.name,
    modifier: entry.modifier,
    span,
    value: entry.value?.code,
  };
}

type Pair = [unknown, unknown];

interface Claimed {
  pairs: Pair[];
  /** Each claimed tag's attribute `nameSpan`s, on the view and in the IR. */
  nameSpans: Pair[];
}

/**
 * Claims every tag in `names` and records both views at
 * `resolveDelegatedTag`. A compile error fails the test unless it matches
 * `expected`.
 */
function claimed(source: string, names: string[], expected?: RegExp): Claimed {
  const pairs: Pair[] = [];
  const views: HostTagView[] = [];
  const delegated: Node[] = [];
  const error = compile(
    source,
    declarations({
      resolveDefaultTag: () => "claim",
      isDelegatedTag: (name) => names.includes(name),
      resolveDelegatedTag(name, node, ctx) {
        const view = hostTagViewOf(ctx, mxNodeOf(node));
        views.push(view);
        pairs.push([markoTag(ctx, node), hostTag(view)]);
        return { name };
      },
    }),
    (ir) => collectDelegated(ir.body, delegated),
  );
  if (error && !(expected && String(error).match(expected))) throw error;
  if (expected) expect(error).toBeTruthy();
  const nameSpans: Pair[] = error
    ? []
    : views.map((view) => {
        const lowered = delegated.find(
          (tag) => tag.span?.sourceStart === view.span.start,
        );
        return [
          view.attributes.flatMap((entry) =>
            entry.kind === "spread"
              ? []
              : [[entry.nameSpan.start, entry.nameSpan.end]],
          ),
          lowered?.attrs.flatMap((attr: Node) =>
            attr.kind === "spread"
              ? []
              : [[attr.nameSpan?.sourceStart, attr.nameSpan?.sourceEnd]],
          ),
        ];
      });
  return { pairs, nameSpans };
}

/** Every `DelegatedTag`'s `tag` in the IR, at any depth. */
function collectDelegated(node: unknown, into: Node[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectDelegated(child, into);
    return;
  }
  const record = node as Node;
  if (record.kind === "DelegatedTag" && record.tag) into.push(record.tag);
  for (const value of Object.values(record)) collectDelegated(value, into);
}

const TAG_INPUTS: [string, string, string[], RegExp?][] = [
  [
    "static, var, attributes",
    `<claim/v a=1 class="c">body</claim>\n`,
    ["claim"],
  ],
  ["default value and modifier", `<claim=1 b:mod=x c/>\n`, ["claim"]],
  ["spread first", `<claim ...rest d=2/>\n`, ["claim"]],
  ["bound attribute", `<claim value:=x/>\n`, ["claim"]],
  ["shorthand class and id", `<claim.a.b#main e=1/>\n`, ["claim"]],
  ["spaced shorthand class and id", `<claim .big #main e=1/>\n`, ["claim"]],
  ["name sugar", `<claim:email type="email"/>\n`, ["claim"]],
  [
    "destructured var with a type",
    `<claim/{ a: input, b }: T=1/>\n`,
    ["claim"],
  ],
  ["params", `<claim|x, y|>\${x}</claim>\n`, ["claim"]],
  [
    "params, spaced inside the pipes",
    `<claim|  x, y  |>\${x}</claim>\n`,
    ["claim"],
  ],
  ["one spaced param", `<claim| x |>\${x}</claim>\n`, ["claim"]],
  ["params over lines", `<claim|\n  x,\n  y\n|>\${x}</claim>\n`, ["claim"]],
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
  [
    "else-if and else holding an attribute tag",
    `<claim>\n  <if=x><@a/></if><else-if=y><@b/></else-if><else><@c/></else>\n</claim>\n`,
    ["claim"],
  ],
  [
    "while holding an attribute tag (recorded before lowering rejects it)",
    `<claim>\n  <while=x><@d/></while>\n</claim>\n`,
    ["claim"],
    /attribute tag `@d` on `<while>`/,
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
  it.each(TAG_INPUTS)("%s", (_, source, names, expected) => {
    const { pairs } = claimed(source, names, expected);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [marko, host] of pairs) expect(host).toEqual(marko);
  });
});

describe("an attribute's nameSpan is lowering's Attr.nameSpan", () => {
  it.each(TAG_INPUTS.filter(([, , , expected]) => !expected))(
    "%s",
    (_, source, names) => {
      const { nameSpans } = claimed(source, names);
      expect(nameSpans.length).toBeGreaterThan(0);
      for (const [host, lowered] of nameSpans) expect(host).toEqual(lowered);
    },
  );
});

describe("hostAttributeViewOf at the attribute hooks", () => {
  it("rejectModifier: same name, modifier and range", () => {
    const source = "<p>x</p>\n<div class:active=on/>\n";
    const seen: Pair[] = [];
    const ctx: Ctx = newCtx(
      source,
      printExpression,
      declarations({
        rejectModifier(attr) {
          const div = body.find((node) => tagNameOf(node) === "div");
          const entry = hostAttributeViewOf(ctx, mxNodeOf(attr), div);
          seen.push([markoAttribute(ctx, attr), hostAttribute(entry)]);
          expect(entry.kind === "attribute" && entry.nameSpan).toEqual({
            start: 14,
            end: 26,
          });
        },
      }),
      undefined,
      FILE,
      lookup,
    );
    const body = parseFragment(source).body;
    expect(() => lowerChildren(ctx, body)).toThrow(/class:active/);
    expect(seen.length).toBe(1);
    for (const [marko, host] of seen) expect(host).toEqual(marko);
  });
});

/** The view of the first tag `resolveDelegatedTag` meets, claiming `names`. */
function view(
  source: string,
  names: string[] = ["claim"],
): { ctx: Ctx; view: HostTagView } {
  let found: { ctx: Ctx; view: HostTagView } | undefined;
  compile(
    source,
    declarations({
      isDelegatedTag: (name) => names.includes(name),
      resolveDelegatedTag(name, node, ctx) {
        found ??= { ctx, view: hostTagViewOf(ctx, mxNodeOf(node)) };
        return { name };
      },
    }),
  );
  if (!found) throw new Error("not reached");
  return found;
}

/** `[start, end, text]`: a span and the source it covers. */
function sliced(source: string, span: HostSpan): [number, number, string] {
  return [span.start, span.end, source.slice(span.start, span.end)];
}

describe("the view's contract", () => {
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

describe("positions the Marko-shaped view cannot give", () => {
  it.each([
    [
      "a static class and id",
      `<claim.a.b#main e=1/>\n`,
      [
        ["class", 6, 10, ".a.b"],
        ["id", 10, 15, "#main"],
      ],
    ],
    [
      "spaced",
      `<claim .big #main/>\n`,
      [
        ["class", 7, 11, ".big"],
        ["id", 12, 17, "#main"],
      ],
    ],
    [
      "a class with a placeholder after text",
      `<p>a</p>\n<claim.bar\${x} e=1/>\n`,
      [["class", 15, 23, `.bar\${x}`]],
    ],
    [
      "an id with text after a placeholder",
      `<claim#\${x}-bar/>\n`,
      [["id", 6, 15, `#\${x}-bar`]],
    ],
    [
      "a class whose second token is a placeholder",
      `<claim.a.\${x}/>\n`,
      [["class", 6, 13, `.a.\${x}`]],
    ],
  ])(
    "a shorthand record reports at its shorthand text: %s",
    (_, source, expected) => {
      const { view: tag } = view(source);
      const shorthands = tag.attributes.filter(
        (entry): entry is HostAttributeView =>
          entry.kind === "attribute" &&
          (entry.name === "class" || entry.name === "id"),
      );
      expect(
        shorthands.map((entry) => [entry.name, ...sliced(source, entry.span)]),
      ).toEqual(expected);
      for (const entry of shorthands)
        expect(entry.nameSpan).toEqual(entry.span);
    },
  );

  it.each([
    [
      "the head through the modifier",
      `<claim b:mod=x/>\n`,
      "b",
      [7, 12, "b:mod"],
    ],
    [
      "a shorthand's sigil and token",
      `<claim.big/>\n`,
      "class",
      [6, 10, ".big"],
    ],
    ["a name sugar's token", `<claim:email/>\n`, "name", [6, 12, ":email"]],
    ["empty at a default value's `=`", `<claim=1 c/>\n`, "value", [6, 6, ""]],
  ])("an attribute's nameSpan: %s", (_, source, name, expected) => {
    const { view: tag } = view(source);
    const entry = tag.attributes.find(
      (attr): attr is HostAttributeView =>
        attr.kind === "attribute" && attr.name === name,
    );
    expect(entry && sliced(source, entry.nameSpan)).toEqual(expected);
  });

  it("a default value's empty nameSpan sits on its `=`", () => {
    const source = `<claim=1/>\n`;
    const [entry] = view(source).view.attributes as HostAttributeView[];
    expect(source[entry?.nameSpan.start ?? -1]).toBe("=");
  });

  it.each([
    ["no params between the pipes", `<claim||></claim>\n`, 0, [7, 7, ""]],
    ["only space between the pipes", `<claim| |></claim>\n`, 0, [7, 7, ""]],
    ["one param, spaced", `<claim| x |>\${x}</claim>\n`, 1, [8, 9, "x"]],
    ["params, spaced", `<claim|  x, y  |>\${x}</claim>\n`, 2, [9, 13, "x, y"]],
    [
      "params over lines",
      `<claim|\n  x,\n  y\n|>\${x}</claim>\n`,
      2,
      [10, 16, "x,\n  y"],
    ],
    [
      "a pattern, a type and a default",
      `<claim|{ a }: T, b = 1|>\${a}</claim>\n`,
      2,
      [7, 22, "{ a }: T, b = 1"],
    ],
  ])(
    "params run from the first param to the last: %s",
    (_, source, count, expected) => {
      const { params } = view(source).view;
      expect(params?.count).toBe(count);
      expect(params && sliced(source, params.span)).toEqual(expected);
    },
  );

  it("an attribute tag's params, on its own view", () => {
    const source = `<claim><@a| item |>\${item}</@a></claim>\n`;
    const { ctx, view: tag } = view(source);
    const node = (handleNode(tag) as Node).body.find(
      (child: Node) => child.type === "MxAttributeTag",
    );
    const { params } = hostTagViewOf(ctx, node);
    expect(params?.count).toBe(1);
    expect(params && sliced(source, params.span)).toEqual([12, 16, "item"]);
  });

  it("a module statement's nameSpan is its keyword", () => {
    const source = "server const x = 1;\n";
    const { view: statement } = view(source, ["server"]);
    expect(statement.name).toBe("server");
    expect(sliced(source, statement.nameSpan)).toEqual([0, 6, "server"]);
    expect(sliced(source, statement.span)).toEqual([
      0,
      19,
      "server const x = 1;",
    ]);
  });

  it("a name mixing text and a placeholder: nameSpan is the whole name", () => {
    const source = `<foo-\${bar} a=1/>\n`;
    const { view: tag } = view(source, [DYNAMIC_TAG]);
    expect(tag.name).toBe("");
    expect(sliced(source, tag.nameSpan)).toEqual([1, 11, `foo-\${bar}`]);
    expect(tag.dynamicName?.code).toBe(`\`foo-\${bar}\``);
  });
});

describe("bindingSpan", () => {
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
      const { ctx, view: tag } = view(source);
      const span = bindingSpan(tag, "input");
      expect(span).not.toBe(null);
      expect(ctx.source.slice(span?.start, span?.end)).toBe("input");
      expect(bindingSpan(tag.handle, "input")).toEqual(span);
    },
  );

  it("null when the pattern binds no such name, or there is no var", () => {
    expect(bindingSpan(view("<claim/{ a: b }=1/>\n").view, "a")).toBe(null);
    expect(bindingSpan(view("<claim a=1/>\n").view, "input")).toBe(null);
  });

  it("takes the Babel pattern checkBinding receives", () => {
    const source = "<p>é</p>\n<const/{ q: input }=1/>\n";
    const targets: Node[] = [];
    const error = compile(
      source,
      declarations({ checkBinding: (target) => void targets.push(target) }),
    );
    expect(error).toBe(undefined);
    expect(targets).toHaveLength(1);
    const span = bindingSpan(targets[0], "input");
    expect(span && sliced(source, span)).toEqual([21, 26, "input"]);
  });

  it("takes a tag variable's pattern, as tagVarOf reads it off the handle", () => {
    const { ctx, view: tag } = view("<claim/[b, input]=1/>\n");
    const span = bindingSpan(tagVarOf(handleNode(tag) as Node), "input");
    expect(span && sliced(ctx.source, span)).toEqual([11, 16, "input"]);
    expect(bindingSpan(tag, "input")).toEqual(span);
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
