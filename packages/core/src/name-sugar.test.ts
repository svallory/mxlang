// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { type Ctx, type MxWarning, type Node, newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
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
    expect(shape("<a value:/>")).toBe('a value:=""');
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
    // `.2xl` stays Marko-valid: a digit-leading class part is only an error
    // when it is purely numeric (the tail of a split like `.w-1.5`).
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

  // Review (PR 3 round 2), finding 3: the chain splits on sigils outside the
  // `${…}` only, and the message quotes the authored text.
  it.each([
    ["<div .a${input.s}/>", "<div.a${input.s}>", ".a${input.s}"],
    ["<div #a${input.s.t}/>", "<div#a${input.s.t}>", "#a${input.s.t}"],
    ["<div .a${x.y}b/>", "<div.a${x.y}b>", ".a${x.y}b"],
  ])("%s quotes the whole authored token", (source, adjacent, token) => {
    const error = errorOf(source);
    expect(error.message).toContain(`(\`${adjacent}\`)`);
    expect(error.message).toContain(`not as \`${token}\``);
    expect([error.line, error.column]).toEqual([1, 5]);
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

// Leader addition to PR 3 round 2 (item 9): a bare `:` in attribute position
// is a positioned error, like a bare `#` or `.`. Marko would have read it as
// `value:` (divergence row 2); the named forms with an empty suffix (`x:`) are
// still Marko's.
describe("a bare `:` in attribute position", () => {
  it.each([
    ["<input :/>", 1, 7],
    ["input :", 1, 6],
    ['<input x="1" :/>', 1, 13],
    ["<input\n  :/>", 2, 2],
  ])("%j is a positioned error", (source, line, column) => {
    const error = errorOf(source);
    expect(error.message).toContain("`:` is name sugar and needs a name");
    expect(error.message).toContain("`:email`");
    expect([error.line, error.column]).toEqual([line, column]);
  });

  it("the named forms with an empty suffix stay Marko's", () => {
    expect(shape("<div x:/>")).toBe('div x:=""');
    expect(shape('<div x: = "s"/>')).toBe('div x:="s"');
  });
});

// Review (PR 3 round 2), finding 6: the duplicate-attribute warning names the
// sugar for the dropped and the winning occurrence, like an E1 error does.
describe("the duplicate-attribute warning names the sugar", () => {
  const warningsOf = (source: string) => {
    const warnings: MxWarning[] = [];
    lowerSource(source, policy(), warnings);
    return warnings.map((w) => w.message);
  };

  it.each([
    [
      '<input name="a" :z/>',
      "duplicate attribute `name`: the later one (`:z` (`name`)) at 1:17 wins, so this one is dropped",
    ],
    [
      '<input :z name="a"/>',
      "duplicate attribute `:z` (`name`): the later one at 1:11 wins, so this one is dropped",
    ],
    [
      "<field #a #b/>",
      "duplicate attribute `#a` (`id`): the later one (`#b` (`id`)) at 1:11 wins, so this one is dropped",
    ],
    [
      "<input :a :b/>",
      "duplicate attribute `:a` (`name`): the later one (`:b` (`name`)) at 1:11 wins, so this one is dropped",
    ],
  ])("%s", (source, message) => {
    expect(warningsOf(source)).toEqual([message]);
  });

  it("an attribute written out keeps the plain wording", () => {
    expect(warningsOf('<input name="a" name="b"/>')).toEqual([
      "duplicate attribute `name`: the later one at 1:17 wins, so this one is dropped",
    ]);
  });
});

// A statement tag's text is not attributes. `parseFragment` (the TS plugin's
// mapping pass) parses without the core taglib, so it reads `static function
// f(a: number): string {}` as a tag with attributes; the sugar rewrite must
// leave a real statement alone (a bare `:` in it is a TypeScript return type).
// "Real" is decided by the lookup when there is one
// (`getTag(name).parseOptions.statement`), else by the core taglib's own
// `statement` entries: there is no second list (round 3, review A).
describe("statement tags are not rewritten", () => {
  type MarkoLookup = NonNullable<Ctx["lookup"]>;
  const lowerFragment = (source: string, markoLookup?: MarkoLookup): Ir => {
    const { body } = parseFragment(source, { filename: "/tmp/f.mx" });
    const ctx = newCtx(
      source,
      printExpression,
      policy(),
      markoLookup,
      "/tmp/f.mx",
      lookup,
    );
    return lower(ctx, body);
  };
  const messageOf = (run: () => void): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  it.each([
    "static function label(count: number): string { return String(count); }\n",
    "static const view = cond ? a : b\n",
    "export const x = y .z\n",
    "client function f(a: number): string { return a }\n",
    "class A { f(a: number): string { return a } }\n",
  ])("no lookup (the taglib-less path): %j", (source) => {
    const message = messageOf(() => lowerFragment(source));
    expect(message).not.toContain("name sugar");
    expect(message).not.toContain("one `:name`");
  });

  it("a lookup decides: a tag it does not call a statement is rewritten", () => {
    // The parse always reads `static` as a statement now (decision 168), so
    // the lookup is asked about the name before the colon: one that does not
    // call `static` a statement gets the sugar, not the statement-tag error.
    const none = { getTag: () => undefined } as unknown as MarkoLookup;
    // The sugar ran (no "not supported on the statement tag" error), and the
    // rewritten `static` tag, parsed as attributes, is then refused by the
    // statement lowerer: the two together pin the lookup branch.
    expect(messageOf(() => lowerFragment("<static:x/>\n", none))).toContain(
      "`static` was parsed as a tag with attributes",
    );
  });

  it("a data lookup that makes `class` an ordinary tag keeps the sugar", () => {
    // The lookup is the branch most likely to regress: a data dialect has no
    // statements, so `class` is an ordinary tag there and `<class:x/>` is a
    // tag-adjacent `:name`, not the error the no-lookup rows report. It is the
    // same source as the `<class:x/>` row in the other block, which reads the
    // core taglib and does error.
    const data = {
      getTag: (name: string) => (name === "class" ? {} : undefined),
    } as unknown as MarkoLookup;
    const ir = lowerFragment("<class:x/>\n", data);
    const tag = ir.body[0];
    expect(tag?.kind).toBe("Element");
    if (tag?.kind !== "Element") throw new Error("expected an element");
    expect(tag.name).toBe("class");
    expect(
      tag.attrs.map((attr) => ("name" in attr ? attr.name : null)),
    ).toContain("name");
  });

  it("a lookup decides: a custom tag with parseOptions.statement is left alone", () => {
    const custom = {
      getTag: (name: string) =>
        name === "script-ish"
          ? { parseOptions: { statement: true } }
          : undefined,
    } as unknown as MarkoLookup;
    expect(
      messageOf(() =>
        lowerFragment("script-ish function f(a: number): string {}\n", custom),
      ),
    ).not.toContain("name sugar");
  });
});

// A `:name` sugar on a statement tag (`<import:x/>`) is not a tag called
// `import:x`: rewriting it made `<import name="x"/>`, which lowers to a
// statement node wherever the tag sits, and a statement inside a body is an IR
// shape no target can describe. Every host reported that as an internal error
// (data: "unexpected IR node kind `Import` in a body"; html: "unexpected
// module-level node kind \"Import\" in the body walk"). The name before the
// colon is what names the tag, so it decides, and the diagnostic sits on the
// colon.
describe("a `:name` sugar on a statement tag", () => {
  it.each([
    ["import", "<import:x/>", 7],
    ["export", "<export:x/>", 7],
    ["static", "<static:x/>", 7],
    ["client", "<client:x/>", 7],
    ["server", "<server:x/>", 7],
    ["class", "<class:x/>", 6],
  ])("%s: named at the root", (name, source, column) => {
    const error = errorOf(source);
    expect(error.message).toBe(
      `a \`:name\` is not supported on the statement tag \`${name}\`: its text is code, not attributes — write \`${name} …\` at the root of the template instead`,
    );
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
  });

  it.each([
    ["import", "<div><import:x/></div>", 12],
    ["export", "<div><export:x/></div>", 12],
    ["static", "<div><static:x/></div>", 12],
    ["client", "<div><client:x/></div>", 12],
    ["server", "<div><server:x/></div>", 12],
    ["class", "<div><class:x/></div>", 11],
  ])("%s: nested in a body", (name, source, column) => {
    const error = errorOf(source);
    expect(error.message).toContain(
      `not supported on the statement tag \`${name}\``,
    );
    expect(error.column).toBe(column);
  });

  it("an attribute tag's namespaced name is not a statement tag", () => {
    // `<@svg:rect>` names an attribute tag; the `:` in it is XML's, and the
    // name after it is not a `:name` sugar.
    expect(errorOf("<div><@svg:rect/></div>").message).not.toContain(
      "not supported on the statement tag",
    );
  });
});

// Round 3, review B: a non-string authored literal folds the way Marko's class
// value does: `false`, `0`, `null` and `undefined` drop out; other numbers and
// `true` stringify; a string stays as written. Every row is pinned against the
// tag-adjacent spelling (`<div.b class=false/>`).
describe("a literal class folded with a `.x` sugar", () => {
  it.each([
    ["<div class=false .b/>", 'div class="b"', "<div.b class=false/>"],
    ["<div class=0 .b/>", 'div class="b"', "<div.b class=0/>"],
    ["<div class=null .b/>", 'div class="b"', "<div.b class=null/>"],
    ["<div class=undefined .b/>", 'div class="b"', "<div.b class=undefined/>"],
    ["<div .b class=false/>", 'div class="b"', "<div.b class=false/>"],
    ["<div .b class=0/>", 'div class="b"', "<div.b class=0/>"],
  ])("%s drops the falsy literal", (source, expected) => {
    // The tag-adjacent spelling keeps Marko's own array form (the class helper
    // drops the literal at render time); `@mxlang/html`'s attr-name test pins
    // that both render the same. Here the sugar folds it away.
    expect(shape(source)).toBe(expected);
  });

  it.each([
    ["<div class=1 .b/>", 'div class="1 b"'],
    ["<div class=true .b/>", 'div class="true b"'],
    ["<div .b class=1/>", 'div class="b 1"'],
    ["<div .b class=true/>", 'div class="b true"'],
    ['<div class="a" .b/>', 'div class="a b"'],
  ])("%s stringifies", (source, expected) => {
    expect(shape(source)).toBe(expected);
  });
});

// Decision 146 addendum 4 (PR 4): `(` and `=` cannot be part of a sugar, so a
// sugar followed directly by `=value` or `(params) { body }` sets the tag's
// default attribute (`value`). It replaces PR 2's "sugar takes no value" errors.
describe("a sugar followed by =value or (params) { body } sets the default attribute", () => {
  const withMethods = policy({ resolveAttributeMethod: () => true });
  const parts = (source: string) =>
    shape(source)
      .replace(/^\S+ ?/, "")
      .split(" ")
      .sort();

  it.each([
    ["<a #x=1/>", ['id="x"', "value=<1>"]],
    ["<a :x=input.y/>", ['name="x"', "value=<input.y>"]],
    ["<a .c=1/>", ['class="c"', "value=<1>"]],
    ['<a .c="s"/>', ['class="c"', 'value="s"']],
    ["<a x=1 #y=2/>", ["x=<1>", 'id="y"', "value=<2>"]],
    ["<a #x=1 y=2/>", ['id="x"', "value=<1>", "y=<2>"]],
    ["a #x=1", ['id="x"', "value=<1>"]],
    ["a :x=input.y", ['name="x"', "value=<input.y>"]],
    ["a .c=1", ['class="c"', "value=<1>"]],
    ["<a:x=1/>", ['name="x"', "value=<1>"]],
    ["<a#x=1/>", ['id="x"', "value=<1>"]],
    ["<a.c=1/>", ['class="c"', "value=<1>"]],
  ])("%s", (source, expected) => {
    expect(parts(source)).toEqual([...expected].sort());
  });

  it.each([
    "kind #name (p) { b }",
    "kind #name(p) { b }",
    "kind (p) { b } #name",
    "<kind #name(p){b}/>",
    "<kind (p){b} #name/>",
  ])("%s is id plus a function value, in either order", (source) => {
    const [element] = elements(lowerSource(source, withMethods).body);
    const attrs = element?.attrs ?? [];
    expect(
      attrs.map((a) => (a.kind === "spread" ? "..." : a.name)).sort(),
    ).toEqual(["id", "value"]);
    const value = attrs.find((a) => a.kind !== "spread" && a.name === "value");
    expect(value?.kind).toBe("dynamic");
    expect((value as { value: { code: string } }).value.code).toMatch(
      /^function \(p\)/,
    );
    expect(
      attrs.find((a) => a.kind !== "spread" && a.name === "id"),
    ).toMatchObject({ kind: "static", value: "name" });
  });

  it("`:name` and `.class` take a method too", () => {
    for (const source of ["a :x(p) { b }", "a .x (p) { b }"]) {
      const [element] = elements(lowerSource(source, withMethods).body);
      const names = (element?.attrs ?? []).map((a) =>
        a.kind === "spread" ? "..." : a.name,
      );
      expect(names.sort()).toEqual([
        source.includes(":") ? "name" : "class",
        "value",
      ]);
    }
  });

  it("the value is positioned at the sugar's value", () => {
    const [element] = elements(lowerSource("<a #x=input.y/>").body);
    const value = element?.attrs.find(
      (a) => a.kind === "dynamic" && a.name === "value",
    ) as {
      value: { span: { sourceStart: number; sourceEnd: number } };
      loc: { column: number };
    };
    expect(value.value.span).toEqual({ sourceStart: 6, sourceEnd: 13 });
    expect(value.loc.column).toBe(6);
  });

  it.each([
    ["<if=input.a #x=1>y</if>", 1, 15],
    ["kind=1 #x=2", 1, 10],
    ["kind (p) { b } #x(q) { c }", 1, 17],
    ["<a #x=1 #y=2/>", 1, 11],
    ["<a value=1 #x=2/>", 1, 14],
    ["<a:x=1 #y=2/>", 1, 10],
  ])(
    "%s: a second default value is a positioned error at the second",
    (source, line, column) => {
      const error = errorOf(source);
      expect(error.message).toContain("already has a default value");
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );

  it("the default-attribute exemption still holds", () => {
    // `.b` after a default value is still member access (decision 151 ruling 2).
    expect(shape("<a=input.o .c/>", withMethods)).toContain(
      "value=<input.o .c>",
    );
  });

  it("the bare-sugar errors stay", () => {
    expect(errorOf("<a #/>").message).toContain("needs a name");
    expect(errorOf("<a :/>").message).toContain("needs a name");
    expect(errorOf("<a ./>").message).toContain("needs a name");
  });

  it("arguments without a body are still an error", () => {
    expect(errorOf("<a #x(p)/>").message).toContain(
      "arguments are not allowed",
    );
    expect(errorOf("<a :x(p)/>").message).toContain(
      "arguments are not allowed",
    );
  });
});

// Round 2 of PR 4 (review findings 1, 2, 4, 5).
describe("default value: Angular, bound, naming, position", () => {
  const withMethods = policy({ resolveAttributeMethod: () => true });
  const angular = policy({
    acceptsForeignAttrNames: true,
    claimsAttributeHash: true,
  });

  it("on Angular, `#ref=x` is the template reference: two plain `value=` stay decision 135's warning", () => {
    const warnings: MxWarning[] = [];
    expect(() =>
      lowerSource("<input value=1 value=2 #r=x/>", angular, warnings),
    ).not.toThrow();
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("duplicate attribute `value`"),
    ]);
  });

  it("on Angular, `:n=1` still sets the default value", () => {
    expect(shape("<input :n=1/>", angular)).toContain("name");
    expect(errorOf("<input value=1 :n=2/>", angular).message).toContain(
      "already has a default value",
    );
  });

  it.each([
    ["<a value:=y #x=1/>", 1, 15],
    ["<a #x=1 value:=y/>", 1, 8],
    ["<a value:=y :n=1/>", 1, 15],
  ])(
    "a bound `value:=` is the default value: %s is a positioned error",
    (source, line, column) => {
      const error = errorOf(source, withMethods);
      expect(error.message).toContain("already has a default value");
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );

  it("the double-default message gives the first one as line:column", () => {
    const error = errorOf("<input\n  value=1\n  #x=2/>", withMethods);
    expect(error.message).toContain("(at 2:3)");
    expect(error.message).not.toContain("offset");
    expect(errorOf("kind=1 #x=2", withMethods).message).toContain("(at 1:5)");
  });
});

describe("default value: tag-adjacent `=value` is Marko's own default", () => {
  it("<a#x=1 value=2/> is decision 135's warning, not the double-default error", () => {
    const warnings: MxWarning[] = [];
    expect(() =>
      lowerSource("<a#x=1 value=2/>", undefined, warnings),
    ).not.toThrow();
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("duplicate attribute `value`"),
    ]);
  });
});

describe("default value: a bound value on a sugar", () => {
  const withMethods = policy({ resolveAttributeMethod: () => true });

  it.each([
    ["<a :n:=y/>", 1, 3],
    ["<a #x:=y/>", 1, 3],
    ["<a .c:=y/>", 1, 3],
    ["<input type=text :n:=y/>", 1, 17],
  ])(
    "%s is a positioned error, not a silent value=y",
    (source, line, column) => {
      const error = errorOf(source, withMethods);
      expect(error.message).toBe(
        "a bound value is not supported on name sugar; write name=... value:=...",
      );
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );
});

describe("decision 174: shorthand diagnostics", () => {
  // `.data-[state=open]:flex` and friends die in Marko's own group reader
  // before MX lowers; their rewrite is covered in parse-error-hints.test.ts.
  it.each([
    ["<div.bg-[#fff]/>", "unbalanced `[`", 5],
    ["<div .bg-[#fff]/>", "unbalanced `[`", 5],
  ])(
    "%s: an unbalanced bracket is a positioned error with the class hint",
    (source, message, column) => {
      const error = errorOf(source);
      expect(error.message).toContain(message);
      expect(error.message).toContain('class="…"');
      expect(error.line).toBe(1);
      expect(error.column).toBe(column);
    },
  );

  it("the id part is checked too (unreachable first at one position, kept for the other)", () => {
    // The class part always carries the first offense when brackets span a
    // `.`/`#` split (`.bg-[#fff]`), so the id branch fires second; the check
    // is the same `checkShorthandWord` call the class parts go through.
    const error = errorOf("<div .bg-[#fff]/>");
    expect(error.message).toContain("unbalanced `[`");
  });

  it.each([
    ["<div.w-1.5/>", 9],
    // The caret sits on the `.` that ends the previous part (the part's own
    // first character is inside the token the split produced).
    ["<div .w-1.5/>", 9],
  ])(
    "%s: a split-off purely numeric class part is a positioned error",
    (source, column) => {
      const error = errorOf(source);
      expect(error.message).toContain("cannot be purely numeric");
      expect(error.message).toContain('class="…"');
      expect(error.line).toBe(1);
      expect(error.column).toBe(column);
    },
  );

  it.each(["<div.2xl/>", "<div .2xl/>", "<div.2xl.3xl/>"])(
    "%s: a digit-leading but non-numeric class part stays valid",
    (source) => {
      expect(() => lowerSource(source)).not.toThrow();
    },
  );

  it.each([
    "<div.hover:bg-red/>",
    "<div.a.b#c/>",
    "<div.w-1/>",
    '<div .w-1 class="x"/>',
  ])("%s stays valid, no diagnostic", (source) => {
    expect(() => lowerSource(source)).not.toThrow();
  });
});
