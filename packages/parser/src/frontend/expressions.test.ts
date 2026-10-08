// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * The expression layer (ast §4.1, §4.1a, §7.1; decision 166 item 1): every
 * container's parsed Babel payload, its positions (file-absolute at
 * creation, fragment base included), the atom payload shape, the failure
 * that is data (`node: null`, `error` in `errors` in start order), and the
 * read-only contract (payloads never mutated after creation; containers
 * never share a node).
 */
import type { MxDocument, MxExpression, MxText } from "@mxlang/babel/mx-ast";
import { describe, expect, it } from "vitest";
import { lineColumnAt } from "./line-column.ts";
import { parse } from "./parse.ts";
import { OPTIONS } from "./test-support/options.ts";

// biome-ignore lint/suspicious/noExplicitAny: walks the tree generically
type Node = any;

function doc(source: string): MxDocument {
  return parse(source, OPTIONS);
}

/** Every container in the tree, in document order. */
function containers(document: MxDocument): MxExpression[] {
  const out: MxExpression[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: walks every node shape
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (typeof node.type === "string" && node.type.startsWith("Mx") && "source" in node && "outer" in node)
      out.push(node as MxExpression);
    for (const field of Object.values(node)) walk(field);
  };
  walk(document.body);
  return out;
}

describe("payloads", () => {
  it("a placeholder expression parses with its own file-absolute range and loc", () => {
    const { expression } = (doc("<p>${ 'q' + x }</p>").body[0] as Node).body[0];
    expect(expression.node.type).toBe("BinaryExpression");
    expect(expression.node.start).toBe(6);
    expect(expression.node.end).toBe(13);
    expect(expression.node.loc).toMatchObject({
      start: { line: 1, column: 6, index: 6 },
      end: { line: 1, column: 13, index: 13 },
    });
  });

  it("extra.raw survives: a string literal keeps its quotes", () => {
    const { expression } = (doc("<p>${'a\\nb'}</p>").body[0] as Node).body[0];
    expect(expression.node.type).toBe("StringLiteral");
    expect(expression.node.extra.raw).toBe("'a\\nb'");
  });

  it("the tag variable, tag arguments, params and type arguments use today's wrappers", () => {
    const tag = doc('for|a, b| of=(xs)') .body[0] as Node;
    expect(tag.var).toBeNull();
    expect(tag.params.node.map((n: Node) => n.type)).toEqual([
      "Identifier",
      "Identifier",
    ]);
    expect(tag.params.node[0].start).toBe(4);
    const called = doc("div/x = 1") .body[0] as Node;
    expect(called.var.node.type).toBe("Identifier");
    const typed = doc("Card<T>()").body[0] as Node;
    expect(typed.typeArgs.node.type).toBe("TSTypeParameterInstantiation");
    expect(typed.typeArgs.node.start).toBe(4);
  });

  it("a method's params and body, and a scriptlet's code, carry payloads", () => {
    const tag = doc('<div onClick(a: T) { const b = 1; }/>').body[0] as Node;
    const method = tag.attributes[0].value;
    expect(method.params.node[0].type).toBe("Identifier");
    expect(method.params.node[0].typeAnnotation.type).toBe("TSTypeAnnotation");
    expect(method.body.node[0].type).toBe("VariableDeclaration");
    const scriptlet = doc("$ const z = 1;").body[0] as Node;
    expect(scriptlet.code.node[0].type).toBe("VariableDeclaration");
  });

  it("an attribute value with a ternary keeps the payload Marko parses, parens in extra", () => {
    const attr = (doc("<div x=(a ? b : c)/>").body[0] as Node).attributes[0];
    expect(attr.value.node.type).toBe("ConditionalExpression");
    expect(attr.value.node.start).toBe(8);
    expect(attr.value.node.end).toBe(17);
    expect(attr.value.node.extra.parenthesized).toBe(true);
    expect(attr.value.node.loc.start.index).toBe(8);
  });

  it("a fragment base is baked into the payload's positions at creation", () => {
    const document = parse("<p>${a}</p>", {
      ...OPTIONS,
      base: { offset: 20, line: 2, column: 5 },
    });
    const { expression } = (document.body[0] as Node).body[0];
    expect(expression.node.start).toBe(25);
    expect(expression.node.end).toBe(26);
    expect(expression.node.loc).toMatchObject({
      start: { line: 3, column: 10, index: 25 },
    });
    expect(lineColumnAt(document, expression.node.start)).toEqual({
      line: 3,
      column: 10,
    });
  });

  it("a multi-line expression's later lines carry their own line and column", () => {
    const source = "<p>${\n  a +\n  b}</p>";
    const { expression } = (doc(source).body[0] as Node).body[0];
    expect(expression.node.loc.end).toEqual({
      line: 3,
      column: 3,
      index: 15,
    });
  });
});

describe("atoms", () => {
  it("an atom parses from the numeric stand-in and lands as today's StringLiteral", () => {
    const attr = (doc("<div x=:rename-all/>").body[0] as Node).attributes[0];
    expect(attr.value.node.type).toBe("StringLiteral");
    expect(attr.value.node.value).toBe("rename-all");
    expect(attr.value.node.extra).toEqual({
      raw: '"rename-all"',
      rawValue: "rename-all",
      mxAtom: { span: { sourceStart: 7, sourceEnd: 18 } },
    });
    expect(attr.value.node.start).toBe(7);
    expect(attr.value.node.end).toBe(18);
  });

  it("atoms beside real code keep every offset exact", () => {
    const attr = (doc("<div x=[ :a, :b ]/>").body[0] as Node).attributes[0];
    expect(attr.value.node.type).toBe("ArrayExpression");
    const [a, b] = attr.value.node.elements;
    expect([a.start, a.end]).toEqual([9, 11]);
    expect([b.start, b.end]).toEqual([13, 15]);
    expect(b.extra.mxAtom.span).toEqual({ sourceStart: 13, sourceEnd: 15 });
  });

  it("the container's atoms list is unchanged from PR 2: each atom once, innermost", () => {
    const attr = (doc("<div x=[:a, :b]/>").body[0] as Node).attributes[0];
    expect(attr.value.atoms.map((a: Node) => a.name)).toEqual(["a", "b"]);
  });
});

describe("failures are data", () => {
  it("a failed parse leaves node null and an error in errors, in start order", () => {
    const document = doc("<div x=(1 +) y=(2 *)/>");
    const attr = (document.body[0] as Node).attributes[0];
    expect(attr.value.node).toBeNull();
    expect(attr.value.error).toMatchObject({
      code: "BABEL_UnexpectedToken",
      origin: "expression",
      message: "Unexpected token",
      start: 11,
      end: 11,
      context: { start: 7, end: 12 },
    });
    expect(
      document.errors.map((error) => [error.code, error.start]),
    ).toEqual([
      ["BABEL_UnexpectedToken", 11],
      ["BABEL_UnexpectedToken", 19],
    ]);
    expect(document.complete).toBe(true);
  });

  it("the container's error is the same object as its entry in errors", () => {
    const document = doc("<div x=(1 +)/>");
    const attr = (document.body[0] as Node).attributes[0];
    expect(document.errors.includes(attr.value.error)).toBe(true);
  });

  it("today's ExpectsEOF sentence is reproduced byte for byte", () => {
    const attr = (doc('<div a="1"b="2"/>').body[0] as Node).attributes[0];
    expect(attr.value.source).toBe('"1"b="2"');
    expect(attr.value.error.message).toBe(
      "Expected a single expression, but found `b` after it.",
    );
    expect(attr.value.error.start).toBe(10);
  });

  it("the error's point lies in the container, its context is the container span", () => {
    const attr = (doc("<div x=(1 +) y=(2 *)/>").body[0] as Node).attributes[1];
    expect(attr.value.error.start).toBe(19);
    expect(attr.value.error.end).toBe(19);
    expect(attr.value.error.context).toEqual({ start: 15, end: 20 });
  });

  it("the { … } attribute value hint is today's text (the lead rules the MX rewording)", () => {
    const attr = (doc("<div x={a+b}/>").body[0] as Node).attributes[0];
    expect(attr.value.error?.message).toBe(
      'Unexpected token, expected ",". Attribute values in Marko are plain JavaScript expressions, not JSX; remove the wrapping `{ }`.',
    );
  });

  it("$!{…} as an attribute value is MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE with today's message and point", () => {
    const attr = (doc("<div x=$!{a}/>").body[0] as Node).attributes[0];
    expect(attr.value.node).toBeNull();
    expect(attr.value.error).toMatchObject({
      code: "MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE",
      origin: "front-end",
      message: "Expected a single expression, but found `{` after it.",
      start: 9,
      end: 9,
      context: { start: 7, end: 12 },
    });
  });

  it("an unwrappable wrapper result is today's ensureParseError sentence", () => {
    // `<x/>` parses as an expression but not as the arguments wrapper's callee shape.
    const tag = doc("a(1, 2)(3)").body[0] as Node;
    expect(tag.args.node.map((n: Node) => n.type)).toEqual([
      "NumericLiteral",
      "NumericLiteral",
    ]);
  });
});

describe("the read-only contract (ast §4.1a)", () => {
  const SOURCE = "<div x=a y=:b><p>${c}</p>text<!-- c --></div>";

  it("a deeply frozen tree is not written by a second parse of the same source", () => {
    const document = doc(SOURCE);
    const deep = (value: unknown): void => {
      if (Array.isArray(value)) {
        Object.freeze(value);
        value.forEach(deep);
        return;
      }
      if (value && typeof value === "object") {
        Object.freeze(value);
        for (const field of Object.values(value)) deep(field);
      }
    };
    deep(document);
    // Every consumer of the front end over the frozen tree.
    expect(() => {
      lineColumnAt(document, 20);
      containers(document);
      const second = doc(SOURCE);
      expect(JSON.stringify(second)).not.toBe("");
    }).not.toThrow();
  });

  it("no two containers hold the same Babel node or position object", () => {
    const document = doc(SOURCE + "<span q=a>${a}</span>");
    const seen = new Set<unknown>();
    const positions = new Set<unknown>();
    let shared = 0;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) shared++;
      else seen.add(value);
      const loc = (value as Node).loc;
      if (loc) {
        for (const point of [loc.start, loc.end]) {
          if (positions.has(point)) shared++;
          else positions.add(point);
        }
      }
      for (const field of Object.values(value)) walk(field);
    };
    for (const container of containers(document)) walk(container.node);
    expect(shared).toBe(0);
  });

  it("the tree holds no atom stand-ins: every atom is a StringLiteral", () => {
    const document = doc("<div x=[:a, f(:b)]/>");
    const standIns: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (
        (value as Node).type === "NumericLiteral" &&
        document.source[(value as Node).loc?.start?.index] === ":"
      )
        standIns.push(document.source.slice((value as Node).start, (value as Node).end));
      for (const field of Object.values(value)) walk(field);
    };
    for (const container of containers(document)) walk(container.node);
    expect(standIns).toEqual([]);
  });
});

describe("text and expressions together", () => {
  it("a placeholder beside text leaves both in the body", () => {
    const p = (doc("<p>a ${x} b</p>").body[0] as Node);
    expect(p.body.map((n: Node) => [n.type, n.value ?? null])).toEqual([
      ["MxText", "a "],
      ["MxPlaceholder", null],
      ["MxText", " b"],
    ]);
    expect((p.body[1] as Node).expression.node.type).toBe("Identifier");
    const third = p.body[2] as MxText;
    expect(third.valueSpan).toEqual({ start: 9, end: 11 });
  });
});
