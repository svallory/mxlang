// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { type Ctx, type MxWarning, type Node, newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
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
    // A colon before an expression is class text, not a name.
    expect(shape("<a.c:b${x}/>")).toBe("a class=<`c:b${x}`>");
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
    expect(shape('<a class="z" .b/>')).toBe('a class=<`${"b"} ${"z"}`>');
    expect(shape("<a class=x .b/>")).toBe('a class=<["b", x]>');
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
    ["<a #1/>", "`#1`"],
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

describe("a host with its own attribute syntax opts out", () => {
  const foreign = policy({ acceptsForeignAttrNames: true });

  it("keeps `svg:rect` a tag name and `#ref` an attribute", () => {
    expect(shape("<svg:rect/>", foreign)).toBe("svg:rect");
    expect(shape("<a #ref/>", foreign)).toBe("a #ref");
  });
});
