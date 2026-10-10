import { describe, expect, it } from "vitest";
import type { Node } from "./core.ts";
import { TranslateError } from "./core.ts";
import { payloadOf } from "./payload.ts";

/** An `MxExpression` the way the MX front end builds one. */
const expression = (fields: Partial<Record<string, unknown>>): Node => ({
  type: "MxExpression",
  source: "",
  outer: { start: 0, end: 0 },
  node: null,
  error: null,
  atoms: [],
  start: 0,
  end: 0,
  ...fields,
});

const parseError = (start: number, message = "Unexpected token") => ({
  type: "MxParseError",
  code: "BABEL_UnexpectedToken",
  origin: "expression",
  message,
  context: null,
  start,
  end: start,
});

const trigger = (id: string, start: number) => ({
  type: "MxTrigger",
  id,
  position: "expression",
  text: `&${id}`,
  value: null,
  start,
  end: start + id.length + 1,
});

/** The error `run` throws, as its message and the MX offsets `fail` kept. */
const thrown = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TranslateError);
    const e = error as TranslateError;
    return { message: e.message, span: e.span };
  }
  throw new Error("no error thrown");
};

describe("payloadOf", () => {
  it("returns the Babel payload of a parsed container", () => {
    const node = { type: "Identifier", name: "x" };
    expect(payloadOf(expression({ node }))).toBe(node);
  });

  it("returns a statements container's array, even an empty one", () => {
    const statements = [{ type: "EmptyStatement" }];
    const container = {
      ...expression({ node: statements }),
      type: "MxStatements",
    };
    expect(payloadOf(container)).toBe(statements);
    const empty: Node[] = [];
    expect(payloadOf({ ...container, node: empty })).toBe(empty);
  });

  it("fails at the MxParseError of an unparsed container", () => {
    expect(
      thrown(() =>
        payloadOf(expression({ error: parseError(4, "Missing )") })),
      ),
    ).toEqual({ message: "Missing )", span: { sourceStart: 4, sourceEnd: 4 } });
  });

  it("fails at the first expression trigger, before a parse error", () => {
    const container = expression({
      triggers: [trigger("a", 2), trigger("b", 6)],
      error: parseError(9),
    });
    expect(thrown(() => payloadOf(container))).toEqual({
      message: "`a` trigger has no lowering yet",
      span: { sourceStart: 2, sourceEnd: 4 },
    });
  });

  it("fails at a trigger even when the container parsed", () => {
    const container = expression({
      node: { type: "Identifier", name: "status" },
      triggers: [trigger("status", 5)],
    });
    expect(thrown(() => payloadOf(container)).message).toBe(
      "`status` trigger has no lowering yet",
    );
  });

  it("ignores an empty trigger list", () => {
    const node = { type: "Identifier", name: "x" };
    expect(payloadOf(expression({ node, triggers: [] }))).toBe(node);
  });

  it("fails a container with neither a payload nor an error as an internal bug", () => {
    expect(thrown(() => payloadOf(expression({ start: 3, end: 7 })))).toEqual({
      message:
        "`MxExpression` has neither a payload nor an error (not yours: an internal bug)",
      span: { sourceStart: 3, sourceEnd: 7 },
    });
  });
});
