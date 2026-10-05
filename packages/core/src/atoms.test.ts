// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ATOM_STAND_IN_MESSAGE, atomOf, convertAtoms } from "./atoms.ts";
import { printExpression } from "./compile.ts";
import { type Ctx, type Node, newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import type { Attr, Expr, Ir, IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
import { mappedExpr } from "./mapping.ts";
import { hintParseError } from "./parse-error-hints.ts";
import { lookup } from "./test-targets.ts";

/**
 * Decision 156 (atoms), core half: the parser hands Babel a same-length
 * numeric stand-in for each `:name`, and core turns every one back into a
 * `StringLiteral` with `extra.mxAtom = { span }` before anything reads it.
 * Every row lowers through Marko's real parse (the patched htmljs-parser this
 * repo installs), then `lower`.
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

function lowerSource(source: string, setup?: (ctx: Ctx) => void): Ir {
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
            policy(),
            undefined,
            "test.mx",
            lookup,
          );
          setup?.(ctx);
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
    "/tmp/mx-core-test/atoms.mx",
    { translator, output: "html", writeVersionComment: false },
  );
  if (thrown) throw thrown;
  if (!ir) throw new Error("no IR");
  return ir;
}

function walkIr(nodes: readonly IrNode[], visit: (node: IrNode) => void) {
  for (const node of nodes) {
    visit(node);
    const children = (node as { children?: IrNode[] }).children;
    if (children) walkIr(children, visit);
    for (const branch of (node as { branches?: { children: IrNode[] }[] })
      .branches ?? []) {
      walkIr(branch.children, visit);
    }
  }
}

function firstElement(source: string, setup?: (ctx: Ctx) => void) {
  let found: (IrNode & { kind: "Element" }) | undefined;
  walkIr(lowerSource(source, setup).body, (node) => {
    if (!found && node.kind === "Element") found = node;
  });
  if (!found) throw new Error("no element");
  return found;
}

function attr(source: string, name: string, setup?: (ctx: Ctx) => void): Attr {
  const found = firstElement(source, setup).attrs.find(
    (a) => a.kind !== "spread" && a.name === name,
  );
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

function exprOfAttr(source: string, name: string): Expr {
  const a = attr(source, name);
  if (a.kind === "static" || a.kind === "boolean" || a.kind === "spread") {
    throw new Error(`attribute ${name} is ${a.kind}`);
  }
  return a.value;
}

function errorOf(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    lowerSource(source);
  } catch (error) {
    // What `compileSource` does to a Marko parse error before rethrowing it.
    hintParseError(error, source);
    const e = error as {
      message: string;
      line?: number;
      column?: number;
      label?: string;
      loc?: { start: { line: number; column: number } };
    };
    // A Marko parse error carries `loc`; an MX `TranslateError` carries
    // `line`/`column`.
    if (e.loc?.start) {
      return {
        message: e.label ?? e.message,
        line: e.loc.start.line,
        column: e.loc.start.column,
      };
    }
    return { message: e.message, line: e.line ?? 0, column: e.column ?? 0 };
  }
  throw new Error(`expected ${JSON.stringify(source)} to fail`);
}

const span = (sourceStart: number, sourceEnd: number) => ({
  sourceStart,
  sourceEnd,
});

describe("a whole-value atom is a static attribute marked as an atom", () => {
  it.each([
    ["<div x=:a/>", "a", span(7, 9)],
    ["<div x=:rename-all/>", "rename-all", span(7, 18)],
    // `x= :b` and `x = :b`: the parser skips the space before the value.
    ["<div x= :b/>", "b", span(8, 10)],
    ["<div x = :b/>", "b", span(9, 11)],
  ])("%j", (source, name, atomSpan) => {
    const a = attr(source, "x");
    expect(a).toMatchObject({
      kind: "static",
      value: name,
      valueSpan: atomSpan,
      atom: { kind: "atom", name, span: atomSpan },
    });
  });

  it("concise mode", () => {
    expect(attr("div x=:b\n", "x")).toMatchObject({
      kind: "static",
      value: "b",
      atom: { kind: "atom", name: "b", span: span(6, 8) },
    });
  });

  it("a string is not an atom", () => {
    const a = attr('<div x="a"/>', "x");
    expect(a).toMatchObject({ kind: "static", value: "a" });
    expect("atom" in a).toBe(false);
  });
});

describe("a nested atom is a StringLiteral with extra.mxAtom", () => {
  it.each([
    [
      "<div x=[:a, :b]/>",
      '["a", "b"]',
      [
        ["a", 8],
        ["b", 12],
      ],
    ],
    ["<div x=f(:a)/>", 'f("a")', [["a", 9]]],
    ["<div x={k: :a}/>", '{k: "a"}', [["a", 11]]],
    [
      "<div x=a ? :b : :c/>",
      'a ? "b" : "c"',
      [
        ["b", 11],
        ["c", 16],
      ],
    ],
    // Decision 156: the atom's `:` is not the ternary's.
    ["<div x=a ? :b :c/>", 'a ? "b" :c', [["b", 11]]],
    ["<div x=x === :a/>", 'x === "a"', [["a", 13]]],
    ["<div x={[:a]: 1}/>", '{["a"]: 1}', [["a", 9]]],
    ["<div x=`t ${:a}`/>", '`t ${"a"}`', [["a", 12]]],
    ["<div x=() => :a/>", '() => "a"', [["a", 13]]],
  ] as const)("%j", (source, code, atoms) => {
    const value = exprOfAttr(source, "x");
    expect(value.code).toBe(code);
    expect(value.atoms).toEqual(
      atoms.map(([name, start]) => ({
        kind: "atom",
        name,
        span: span(start, start + 1 + name.length),
      })),
    );
  });

  it("the node itself is a StringLiteral carrying its span", () => {
    const value = exprOfAttr("<div x=[:a, :rename-all]/>", "x");
    const [a, b] = (value.node as Node).elements;
    expect(a).toMatchObject({ type: "StringLiteral", value: "a" });
    expect(a.extra.mxAtom).toEqual({ span: span(8, 10) });
    expect(atomOf(a)).toEqual({ kind: "atom", name: "a", span: span(8, 10) });
    expect(b).toMatchObject({ type: "StringLiteral", value: "rename-all" });
    expect(b.extra.mxAtom).toEqual({ span: span(12, 23) });
    // The printed form is the string, not the stand-in.
    expect(printExpression(value.node)).toBe('["a", "rename-all"]');
  });

  it("an expression without atoms carries no `atoms` field", () => {
    const value = exprOfAttr("<div x=[1, 2]/>", "x");
    expect("atoms" in value).toBe(false);
  });

  it("placeholders, tag arguments, attribute tags and spreads", () => {
    const ir = lowerSource(
      "<div ...{k: :s}>${:p}</div><if=x === :i>y</if><for|v| of=[:o]>${v}</for>",
    );
    const codes: string[] = [];
    walkIr(ir.body, (node) => {
      if (node.kind === "Interpolation") codes.push(node.expr.code);
      if (node.kind === "Element") {
        for (const a of node.attrs)
          if (a.kind === "spread") codes.push(a.value.code);
      }
      if (node.kind === "IfChain") {
        for (const b of node.branches)
          if (b.condition) codes.push(b.condition.code);
      }
      if (node.kind === "For" && node.source.kind === "of") {
        codes.push(node.source.list.code);
      }
    });
    expect(codes).toEqual(['{k: "s"}', '"p"', 'x === "i"', '["o"]', "v"]);
  });
});

describe("binding rewrites and atoms splice together", () => {
  it("the rewrite path splices both", () => {
    const value = exprOfAttr2("<div x=[count, :a, count + 1]/>", "x", (ctx) =>
      ctx.bindings.register("count", (name) => `${name}()`),
    );
    expect(value.code).toBe('[count(), "a", count() + 1]');
  });

  it("a shadowed name is not rewritten and the atom still is", () => {
    const value = exprOfAttr2("<div x=(count) => [count, :b]/>", "x", (ctx) =>
      ctx.bindings.register("count", (name) => `${name}()`),
    );
    expect(value.code).toBe('(count) => [count, "b"]');
  });
});

function exprOfAttr2(
  source: string,
  name: string,
  setup: (ctx: Ctx) => void,
): Expr {
  const a = attr(source, name, setup);
  if (a.kind !== "dynamic") throw new Error(`attribute ${name} is ${a.kind}`);
  return a.value;
}

describe("the name sugar keeps atom-ness (addendum 1, item 2)", () => {
  it.each([
    ["<input :email/>", span(7, 13)],
    ["<input:email/>", span(6, 12)],
    ['<input type="text" :email/>', span(19, 25)],
    ["<:email/>", span(1, 7)],
    ["<input.big:email/>", span(10, 16)],
  ])("%j", (source, atomSpan) => {
    expect(attr(source, "name")).toMatchObject({
      kind: "static",
      value: "email",
      sugar: source.slice(atomSpan.sourceStart, atomSpan.sourceEnd),
      atom: { kind: "atom", name: "email", span: atomSpan },
    });
  });

  it("an atom value plus the sugar (row 12)", () => {
    const element = firstElement("<div x=:a :b/>");
    expect(element.attrs).toMatchObject([
      { name: "x", value: "a", atom: { name: "a", span: span(7, 9) } },
      { name: "name", value: "b", atom: { name: "b", span: span(10, 12) } },
    ]);
    expect(firstElement("<div :b x=:a/>").attrs).toMatchObject([
      { name: "name", value: "b", atom: { name: "b" } },
      { name: "x", value: "a", atom: { name: "a" } },
    ]);
    const tagAdjacent = firstElement("<div:b x=[:c]/>").attrs;
    expect(tagAdjacent[0]).toMatchObject({
      name: "name",
      atom: { name: "b" },
    });
    expect(tagAdjacent[1]).toMatchObject({
      name: "x",
      value: { code: '["c"]', atoms: [{ name: "c" }] },
    });
  });

  it("`#id` and `.class` are not atoms", () => {
    const element = firstElement("<input#main.big/>");
    for (const a of element.attrs) expect("atom" in a).toBe(false);
  });
});

describe("misuse is a positioned MX error at the atom", () => {
  it.each([
    ["<div x=:a.length/>", 7, "member access"],
    ["<div x=:a?.length/>", 7, "member access"],
    ["<div x=:a[0]/>", 7, "member access"],
    ["<div x=:a(1)/>", 7, "a call"],
    ["<div x=-:a/>", 8, "the unary operator `-`"],
    ["<div x=!:a/>", 8, "the unary operator `!`"],
    ["<div x=typeof :a/>", 14, "the unary operator `typeof`"],
    ["<div x=f(...:a)/>", 12, "spreading"],
    ["<div x=[...:a]/>", 11, "spreading"],
    // Review round 2, finding 3: a tag's own spread too.
    ["<div ...:a/>", 8, "spreading"],
  ])("%j", (source, column, what) => {
    const error = errorOf(source);
    expect(error.message).toContain("is an atom (decision 156)");
    expect(error.message).toContain(what);
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
  });

  it("an atom as an object key", () => {
    const error = errorOf("<div x={:a: 1}/>");
    expect(error.message).toContain("`:a` cannot be an object key");
    expect(error.message).toContain("`[:a]`");
    expect(error.column).toBe(8);
  });

  it("allowed positions compile", () => {
    for (const source of [
      "<div x=x === :a/>",
      "<div x=[:a, {k: :b}]/>",
      "<div x=f(:a, :b)/>",
      "<div x={[:a]: 1}/>",
      "<div x=`${:a}`/>",
      "<div x=o[:a]/>",
    ]) {
      expect(() => lowerSource(source)).not.toThrow();
    }
  });

  it.each([
    // Babel rejects these on the numeric stand-in; core adds the atom hint.
    ["<div x=:a = 1/>", 7],
    ["<div x=(:a) => 1/>", 8],
    ["<div x=f({:a})/>", 12],
  ])("%j is a positioned parse error naming the atom", (source, column) => {
    const error = errorOf(source);
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
    expect(error.message).toContain(
      "is an atom (decision 156): a value, not a binding",
    );
  });

  it.each([
    ["<div x=::a/>", 7],
    ["<div x={k::a}/>", 9],
  ])("%j: the reserved `::` is positioned", (source, column) => {
    const error = errorOf(source);
    expect(error.message).toContain("`::a` is reserved (decision 156)");
    expect(error.line).toBe(1);
    expect(error.column).toBe(column);
  });
});

describe("the atom hint names only a lexed atom (review round 2)", () => {
  it.each(["$ const o = { a: :b };\n<div/>"])(
    "%j gets no atom hint",
    (source) => {
      const error = errorOf(source);
      expect(error.message).not.toContain("is an atom (decision 156)");
    },
  );
});

describe("never an atom", () => {
  it.each([
    ['<div x="s :a"/>', '"s :a"'],
    ["<div x=`t :a`/>", "`t :a`"],
    ["<div x=/ :a/g/>", "/ :a/g"],
    ["<div x=a /* :b */ + c/>", "a /* :b */ + c"],
    ["<div x=a ? b :c/>", "a ? b :c"],
    ["<div x=(x :number) => x/>", "(x :number) => x"],
  ])("%j", (source, code) => {
    const a = attr(source, "x");
    if (a.kind === "static") {
      expect(JSON.stringify(a.value)).toBe(code);
      expect("atom" in a).toBe(false);
      return;
    }
    const value = exprOfAttr(source, "x");
    expect(value.code).toBe(code);
    expect("atoms" in value).toBe(false);
  });
});

describe("the per-atom source mapping (typecheck)", () => {
  it("maps each atom to its string and the text between one to one", () => {
    // `x=[:a, :rename-all]` at 7..25 becomes `["a", "rename-all"]`.
    const value = exprOfAttr("<div x=[:a, :rename-all]/>", "x");
    const { code, mappings } = mappedExpr(value);
    expect(code).toBe('["a", "rename-all"]');
    const slices = mappings.map((m) => [
      "<div x=[:a, :rename-all]/>".slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]);
    expect(slices).toEqual([
      ["[", "["],
      [":a", '"a"'],
      [", ", ", "],
      [":rename-all", '"rename-all"'],
      ["]", "]"],
    ]);
  });

  it("an expression without atoms keeps its one whole mapping", () => {
    const value = exprOfAttr("<div x=[1, 2]/>", "x");
    expect(mappedExpr(value).mappings).toEqual([
      { ...span(7, 13), generatedStart: 0, generatedEnd: 6 },
    ]);
  });
});

describe("no stand-in survives", () => {
  it("lowering an unconverted stand-in is an internal error", () => {
    // Skip the conversion by marking it done on a tree that still holds one.
    expect(() =>
      lowerSource("<div x=[:a]/>", (ctx) => {
        ctx.atomsConverted = true;
      }),
    ).toThrow(ATOM_STAND_IN_MESSAGE);
  });

  it("an authored number is never converted", () => {
    const value = exprOfAttr("<div x=[0., 0.0]/>", "x");
    expect(value.code).toBe("[0., 0.0]");
    expect("atoms" in value).toBe(false);
  });

  it("convertAtoms over an already-converted tree changes nothing", () => {
    let seen: Ctx | undefined;
    const ir = lowerSource("<div x=[:a, :b] y=:c/>", (ctx) => {
      seen = ctx;
    });
    const ctx = seen as Ctx;
    const element = ir.body[0] as IrNode & { kind: "Element" };
    const value = (element.attrs[0] as Attr & { kind: "dynamic" }).value;
    const before = structuredClone(ctx.atoms);
    const nodes = (value.node as Node).elements as Node[];
    const marks = nodes.map((n) => structuredClone(n.extra));
    // Walk the converted expression again, and a whole-value atom's node.
    convertAtoms(ctx, [value.node]);
    expect(ctx.atoms).toEqual(before);
    expect(ctx.atoms?.map((a) => a.span.sourceStart)).toEqual([8, 12, 18]);
    nodes.forEach((n, index) => {
      expect(n.type).toBe("StringLiteral");
      expect(n.extra).toEqual(marks[index]);
    });
  });
});
