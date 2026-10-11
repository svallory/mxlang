// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
import {
  isShorthandWord,
  SHORTHAND_CACHE_LIMIT,
  shorthandCacheSize,
} from "./shorthand.ts";
import { lookup } from "./test-targets.ts";

/**
 * Marko's `#id` / `.class` shorthand at the IR core hands a host, and the
 * colon and spaced forms read exactly as stock Marko reads them. Every row
 * parses with the MX front end, then lowers.
 *
 * The Marko readings pinned here come from `@marko/compiler` 5.42.11 with the
 * stock `htmljs-parser` 5.18.0 (`bun run --cwd packages/stock-marko probe`);
 * the transcripts are in the PR report.
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

function lowerSource(source: string, declarations: Policy = policy()): Ir {
  const { body } = parseFragment(source, { filename: "/tmp/f.mx" });
  const ctx = newCtx(
    source,
    printExpression,
    declarations,
    undefined,
    "/tmp/f.mx",
    lookup,
  );
  return lower(ctx, body);
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

describe("the tag-adjacent shorthand", () => {
  it.each([
    ["<div#a/>", 'div id="a"'],
    ["<div.b/>", 'div class="b"'],
    ["<div.b.c#a/>", 'div class="b c" id="a"'],
    ['<div.b class="x"/>', 'div class=<`${"b"} ${"x"}`>'],
    ["div#a.b", 'div class="b" id="a"'],
  ])("%s", (source, expected) => {
    expect(shape(source)).toBe(expected);
  });

  it("an unnamed tag goes to the default-tag resolver", () => {
    expect(shape("<#a/>")).toBe('input id="a"');
    expect(shape("<.b/>")).toBe('input class="b"');
  });

  it("a shorthand next to an authored `id` is Marko's parser error", () => {
    expect(errorOf('<div#a id="b"/>').message).toContain(
      "Cannot have shorthand id and id attribute.",
    );
  });
});

describe("a colon in a tag head reads as Marko reads it", () => {
  // Stock Marko: `:` is a tag-name and shorthand character. `<a.c:b>` is the
  // class `c:b`, `<a#d:b>` the id `d:b`, and `<kind:name>` one tag name.
  it.each([
    ["<div.c:b/>", 'div class="c:b"'],
    ["<div#d:b/>", 'div id="d:b"'],
    ["<div.hover:bg-red/>", 'div class="hover:bg-red"'],
    ["<uuid:id/>", "uuid:id"],
    ["<string:title/>", "string:title"],
    ["<:x/>", ":x"],
    ["entity:Todo", "entity:Todo"],
    ["<input:email/>", "input:email"],
  ])("%s", (source, expected) => {
    expect(shape(source)).toBe(expected);
  });
});

describe("attribute-position forms read as Marko reads them", () => {
  // Stock Marko: a name with an empty head before its last `:` is the default
  // attribute with that modifier (`value:b`); a bare `:` is `value:`.
  it.each([
    ["<div :b/>", "<div value:b/>", 'div value:b=""'],
    ["<div :/>", "<div value:/>", 'div value:=""'],
    ['<div :b="x"/>', '<div value:b="x"/>', 'div value:b="x"'],
  ])("%s is %s", (source, spelled, expected) => {
    expect(shape(source)).toBe(expected);
    expect(shape(source)).toBe(shape(spelled));
  });

  it("the name of `:b` is the spelled `:b`", () => {
    const [element] = elements(lowerSource("<div :b/>").body);
    const span =
      element?.attrs[0] && "nameSpan" in element.attrs[0]
        ? element.attrs[0].nameSpan
        : undefined;
    expect(span).toEqual({ sourceStart: 5, sourceEnd: 7 });
  });

  // Stock Marko: after a value, ` .b` continues the expression (member
  // access), so nothing ends the value there.
  it("a spaced `.b` after a value is member access on it", () => {
    expect(shape("<div x=a .b/>")).toBe("div x=<a .b>");
  });

  it("`:b(x)` is Marko's arguments error on `value:b`", () => {
    const error = errorOf("<div :b(x)/>");
    expect(error.message).toContain(
      "Unsupported arguments on the `value:b` attribute.",
    );
    expect(error.line).toBe(1);
    expect(error.column).toBe(5);
  });

  // Stock Marko: a spaced `#id` / `.class` is an attribute whose name is not
  // in its grammar, `Invalid attribute name.`.
  it.each([
    ["<div #a/>", "#a", 5],
    ["<div .b/>", ".b", 5],
    ['<div x="1" #b/>', "#b", 11],
    ["<div #a.b/>", "#a.b", 5],
    ["<div .bg-[#fff]/>", ".bg-[#fff]", 5],
  ])("%s: `Invalid attribute name`", (source, name, column) => {
    const error = errorOf(source);
    expect(error.message).toBe(
      `Invalid attribute name \`${name}\` — a \`#id\` or \`.class\` shorthand goes on the tag name with no space (\`<div#a>\`, \`<div.cls>\`); otherwise write \`id=\` or \`class=\``,
    );
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
  });

  it("a host that accepts foreign attribute names keeps `#ref` as written", () => {
    expect(
      shape("<div #ref/>", policy({ acceptsForeignAttrNames: true })),
    ).toBe("div #ref");
  });
});

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

describe("shorthand part diagnostics", () => {
  it("an unbalanced bracket is a positioned error with the class hint", () => {
    const error = errorOf("<div.bg-[#fff]/>");
    expect(error.message).toContain("unbalanced `[`");
    expect(error.message).toContain('class="…"');
    expect(error.line).toBe(1);
    expect(error.column).toBe(5);
  });

  it("a split-off purely numeric class part is a positioned error", () => {
    const error = errorOf("<div.w-1.5/>");
    expect(error.message).toContain("cannot be purely numeric");
    expect(error.message).toContain('class="…"');
    expect(error.line).toBe(1);
    expect(error.column).toBe(9);
  });

  it.each(["<div.2xl/>", "<div.2xl.3xl/>"])(
    "%s: a digit-leading but non-numeric class part stays valid",
    (source) => {
      expect(() => lowerSource(source)).not.toThrow();
    },
  );

  it.each(["<div.hover:bg-red/>", "<div.a.b#c/>", "<div.w-1/>"])(
    "%s stays valid, no diagnostic",
    (source) => {
      expect(() => lowerSource(source)).not.toThrow();
    },
  );
});
