/**
 * Slice a1 of `lang-ext-move-sugars-to-mesh` (decisions 183 and 196): the
 * hook-contract additions the atoms-and-sugars module needs (method values,
 * attribute lists, `ctx.shorthand`, `authored`/`once`, the default value,
 * `ctx.use`/`ctx.operator`, `ctx.fail`, `value: "refuse"`) and the
 * reference module itself against core's built-in path. The existing atom
 * and sugar suites run through the module in `scripts/sugar-module.ts`.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import atomsSugars, {
  ATOM,
  CLASS_SUGAR,
  ID_SUGAR,
  NAME_SUGAR,
} from "./syntax/atoms-sugars.ts";
import meshSyntax from "./syntax/mesh.ts";
import type { SyntaxModule, Trigger, TriggerUse } from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

function irOf(source: string, syntax?: SyntaxModule): Ir {
  let ir: Ir | undefined;
  compileSource(source, "page.mx", declarations, {
    targets,
    ...(syntax ? { syntax } : {}),
    emitIr: (lowered) => {
      ir = lowered;
      return "";
    },
  });
  return ir as Ir;
}

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    if (!(error instanceof TranslateError)) throw error;
    return error;
  }
  throw new Error("expected an error");
}

type Element = Extract<IrNode, { kind: "Element" }>;

function first(ir: Ir): Element {
  const node = ir.body.find((each) => each.kind === "Element");
  if (!node) throw new Error("no element");
  return node as Element;
}

function attr(node: Element, name: string): Attr {
  const found = node.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

/** The IR as JSON, so two lowerings compare field by field. */
function json(ir: Ir): unknown {
  return JSON.parse(JSON.stringify(ir.body));
}

describe("the reference module lowers exactly as core's built-in path", () => {
  it.each([
    "<div x=:a/>",
    "<div x=[:draft, :sent] y=(() => s === :sent)/>",
    "<div x=(c ? :a : :b)/>",
    "<p>${:rename-all}</p>",
    "<${:a}/>",
    "<input type='email' :email/>",
    "<div :a :b/>",
    "<div #main .big .small/>",
    "<div.a class='b' .c/>",
    "<div #m.big:named/>",
    "<div x=a.b .c/>",
    "<div x=1 #i .c :n/>",
    "<input:q.search type=:search/>",
    "entity :Invoice table='invoices'\n  enum :status values=[:draft, :sent] default=:draft\n",
    "<input :x=input.y/>",
    "kind :n=1\n",
  ])("%s", (source) => {
    expect(json(irOf(source, atomsSugars))).toEqual(json(irOf(source)));
  });

  it.each([
    ["<div x=(:a).b/>", "member access"],
    ["<div x=f(:a)/>", null],
    ["<div x=(:a)()/>", "a call"],
    ["<div x=-:a/>", "the unary operator `-`"],
    ["<div x=typeof :a/>", "the unary operator `typeof`"],
    ["<div x=[...:a]/>", "spreading"],
    ["<div ...:a/>", "spreading"],
  ])("atom misuse %s is refused in the built-in words", (source, what) => {
    if (what === null) {
      expect(json(irOf(source, atomsSugars))).toEqual(json(irOf(source)));
      return;
    }
    const module = caught(() => irOf(source, atomsSugars));
    const builtIn = caught(() => irOf(source));
    expect(module.message).toBe(builtIn.message);
    expect(module.message).toContain(what);
    expect([module.line, module.column]).toEqual([
      builtIn.line,
      builtIn.column,
    ]);
  });

  it("an atom as an object key is the module's words, not core's", () => {
    const error = caught(() => irOf("<div x={ :a: 1 }/>", atomsSugars));
    expect(error.message).toContain("cannot be an object key");
  });

  it("`::name` is reserved, in the built-in words (raised in lowering, not by the parser)", () => {
    const reserved =
      "`::a` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:a` for an atom";
    expect(caught(() => irOf("<div x=::a/>", atomsSugars)).message).toBe(
      reserved,
    );
    let builtIn = "";
    try {
      irOf("<div x=::a/>");
    } catch (error) {
      builtIn = (error as Error).message;
    }
    expect(builtIn).toContain(reserved);
  });

  it("`:a:b` in one token is one name too many", () => {
    expect(caught(() => irOf("<div :a:b/>", atomsSugars)).message).toContain(
      "a tag takes one `:name`",
    );
  });

  it("the combined Mesh module keeps the member rows beside them", () => {
    const tag = first(irOf("sort asc &dueOn :n x=[&a, :b]\n", meshSyntax));
    expect(attr(tag, "member")).toMatchObject({
      kind: "static",
      value: "dueOn",
    });
    expect(attr(tag, "name")).toMatchObject({
      kind: "static",
      value: "n",
      atom: { name: "n" },
    });
    const x = attr(tag, "x");
    if (x.kind !== "dynamic") throw new Error(x.kind);
    expect(x.value.code).toBe('[self.a, "b"]');
  });
});

describe("what the module path refuses or reads differently (decision 183)", () => {
  it.each([
    ["<div #x=1/>", "The `#x` shorthand takes no value."],
    ["<div .c=1/>", "The `.c` shorthand takes no value."],
    ["kind #x(p) { b }\n", "The `#x` shorthand takes no value."],
    ["<div .a.b:=c/>", "The `.a.b` shorthand takes no value."],
  ])("%s", (source, message) => {
    expect(caught(() => irOf(source, atomsSugars)).message).toContain(message);
  });

  it("a second default value is refused as on the built-in path", () => {
    expect(caught(() => irOf("kind=1 :x=2\n", atomsSugars)).message).toBe(
      caught(() => irOf("kind=1 :x=2\n")).message,
    );
  });
});

/** A module whose single attribute row `!` (and expression row `@`) calls `hook`. */
function probe(
  hook: NonNullable<SyntaxModule["lowerTrigger"]>,
  rows: { value?: "refuse" } = {},
): SyntaxModule {
  const attribute: Trigger = {
    id: "probe",
    chars: "!",
    match: "![a-z]+",
    standIn: "keep",
    node: { call: "probe" },
    ...rows,
  };
  const expression: Trigger = {
    id: "at",
    chars: "@",
    match: "@[a-z]+",
    standIn: "identifier",
    node: { call: "at" },
  };
  return {
    table: { attributeTriggers: [attribute], expressionTriggers: [expression] },
    lowerTrigger: hook,
  };
}

describe("hook contract additions", () => {
  it("`ctx.shorthand` is Marko's tag-adjacent shorthand: one id, classes merged in order", () => {
    const module = probe((_id, text, _span, ctx) => [
      ctx.shorthand("id", text.slice(1)),
      ctx.shorthand("class", "x"),
    ]);
    const tag = first(irOf("<div !main class='a' .b/>", module));
    const builtIn = first(irOf("<div #main.x class='a' .b/>"));
    expect(attr(tag, "id")).toMatchObject({ kind: "static", value: "main" });
    expect(attr(tag, "class")).toMatchObject({
      kind: "static",
      value: (attr(builtIn, "class") as { value: string }).value,
    });
  });

  it("`ctx.attribute(null, value)` is the tag's default value", () => {
    const module = probe((_id, _text, _span, ctx) =>
      ctx.attribute(null, ctx.value ?? "none"),
    );
    const tag = first(irOf("kind !a=1\n", module));
    const value = attr(tag, "value");
    if (value.kind !== "dynamic") throw new Error(value.kind);
    expect(value.value.code).toBe("1");
  });

  it("`authored` names the token in a duplicate warning; `once` is the module's error", () => {
    const once = probe((_id, _text, _span, ctx) =>
      ctx.attribute("x", "1", { once: "one x only" }),
    );
    expect(caught(() => irOf("<div !a x='0'/>", once)).message).toBe(
      "one x only",
    );
    const authored = probe((_id, text, _span, ctx) =>
      ctx.attribute("x", "1", { authored: true }),
    );
    expect(attr(first(irOf("<div !a/>", authored)), "x")).toMatchObject({
      sugar: "!a",
    });
  });

  it("an unused method value is refused (a used one is pinned in data)", () => {
    const drops = probe((_id, _text, _span, ctx) => ctx.attribute("x", true));
    expect(caught(() => irOf("kind !a() { b }\n", drops)).message).toContain(
      "takes no `=value` here",
    );
  });

  it("`ctx.fail` takes a span inside the trigger and a code", () => {
    const module = probe((_id, _text, span, ctx) =>
      ctx.fail("here", {
        at: { sourceStart: span.sourceStart + 1, sourceEnd: span.sourceEnd },
        code: "MESH_X",
      }),
    );
    const error = caught(() => irOf("<div !ab/>", module));
    expect(error.message).toBe("here");
    expect(error.code).toBe("MESH_X");
    expect([error.line, error.column]).toEqual([1, 6]);
  });

  it('`value: "refuse"` is a parser error at the operator', () => {
    const module = probe((_id, _text, _span, ctx) => ctx.attribute("x", true), {
      value: "refuse",
    });
    const error = caught(() => irOf("<div !a=1/>", module));
    expect(error.message).toContain("The `!a` shorthand takes no value.");
    expect([error.line, error.column]).toEqual([1, 7]);
  });

  it.each<[string, TriggerUse, string | null]>([
    ["<div x=@a/>", null, null],
    ["<div x=@a.b/>", "member-object", null],
    ["<div x=@a()/>", "callee", null],
    ["<div x=@a`t`/>", "callee", null],
    ["<div x=!@a/>", "unary", "!"],
    ["<div x=[...@a]/>", "spread", null],
    ["<div ...@a/>", "spread", null],
    ["<div x={ @a: 1 }/>", "key", null],
  ])("`ctx.use` for %s", (source, use, operator) => {
    const seen: [TriggerUse, string | null][] = [];
    const module = probe((_id, _text, _span, ctx) => {
      seen.push([ctx.use, ctx.operator]);
      return ctx.expression({ type: "Identifier", name: "z" });
    });
    try {
      irOf(source, module);
    } catch {
      // A property name is refused by core after the hook returns.
    }
    expect(seen).toEqual([[use, operator]]);
  });

  it("`ctx.fail` is a positioned error at the trigger in the module's words", () => {
    const module = probe((_id, _text, _span, ctx) => ctx.fail("not here"));
    const error = caught(() => irOf("<div !a x=1/>", module));
    expect(error.message).toBe("not here");
    expect([error.line, error.column]).toEqual([1, 5]);
  });
});

describe("the reference rows", () => {
  it("are frozen data a manifest can name", () => {
    for (const row of [ATOM, NAME_SUGAR, ID_SUGAR, CLASS_SUGAR]) {
      expect(Object.isFrozen(row)).toBe(true);
    }
    expect(Object.isFrozen(atomsSugars)).toBe(true);
  });
});
