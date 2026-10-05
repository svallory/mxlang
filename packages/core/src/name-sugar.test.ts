// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { type Ctx, type MxWarning, type Node, newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
import {
  isShorthandWord,
  SHORTHAND_CACHE_LIMIT,
  shorthandCacheSize,
  sugarTagName,
} from "./name-sugar.ts";
import { lookup } from "./test-targets.ts";

/**
 * Decision 146: `:name`, `#id` and `.class` sugar, at the IR core hands a
 * host. Every row lowers through Marko's real parse, then `lower`.
 *
 * The rewrite turns the sugar into the attributes the author would have
 * written without it, so most rows compare the resulting attribute list; the
 * span rows pin where each token is reported.
 */

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    resolveDefaultTag: () => "input",
    ...overrides,
  };
}

function lowerSource(
  source: string,
  declarations: Policy = policy(),
  warnings?: MxWarning[],
): Ir {
  let ir: Ir | null = null;
  let thrown: unknown = null;
  const translator = {
    taglibs: [] as Array<[string, unknown]>,
    tagDiscoveryDirs: [] as string[],
    translate: {
      Program: {
        exit(path: { node: { body: Node[] } }) {
          const ctx: Ctx = newCtx(
            source,
            printExpression,
            declarations,
            undefined,
            "test.mx",
            lookup,
          );
          if (warnings) ctx.warnings = warnings;
          try {
            ir = lower(ctx, path.node.body);
          } catch (error) {
            thrown = error;
          }
          path.node.body = [];
        },
      },
    },
  };
  createRequire(import.meta.url)("@marko/compiler").compileSync(
    source,
    "/tmp/mx-core-test/sugar.mx",
    { translator, output: "html", writeVersionComment: false },
  );
  if (thrown) throw thrown;
  if (!ir) throw new Error("no IR");
  return ir;
}

function elements(
  nodes: readonly IrNode[],
): Array<IrNode & { kind: "Element" }> {
  const found: Array<IrNode & { kind: "Element" }> = [];
  const walk = (list: readonly IrNode[]) => {
    for (const node of list) {
      if (node.kind === "Element") found.push(node);
      const children = (node as { children?: IrNode[] }).children;
      if (children) walk(children);
    }
  };
  walk(nodes);
  return found;
}

function describeAttr(attr: Attr): string {
  switch (attr.kind) {
    case "static":
      return `${attr.name}=${JSON.stringify(attr.value)}`;
    case "boolean":
      return attr.name;
    case "spread":
      return `...${attr.value.code}`;
    default:
      return `${attr.name}=<${attr.value.code}>`;
  }
}

/** The first element's tag and attributes, as one comparable string. */
function shape(source: string, declarations?: Policy): string {
  const [element] = elements(lowerSource(source, declarations).body);
  if (!element) throw new Error("no element");
  return `${element.name} ${element.attrs.map(describeAttr).join(" ")}`.trim();
}

function errorOf(
  source: string,
  declarations?: Policy,
): { message: string; line: number; column: number } {
  try {
    lowerSource(source, declarations);
  } catch (error) {
    const { message, line, column } = error as {
      message: string;
      line: number;
      column: number;
    };
    return { message, line, column };
  }
  throw new Error(`expected ${JSON.stringify(source)} to fail`);
}

describe("tag-adjacent `:name`", () => {
  it.each([
    ['<input:email type="email"/>', 'input name="email" type="email"'],
    ["<input:email/>", 'input name="email"'],
    ["<a.c:b/>", 'a name="b" class="c"'],
    ["<a#d:b.c/>", 'a name="b" class="c" id="d"'],
    ["<a.c:b#d/>", 'a name="b" class="c" id="d"'],
    ["<a:b.c#d/>", 'a name="b" class="c" id="d"'],
    ["<a:b#d/>", 'a name="b" id="d"'],
    ["<a.hover:x/>", 'a name="x" class="hover"'],
    ["<a.c.d:b/>", 'a name="b" class="c d"'],
    ["<a.c:b.d/>", 'a name="b" class="c d"'],
    ["<a.c-d:first-name/>", 'a name="first-name" class="c-d"'],
  ])("%s", (source, expected) => {
    expect(shape(source)).toBe(expected);
  });

  it("an unnamed tag goes to the default-tag resolver, with `name`", () => {
    expect(shape("<:email/>")).toBe('input name="email"');
    expect(shape("<:b.c/>")).toBe('input name="b" class="c"');
    expect(shape("<:b#d.c/>")).toBe('input name="b" class="c" id="d"');
    expect(
      shape("<:email/>", policy({ resolveDefaultTag: () => "span" })),
    ).toBe('span name="email"');
  });

  it("a class written as an attribute keeps its colon", () => {
    expect(shape('<a class="hover:x"/>')).toBe('a class="hover:x"');
    expect(shape('<a.c class="hover:x"/>')).toContain("hover:x");
  });

  it("splits only the static tail of a dynamic shorthand", () => {
    expect(shape("<a.${x}:b/>")).toBe('a name="b" class=<`${x}`>');
    expect(shape("<a.c${x}/>")).toBe("a class=<`c${x}`>");
    expect(shape("<a.c.${x}:b/>")).toBe('a name="b" class=<["c", `${x}`]>');
  });

  it("leaves a dynamic tag name alone", () => {
    const ir = lowerSource("<${x}:b/>");
    const names = JSON.stringify(ir.body);
    expect(names).not.toContain('"name":"name"');
  });

  it.each([
    ["<a:b.c:d/>", 6],
    ["<a:b:c/>", 4],
    ["<a.c:b.d:e/>", 8],
    ["<a#d:b.c:e/>", 8],
    ["<a.c:b#d:e/>", 8],
  ])("%s: a second `:` is a positioned error", (source, column) => {
    const error = errorOf(source);
    expect(error.message).toContain("one `:name`");
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
  });

  it.each([
    ["<a:/>", "needs a name after it"],
    ["<a.c:/>", "needs a name after it"],
    ["<a:1/>", "is not a name"],
    ["<a.c:1b/>", "is not a name"],
  ])("%s: the name must be an identifier", (source, message) => {
    expect(errorOf(source).message).toContain(message);
  });

  it("reports `name` at the `:` token", () => {
    const [element] = elements(lowerSource('<input:email type="email"/>').body);
    const name = element?.attrs[0] as Extract<Attr, { kind: "static" }>;
    expect(name.name).toBe("name");
    expect(name.nameSpan).toEqual({ sourceStart: 6, sourceEnd: 12 });
    expect(name.valueSpan).toEqual({ sourceStart: 7, sourceEnd: 12 });
  });
});

describe("`#id`, `.class` and `:name` in attribute position", () => {
  it.each([
    ["<a :b/>", 'a name="b"'],
    ['<a x="1" :b/>', 'a x="1" name="b"'],
    ["<a x=1 :b/>", 'a x=<1> name="b"'],
    ["<a x=1 ? y : z :b/>", 'a x=<1 ? y : z> name="b"'],
    ["<a #b/>", 'a id="b"'],
    ["<a x=1 #b/>", 'a x=<1> id="b"'],
    ["<a .b/>", 'a class="b"'],
    ['<a x="1" .b/>', 'a x="1" class="b"'],
    ["<a x=a.b .c/>", 'a x=<a.b> class="c"'],
    ["<a x=(a.b .c)/>", "a x=<a.b .c>"],
    ['<a x="1" #b .c :d/>', 'a x="1" id="b" class="c" name="d"'],
    ["<a .b .c/>", 'a class="b c"'],
    ["<a.d .b/>", 'a class="d b"'],
    ["<a.d.e .b .c/>", 'a class="d e b c"'],
    ["<a .b:c/>", 'a class="b" name="c"'],
    ["<a #b:c/>", 'a id="b" name="c"'],
    ["a x=1 .b :c", 'a x=<1> class="b" name="c"'],
    ['a x="1" #b .c :d', 'a x="1" id="b" class="c" name="d"'],
    ["a #b .c :d", 'a id="b" class="c" name="d"'],
  ])("%s", (source, expected) => {
    expect(shape(source)).toBe(expected);
  });

  it("merges exactly as the tag-adjacent shorthand does", () => {
    expect(shape("<div.a #m .b/>")).toBe(shape("<div.a.b#m/>"));
    expect(shape("<div.a #m .b/>")).toBe('div class="a b" id="m"');
  });

  it("merges beside an authored class like a shorthand does", () => {
    // Sugar is appended to the shorthand part, so the written tag and its
    // sugar-free spelling are the same tag (review finding 4).
    expect(shape('<div.c class="x" .d/>')).toBe(shape('<div.c.d class="x"/>'));
    expect(shape("<div.a class={a: true} .b/>")).toBe(
      shape("<div.a.b class={a: true}/>"),
    );
    expect(shape('<div.c class="x" .d .e/>')).toBe(
      shape('<div.c.d.e class="x"/>'),
    );
    expect(shape("<div.${y} class=x .d/>")).toBe(
      shape("<div.${y}.d class=x/>"),
    );
    // No shorthand: the written order is kept.
    expect(shape('<a class="z" .b/>')).toBe('a class="z b"');
    expect(shape("<a class=x .b/>")).toBe('a class=<[x, "b"]>');
    expect(shape('<div class=["x"] .d/>')).toBe('div class=<["x", "d"]>');
    expect(shape('<div class="x" .d/>')).toBe('div class="x d"');
    expect(shape('<div .d class="x"/>')).toBe('div class="d x"');
  });

  it("follows the duplicate rule (decision 135), last one wins", () => {
    const warnings: MxWarning[] = [];
    const [first] = elements(
      lowerSource("<a #b #c/>", policy(), warnings).body,
    );
    expect(first?.attrs.map(describeAttr)).toEqual(['id="c"']);
    expect(warnings).toHaveLength(1);
    expect(shape('<a id="x" #b/>')).toBe('a id="b"');
    expect(shape('<a #b id="x"/>')).toBe('a id="x"');
    expect(shape('<a name="x" :b/>')).toBe('a name="b"');
    expect(shape('<a :b name="x"/>')).toBe('a name="x"');
    expect(shape("<a :b :c/>")).toBe('a name="c"');
    expect(shape("<a#d #e/>")).toBe('a id="e"');
    expect(shape("<a:b :c/>")).toBe('a name="c"');
  });

  it.each([
    ["<a :b=1/>", "`:b=1`", 3],
    ["<a #b=1/>", "`#b=1`", 3],
    ['<a x=1 .b="c"/>', '`.b="c"`', 7],
  ])(
    "%s: a value on the sugar is a positioned error",
    (source, token, column) => {
      const error = errorOf(source);
      expect(error.message).toContain(token);
      expect(error.message).toContain("takes no value");
      expect(error.line).toBe(1);
      expect(error.column).toBe(column);
    },
  );

  it.each([
    ["<a :1/>", "`:1`"],
    ["<a :b.c/>", "`:b.c`"],
  ])("%s: the token must be an identifier", (source, token) => {
    expect(errorOf(source).message).toContain(token);
  });

  it("leaves the named forms alone", () => {
    expect(
      shape(
        '<a class:x="y"/>',
        policy({ resolveModifier: (a) => `class:${a.modifier}` }),
      ),
    ).toBe('a class:x=<"y">');
    expect(shape("<a x:foo/>")).toBe('a x:foo=""');
    expect(shape("<a value:foo/>")).toBe('a value:foo=""');
    expect(shape("<a :/>")).toBe('a value:=""');
  });

  it("reports each token at its own span", () => {
    const [element] = elements(lowerSource('<a x="1" :b #c .d/>').body);
    const spans = element?.attrs.map((attr) => {
      const named = attr as Extract<Attr, { kind: "static" }>;
      return [named.name, named.nameSpan, named.valueSpan] as const;
    });
    expect(spans).toEqual([
      ["x", { sourceStart: 3, sourceEnd: 4 }, { sourceStart: 5, sourceEnd: 8 }],
      [
        "name",
        { sourceStart: 9, sourceEnd: 11 },
        { sourceStart: 10, sourceEnd: 11 },
      ],
      [
        "id",
        { sourceStart: 12, sourceEnd: 14 },
        { sourceStart: 13, sourceEnd: 14 },
      ],
      [
        "class",
        { sourceStart: 15, sourceEnd: 17 },
        { sourceStart: 16, sourceEnd: 17 },
      ],
    ]);
  });
});

// Decision 146, addendum 3: Angular gets the sugar. The one host-owned
// exception is attribute-position `#x`, which a host declares with
// `claimsAttributeHash` (Angular's template reference).
describe("a host that claims attribute-position `#`", () => {
  const angular = policy({
    acceptsForeignAttrNames: true,
    claimsAttributeHash: true,
  });

  it("keeps attribute-position `#ref` the host's own", () => {
    expect(shape("<div #ref/>", angular)).toBe("div #ref");
  });

  it("everything else is the sugar, as on every host", () => {
    expect(shape("<svg:rect/>", angular)).toBe('svg name="rect"');
    expect(shape('<input:email type="email"/>', angular)).toBe(
      'input name="email" type="email"',
    );
    expect(shape("<div#x/>", angular)).toBe('div id="x"');
    expect(shape("<div.b/>", angular)).toBe('div class="b"');
    expect(shape("<div .b/>", angular)).toBe('div class="b"');
    expect(shape("<div :b/>", angular)).toBe('div name="b"');
    expect(shape('<div x="1" :b .c/>', angular)).toBe(
      'div x="1" name="b" class="c"',
    );
  });

  it("a host that does not claim it reads `#ref` as `id`", () => {
    expect(shape("<div #ref/>")).toBe('div id="ref"');
  });
});

// Review finding 3: a rewritten shorthand's value span stops before the colon
// (it used to cover `c:b`, overlapping the `name` span). A class merged from
// tokens that are not contiguous keeps its FIRST token's span: no single
// honest span covers `c`, `#m` and `.b`.
describe("exact value spans of the rewritten shorthand", () => {
  const slices = (source: string) => {
    const [element] = elements(lowerSource(source).body);
    return Object.fromEntries(
      (element?.attrs ?? []).map((attr) => {
        const named = attr as Extract<Attr, { kind: "static" }>;
        const span = named.valueSpan;
        return [
          named.name,
          span ? source.slice(span.sourceStart, span.sourceEnd) : null,
        ];
      }),
    );
  };

  it.each([
    ["<a.c:b/>", { name: "b", class: "c" }],
    ["<a#d:b/>", { name: "b", id: "d" }],
    ["<a.c:b.d/>", { name: "b", class: "c" }],
    ["<a.c #m .b/>", { id: "m", class: "c" }],
    ["<a.c.d:b/>", { name: "b", class: "c.d" }],
    ["<a.c:b#d/>", { name: "b", class: "c", id: "d" }],
  ])("%s", (source, expected) => {
    expect(slices(source)).toEqual(expected);
  });

  it("the name span and the class span do not overlap", () => {
    const element = elements(lowerSource("<a.c:b/>").body)[0];
    const attrs = (element?.attrs ?? []) as Extract<Attr, { kind: "static" }>[];
    const name = attrs.find((attr) => attr.name === "name");
    const cls = attrs.find((attr) => attr.name === "class");
    expect(cls?.valueSpan?.sourceEnd).toBeLessThanOrEqual(
      name?.nameSpan.sourceStart ?? 0,
    );
  });
});

// Review finding 5 (leader ruling): in attribute position `#x` and `.x` take
// exactly Marko's shorthand charset, as the tag-adjacent form does. The charset
// is read from htmljs-parser's own shorthand rule (probed against the parser
// Marko resolves), `:name` keeps the identifier rule.
describe("the shorthand charset, in both positions", () => {
  it.each([
    ["<div #1a/>", "<div#1a/>"],
    ["<div .2xl/>", "<div.2xl/>"],
    ["<div .é/>", "<div.é/>"],
    ["<div .a@b/>", "<div.a@b/>"],
    ["<div .a+b/>", "<div.a+b/>"],
    ["<div .w-1/2/>", null],
    ["<div #a-b_c$d/>", "<div#a-b_c$d/>"],
  ])("%s", (written, adjacent) => {
    if (adjacent === null) return;
    expect(shape(written)).toBe(shape(adjacent));
  });

  it("matches Marko's shorthand, so the two positions never disagree", () => {
    expect(shape("<div #1a/>")).toBe('div id="1a"');
    expect(shape("<div .2xl/>")).toBe('div class="2xl"');
    expect(shape("<div .é/>")).toBe('div class="é"');
  });

  it("a chain splits at `.` and `#` like a tag-adjacent chain", () => {
    expect(shape("<div .c.d/>")).toBe(shape("<div.c.d/>"));
    expect(shape("<div .c#m.d/>")).toBe(shape("<div.c#m.d/>"));
    expect(shape('<a x="1" .c.d/>')).toBe('a x="1" class="c d"');
  });

  it("`:name` keeps the identifier rule", () => {
    expect(errorOf("<div :1a/>").message).toContain("`:1a`");
    expect(errorOf("<div :é/>").message).toContain("`:é`");
  });

  it("an empty token is an error", () => {
    expect(errorOf("<div #/>").message).toContain("needs a name");
    expect(errorOf("<div ./>").message).toContain("needs a name");
  });
});

// Review finding 6: row 4 of divergences.md says a shorthand class or id
// cannot contain `:`, so a `:` before a `${…}` is an error too.
describe("a `:` inside a dynamic shorthand", () => {
  it.each([
    ["<a.c:b${x}/>", 4],
    ["<a#i:b${x}/>", 4],
    ["<a.c.d:b${x}e/>", 6],
  ])("%s: a `:` before a `${…}` is a positioned error", (source, column) => {
    const error = errorOf(source);
    expect(error.message).toContain("before a `${…}`");
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
  });

  it("the static tail still splits", () => {
    expect(shape("<a.${x}:b/>")).toBe('a name="b" class=<`${x}`>');
  });
});

// Review finding 7: messages name the sugar, not Marko's split of it.
describe("sugar messages", () => {
  it("`<div :b:c/>` is the one-name error", () => {
    const error = errorOf("<div :b:c/>");
    expect(error.message).toContain("one `:name`");
    expect(error.column).toBe(7);
  });

  it("`<div :b(x)/>` says arguments are not allowed on `:name`", () => {
    const error = errorOf("<div :b(x)/>");
    expect(error.message).toContain("arguments are not allowed on `:name`");
    expect(error.column).toBe(5);
  });
});

describe("sugarTagName", () => {
  it.each([
    ["resource:post", { tag: "resource", unnamed: false }],
    [":title", { tag: "", unnamed: true }],
    ["plain", { tag: "plain", unnamed: false }],
    ["@svg:rect", { tag: "@svg:rect", unnamed: false }],
    ["ünï:tag", { tag: "ünï", unnamed: false }],
  ])("%s", (raw, expected) => {
    expect(sugarTagName(raw)).toEqual(expected);
  });
});

// Delta review LOW 2: a dynamic shorthand works only tag-adjacent, and the
// message says so instead of blaming the characters.
describe("a dynamic shorthand in attribute position", () => {
  it.each([
    ["<div .a${x}/>", "<div.a${x}>", 5],
    ["<div #a${x}/>", "<div#a${x}>", 5],
  ])("%s", (source, hint, column) => {
    const error = errorOf(source);
    expect(error.message).toContain(
      `a dynamic shorthand works only tag-adjacent (\`${hint}\`)`,
    );
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
  });

  it("the tag-adjacent form still works", () => {
    expect(shape("<div.a${x}/>")).toBe("div class=<`a${x}`>");
  });
});

// Delta review NIT 3: the probe cache is bounded.
describe("the shorthand probe cache", () => {
  it("is cleared past its limit and keeps answering correctly", () => {
    for (let index = 0; index < SHORTHAND_CACHE_LIMIT + 50; index++) {
      expect(isShorthandWord(".", `w${index}`)).toBe(true);
      expect(shorthandCacheSize()).toBeLessThanOrEqual(SHORTHAND_CACHE_LIMIT);
    }
    expect(isShorthandWord(".", "a b")).toBe(false);
    expect(isShorthandWord(".", "2xl")).toBe(true);
  });
});
