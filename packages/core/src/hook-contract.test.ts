/**
 * The hook contract of a dialect's trigger rows, on a test-local probe
 * dialect: method values, attribute lists, `ctx.shorthand`, `authored` and
 * `once`, the default value, `ctx.use` and `ctx.operator`, `ctx.fail`, and
 * `value: "refuse"`. Core owns this contract; no dialect's rows are used.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import type { Dialect, Trigger, TriggerUse } from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

function irOf(source: string, syntax?: Dialect): Ir {
  let ir: Ir | undefined;
  compileSource(source, "page.mx", declarations, {
    targets,
    ...(syntax ? { dialect: syntax } : {}),
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

/** A module whose single attribute row `!` (and expression row `@`) calls `hook`. */
function probe(
  hook: NonNullable<Dialect["lowerTrigger"]>,
  rows: { value?: "refuse" } = {},
): Dialect {
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
    id: "probe",
    name: "MX",
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
    const tag = first(irOf("<div !main class='a'/>", module));
    expect(attr(tag, "id")).toMatchObject({ kind: "static", value: "main" });
    // `<div#main.x class='a'/>` renders the class `x a` (Marko's merge).
    expect(attr(tag, "class")).toMatchObject({ kind: "static", value: "x a" });
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
      "takes no method value here",
    );
  });

  it.each([
    [
      "<div !a:=x/>",
      ":=",
      "`!a` takes no bound value (`:=`): the `probe` trigger cannot place one",
    ],
    [
      "<div !a(x)/>",
      "arguments",
      "`!a` takes no arguments: the `probe` trigger cannot place them",
    ],
  ])(
    "%s: `ctx.valueForm` is %s and core refuses what nothing can place",
    (source, form, message) => {
      const forms: unknown[] = [];
      const module = probe((_id, _text, _span, ctx) => {
        forms.push(ctx.valueForm);
        return ctx.attribute("x", true);
      });
      expect(caught(() => irOf(source, module)).message).toBe(message);
      expect(forms).toEqual([form]);
    },
  );

  it.each([
    ["kind !a(p) { b }\n", "method", false, 5],
    ["kind async !a(p) { b }\n", "async-method", true, 11],
    ["kind async !a<T>(p: T) { b }\n", "async-method", true, 11],
  ])(
    "%j: `ctx.valueForm` is %s, `ctx.value.async` %s, and the text span is the trigger's own",
    (source, form, isAsync, textAt) => {
      const seen: unknown[] = [];
      const module = probe((_id, _text, span, ctx) => {
        seen.push(ctx.valueForm, ctx.value, span);
        return ctx.fail("stop");
      });
      const error = caught(() => irOf(source, module));
      expect(seen).toEqual([
        form,
        { kind: "method", async: isAsync },
        { sourceStart: textAt, sourceEnd: textAt + 2 },
      ]);
      // The default `ctx.fail` position is the trigger's text, not `async`.
      expect([error.line, error.column]).toEqual([1, textAt]);
    },
  );

  it("`ctx.fail` takes a span inside the trigger and a code", () => {
    const module = probe((_id, _text, span, ctx) =>
      ctx.fail("here", {
        at: { sourceStart: span.sourceStart + 1, sourceEnd: span.sourceEnd },
        code: "FIXTURE_X",
      }),
    );
    const error = caught(() => irOf("<div !ab/>", module));
    expect(error.message).toBe("here");
    expect(error.diagnosticCode).toBe("FIXTURE_X");
    expect([error.line, error.column]).toEqual([1, 6]);
  });

  it("`ctx.fail` refuses a code that starts with `MX_`, MX's own prefix", () => {
    const module = probe((_id, _text, _span, ctx) =>
      ctx.fail("here", { code: "MX_UNKNOWN_TAG" }),
    );
    const error = caught(() => irOf("<div !ab/>", module));
    expect(error.diagnosticCode).toBe("MX_DIALECT_HOOK_ERROR");
    expect(error.message).toContain(
      "`ctx.fail`'s code `MX_UNKNOWN_TAG` starts with `MX_`, which is MX's own prefix",
    );
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
