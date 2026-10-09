import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import { newCtx, TranslateError } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

/**
 * Port PR 5, review round 1 (lead ruling: PR 5 keeps today's text and
 * position). The front end reports `MX_SUGAR_BOUND` on every tag-adjacent
 * `:=`, but today a value that cannot be bound reached Marko's own binding
 * check first. Every expected value below is 9293794df's actual output
 * (the Marko parse), probed through the same two entries.
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
const BOUND_ON_SUGAR =
  "a bound value is not supported on name sugar; write name=... value:=...";
const SECOND_NAME =
  'a tag takes one `:name`; this one already has a name (write the second as `name="…"`)';

describe.each([
  ["compileSource", viaCompile],
  ["parseFragment + lower", viaFragment],
])("a tag-adjacent `:=` on the MX path (%s)", (_name, run) => {
  it.each([
    // A value that cannot be bound: Marko's binding error, at the value.
    ["<div:=1/>", BINDING, 1, 6],
    ["div:=1", BINDING, 1, 5],
    ["<div:=(1)/>", BINDING, 1, 7],
    // A bindable value: the sugar's own error, at the `:`.
    ["<div:=x/>", BOUND_ON_SUGAR, 1, 4],
    ["div:=x", BOUND_ON_SUGAR, 1, 3],
    ["<div:=a.b/>", BOUND_ON_SUGAR, 1, 4],
    ["<div:=(x)/>", BOUND_ON_SUGAR, 1, 4],
    // A later sugar error still wins over the binding error, as today: the
    // sugar check ran over the whole tree before Marko's binding check.
    ["<div:=1/>\n<a :b:c/>", SECOND_NAME, 2, 5],
  ])("%j", (source, message, line, column) => {
    const error = run(source);
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({ message, line, column });
  });

  it("an optional member is not the sugar's error and Marko binds it", () => {
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
