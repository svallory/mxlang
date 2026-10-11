import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import { newCtx, TranslateError } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

/**
 * A tag-adjacent `:=` (`<div:=x/>`) is Marko's bound default value
 * (`value:=x`): a value that cannot be bound is Marko's binding error, at the
 * value, and a bindable one compiles (stock `@marko/compiler` 5.42.11 on
 * `htmljs-parser` 5.18.0, probed: `<div:=x/>`, `div:=x` and `<div:=a.b/>`
 * compile, `<div:=1/>` is the binding error at 1:7).
 */

const FILE = "/tmp/mx-core-test/bound.mx";

function policy(): Policy {
  return {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
    resolveDefaultTag: () => "input",
  };
}

function viaCompile(source: string): unknown {
  try {
    compileSource(source, FILE, policy(), {
      targets: lookup,
      emitIr: () => "",
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

function viaFragment(source: string): unknown {
  try {
    const ctx = newCtx(
      source,
      printExpression,
      policy(),
      undefined,
      FILE,
      lookup,
    );
    lower(ctx, parseFragment(source).body);
  } catch (error) {
    return error;
  }
  return undefined;
}

const BINDING =
  "Attributes may only be bound to identifiers or member expressions";
describe.each([
  ["compileSource", viaCompile],
  ["parseFragment + lower", viaFragment],
])("a tag-adjacent `:=` on the MX path (%s)", (_name, run) => {
  it.each([
    // A value that cannot be bound: Marko's binding error, at the value.
    ["<div:=1/>", 1, 6],
    ["div:=1", 1, 5],
    ["<div:=(1)/>", 1, 7],
  ])("%j", (source, line, column) => {
    const error = run(source);
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({ message: BINDING, line, column });
  });

  it.each(["<div:=x/>", "div:=x", "<div:=a.b/>", "<div:=(x)/>"])(
    "%j: a bindable value compiles, as in Marko",
    (source) => {
      expect(run(source)).toBeUndefined();
    },
  );

  it("an optional member is bound too", () => {
    expect(run("<div:=a?.b/>")).toBeUndefined();
  });
});

// Review round 1: Marko kept a bound value that failed to parse as its
// parse-error node, so a fragment lowered that attribute's binding check
// first; a compile reports the parse error (9293794df, both routes).
describe("a bound value that does not parse", () => {
  it.each([
    ["<div:=this.#x/>", 1, 6],
    ["div:=this.#x", 1, 5],
    ["<div :=this.#x/>", 1, 7],
    ["<div x:=this.#x/>", 1, 8],
    ["<div:=this.#x.y/>", 1, 6],
    ["<div x:=(a b)/>", 1, 8],
  ])(
    "%j through parseFragment + lower: the binding error at the value",
    (source, line, column) => {
      const error = viaFragment(source);
      expect(error).toBeInstanceOf(TranslateError);
      expect(error).toMatchObject({ message: BINDING, line, column });
    },
  );

  it.each([
    ["<div:=this.#x/>", "Private name #x is not defined.", 1, 11],
    ["div:=this.#x", "Private name #x is not defined.", 1, 10],
    ["<div x:=this.#x/>", "Private name #x is not defined.", 1, 13],
    ["<div x:=(a b)/>", 'Unexpected token, expected ","', 1, 11],
  ])(
    "%j through compileSource: Marko's parse error",
    (source, label, line, column) => {
      const error = viaCompile(source) as {
        name: string;
        label: string;
        loc: { start: { line: number; column: number } };
      };
      expect(error.name).toBe("CompileError");
      expect(error.label).toBe(label);
      expect(error.loc.start).toMatchObject({ line, column });
    },
  );

  it("an unbound value keeps its own parse error on the fragment route", () => {
    expect(viaFragment("<div x=this.#x/>")).toMatchObject({
      message: "Private name #x is not defined.",
      line: 1,
      column: 12,
    });
  });
});
