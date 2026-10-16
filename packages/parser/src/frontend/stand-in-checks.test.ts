/**
 * An expression trigger is parsed from a same-length stand-in: an identifier
 * (`&name` is `_name`) or a number (`#1` is `0.`). Babel's strict-mode and
 * assignment checks look at that shape, though the dialect lowers the trigger
 * to something else (`self.name`). These pin that a check about the stand-in
 * alone is dropped, a check about the user's own code is not, and that the
 * reparse that tells them apart runs only when it can matter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mxlang/babel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mxlang/babel")>();
  return {
    ...actual,
    parse: vi.fn(actual.parse),
    parseExpression: vi.fn(actual.parseExpression),
  };
});

import { parse as babelParse, parseExpression } from "@mxlang/babel";
import {
  DEFAULT_SYNTAX,
  type SyntaxTable,
  type Trigger,
} from "../template/index.ts";
import { parse } from "./parse.ts";
import { OPTIONS } from "./test-support/options.ts";

const MEMBER: Trigger = {
  id: "member",
  chars: "&",
  match: "&[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]*",
  standIn: "identifier",
  node: { call: "member" },
};
const NUMBER: Trigger = {
  id: "slot",
  chars: "#",
  match: "#[0-9]+",
  standIn: "number",
  node: { call: "slot" },
};
const KEEP: Trigger = {
  id: "keep",
  chars: "@",
  match: "@[a-z]+",
  standIn: "keep",
  node: { call: "keep" },
};

const table = (...triggers: Trigger[]): SyntaxTable => ({
  ...DEFAULT_SYNTAX,
  expressionTriggers: triggers,
});
const WITH_MEMBER = table(MEMBER);
const WITH_NUMBER = table(NUMBER);

// biome-ignore lint/suspicious/noExplicitAny: reads nodes of every shape
type Node = any;

const run = (source: string, syntax: SyntaxTable) =>
  parse(source, { ...OPTIONS, syntax });

/** `[code, message, start]` of each error. */
const errorsOf = (source: string, syntax: SyntaxTable) =>
  run(source, syntax).errors.map((error) => [
    error.code,
    error.message,
    error.start,
  ]);

const DELETE = "Deleting local variable in strict mode.";
const LHS = "Invalid left-hand side in assignment expression.";

afterEach(() => {
  vi.mocked(parseExpression).mockClear();
  vi.mocked(babelParse).mockClear();
});

describe("`delete` on an identifier stand-in", () => {
  it.each([
    ["an attribute value", "x=() => { return delete &name }"],
    ["an arrow body", "x=() => delete &name"],
    ["parentheses", "x=() => delete (&name)"],
    ["nested parentheses", "x=() => delete ((&name))"],
    ["a method body", "x() { return delete &name }"],
    ["a placeholder", `-- $${"{"}delete &name}`],
    ["a tag attribute", "div class=(delete &name)"],
  ])("parses in %s", (_, source) => {
    const document = run(source, WITH_MEMBER);
    expect(document.errors).toEqual([]);
  });

  it("leaves a marked stand-in as the operand", () => {
    const document = run("x=() => delete &name", WITH_MEMBER);
    const body: Node = (document.body[0] as Node).attributes[0].value.node.body;
    expect(body).toMatchObject({
      type: "UnaryExpression",
      operator: "delete",
      argument: {
        type: "Identifier",
        name: "_name",
        start: 15,
        end: 20,
        extra: { mxTrigger: { id: "member", text: "&name" } },
      },
    });
  });

  it("pins the forms that never failed: typeof, plain use, assignment, update", () => {
    for (const source of [
      "x=() => typeof &name",
      "x=() => &name",
      "x=() => { &name = 1 }",
      "x=() => { &name++ }",
      "x=() => { for (&k of y) {} }",
      "x=() => { [&a] = y }",
      "x=() => delete &name.x",
      "x=() => delete &name()",
    ])
      expect(run(source, WITH_MEMBER).errors, source).toEqual([]);
  });

  it("keeps Babel's message at the same place for a real `delete x`", () => {
    // Offsets are those of the same sources without the trigger on main.
    expect(errorsOf("x=() => { let q; return delete q }", WITH_MEMBER)).toEqual(
      [["BABEL_StrictDelete", DELETE, 24]],
    );
    expect(
      errorsOf("x=() => { let q; return delete q }", DEFAULT_SYNTAX),
    ).toEqual([["BABEL_StrictDelete", DELETE, 24]]);
    expect(errorsOf("x=() => delete (q)", WITH_MEMBER)).toEqual([
      ["BABEL_StrictDelete", DELETE, 8],
    ]);
  });

  it("reports a real `delete x` beside a trigger, before or after it", () => {
    expect(
      errorsOf("x=() => { delete q; return delete &n }", WITH_MEMBER),
    ).toEqual([["BABEL_StrictDelete", DELETE, 10]]);
    expect(errorsOf("x=() => { delete &n; delete q }", WITH_MEMBER)).toEqual([
      ["BABEL_StrictDelete", DELETE, 21],
    ]);
    expect(
      errorsOf("x=() => { delete &n; delete q; delete &m }", WITH_MEMBER),
    ).toEqual([["BABEL_StrictDelete", DELETE, 21]]);
  });

  it("reports `delete` of a name that only looks like a stand-in", () => {
    // `_name` is the stand-in's text, but this one is the user's own.
    expect(
      errorsOf("x=() => { let _name; delete _name; &name }", WITH_MEMBER),
    ).toEqual([["BABEL_StrictDelete", DELETE, 21]]);
  });

  it("reports a later syntax error that is not recoverable", () => {
    const errors = errorsOf("x=() => { delete &n; 1 +* }", WITH_MEMBER);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toMatch(/^BABEL_/);
    expect(errors[0]?.[1]).not.toBe(DELETE);
  });

  it("reports the real error of a statements container too", () => {
    // A method body is a statements container.
    expect(errorsOf("x() { delete &n; delete q }", WITH_MEMBER)).toEqual([
      ["BABEL_StrictDelete", DELETE, 17],
    ]);
  });
});

describe("assignment to a number stand-in", () => {
  it.each([
    "x=() => { #1 = 2 }",
    "x=() => { #1 += 2 }",
    "x=() => { #1 &&= 2 }",
    "x=() => { #1++ }",
    "x=() => { --#1 }",
    "x=() => { for (#1 of y) {} }",
    "x=() => { for (#1 in y) {} }",
    "x=() => { [#1] = y }",
    "x=() => { [#1 = 1] = y }",
    "x=() => { ({ a: #1 } = y) }",
    "x=() => { [...#1] = y }",
    "x=() => { (#1) = 2 }",
    "x=() => { ((#1)) = 2 }",
    "x=() => delete #1",
    "x=() => #1",
  ])("parses %s", (source) => {
    expect(run(source, WITH_NUMBER).errors).toEqual([]);
  });

  it("keeps Babel's message for what the user wrote", () => {
    expect(errorsOf("x=() => { 1 = 2 }", WITH_NUMBER)).toEqual([
      ["BABEL_InvalidLhs", LHS, 10],
    ]);
    // The trigger starts the left side but is not the target.
    expect(errorsOf("x=() => { #1 + 2 = 3 }", WITH_NUMBER)).toEqual([
      ["BABEL_InvalidLhs", LHS, 10],
    ]);
    expect(errorsOf("x=() => { #1.x + 2 = 3 }", WITH_NUMBER)).toEqual([
      ["BABEL_InvalidLhs", LHS, 10],
    ]);
    expect(errorsOf("x=() => { 1 = 2; #1 = 3 }", WITH_NUMBER)).toEqual([
      ["BABEL_InvalidLhs", LHS, 10],
    ]);
    expect(errorsOf("x=() => { #1 = 3; 1 = 2 }", WITH_NUMBER)).toEqual([
      ["BABEL_InvalidLhs", LHS, 18],
    ]);
    expect(errorsOf("x=() => { [1] = y }", WITH_NUMBER)).toEqual([
      [
        "BABEL_InvalidLhs",
        "Invalid left-hand side in array destructuring pattern.",
        11,
      ],
    ]);
  });
});

describe("what the stand-in kind does not change", () => {
  it("`with` is the user's own statement and keeps its error", () => {
    expect(errorsOf("x=() => { with (&n) {} }", WITH_MEMBER)).toEqual([
      ["BABEL_StrictWith", "'with' in strict mode.", 10],
    ]);
  });

  it("a duplicated parameter keeps its error", () => {
    expect(errorsOf("x=((&a, &a) => 1)", WITH_MEMBER)[0]?.[1]).toBe(
      "Argument name clash.",
    );
  });

  it("a `keep` trigger has no stand-in to forgive", () => {
    const syntax = table(KEEP);
    expect(errorsOf("x=() => { return delete q }", syntax)).toEqual([
      ["BABEL_StrictDelete", DELETE, 17],
    ]);
  });
});

describe("the reparse", () => {
  const calls = () => vi.mocked(parseExpression).mock.calls.length;
  const fileCalls = () => vi.mocked(babelParse).mock.calls.length;

  it("does not run for an error in a container with no triggers", () => {
    run("x=() => { let q; return delete q }", WITH_MEMBER);
    expect(calls()).toBe(1);
    run("x=() => { let q; return delete q }", DEFAULT_SYNTAX);
    expect(calls()).toBe(2);
  });

  it("does not run when the parse succeeds", () => {
    run("x=() => &name", WITH_MEMBER);
    expect(calls()).toBe(1);
  });

  it("does not run for an error that no stand-in shape can raise", () => {
    expect(run("x=(1 +* &n)", WITH_MEMBER).errors).toHaveLength(1);
    expect(calls()).toBe(1);
  });

  it("runs once for a shape check, and errorRecovery is only on that run", () => {
    run("x=() => delete &name", WITH_MEMBER);
    expect(calls()).toBe(2);
    const options = vi
      .mocked(parseExpression)
      .mock.calls.map((call) => call[1]);
    expect(options[0]?.errorRecovery).toBeUndefined();
    expect(options[1]?.errorRecovery).toBe(true);
  });

  it("runs once for a real shape error beside a trigger and reports it", () => {
    run("x=() => { delete &n; delete q }", WITH_MEMBER);
    expect(calls()).toBe(2);
  });

  it("covers a statements container the same way", () => {
    run("x() { return delete q }", DEFAULT_SYNTAX);
    expect(fileCalls()).toBe(1);
    run("x() { return delete &name }", WITH_MEMBER);
    expect(fileCalls()).toBe(3);
  });
});
