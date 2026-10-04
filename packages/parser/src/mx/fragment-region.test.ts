import type { File } from "@babel/types";
import { describe, expect, it } from "vitest";
import { parse, print } from "../index.ts";
import type {
  MxRegionCompile,
  MxRegionCompileInput,
} from "./region-compile.ts";
import { solidRegionCompile } from "./test-helpers.ts";

/**
 * The error a run threw, as text plus its structured position. Every MX-raised
 * diagnostic carries `loc` (1-based line, 0-based column) and no longer
 * repeats Babel's 0-based ` (L:C)` suffix in its text, so the position is
 * asserted where it is authoritative.
 */
function caught(run: () => unknown): {
  message: string;
  loc: { line: number; column: number };
} {
  try {
    run();
  } catch (error) {
    const e = error as Error & {
      loc?: { line: number; column: number; index: number };
    };
    const loc = e.loc;
    if (!loc) throw new Error("expected a positioned MX error");
    expect(e.message).not.toMatch(/\s*\(\d+:\d+\)\s*$/);
    return { message: e.message, loc: { line: loc.line, column: loc.column } };
  }
  throw new Error("expected a positioned MX error");
}

/** Hands back the region text as a string literal, and records what it got. */
function recordingHook(): {
  hook: MxRegionCompile;
  calls: MxRegionCompileInput[];
} {
  const calls: MxRegionCompileInput[] = [];
  return {
    calls,
    hook: (input) => {
      calls.push(input);
      return { code: JSON.stringify(input.source) };
    },
  };
}

/** `const view = …;` initializer, the shape these assert on. */
function initializer(file: File): {
  type: string;
  value?: string;
  start: number;
  end: number;
  extra?: { mx?: { range?: [number, number] } };
} {
  const statement = file.program.body.find(
    (node) => node.type === "VariableDeclaration",
  ) as unknown as { declarations: Array<{ init: never }> };
  return statement.declarations[0]?.init as never;
}

const parseFragmentRegions = (source: string, hook: MxRegionCompile) =>
  parse(source, "t.ng.mx", {
    mx: true,
    mxRegionCompile: hook,
    mxRegionFragment: true,
  });

describe("mxRegionFragment: `<>…</>` is a region", () => {
  it("hands the host the fragment's children, and the position of the first", () => {
    const { hook, calls } = recordingHook();
    const source = "const view = <><b>hi</b><i/></>;";
    const file = parseFragmentRegions(source, hook);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fragment).toBe(true);
    expect(calls[0]?.source).toBe("<b>hi</b><i/>");
    expect(source.slice(calls[0]?.baseOffset)).toMatch(
      /^<b>hi<\/b><i\/><\/>;$/,
    );
    expect(calls[0]?.baseLine).toBe(0);
    expect(calls[0]?.baseColumn).toBe(15);
    // The node that replaces the fragment is the host's code, and its range
    // is the whole `<>…</>`.
    const node = initializer(file);
    expect(node.type).toBe("StringLiteral");
    expect(node.value).toBe("<b>hi</b><i/>");
    const range = node.extra?.mx?.range;
    expect(source.slice(range?.[0], range?.[1])).toBe("<><b>hi</b><i/></>");
  });

  it("locates children on a later line and column", () => {
    const { hook, calls } = recordingHook();
    const source = "\n\n  const view = <>\n<b/></>;";
    parseFragmentRegions(source, hook);
    expect(calls[0]?.baseLine).toBe(2);
    expect(calls[0]?.baseColumn).toBe(17);
    expect(calls[0]?.source).toBe("\n<b/>");
  });

  it.each([
    ["<></>", ""],
    ["<>text</>", "text"],
    ["<>a ${b} c</>", "a ${b} c"],
    ["<>\n  <p/>\n  <p/>\n</>", "\n  <p/>\n  <p/>\n"],
  ])("takes %j as a region whose children are %j", (fragment, children) => {
    const { hook, calls } = recordingHook();
    parseFragmentRegions(`const view = ${fragment};`, hook);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe(children);
  });

  it("is not a region without the option: `<>` stays a TSX fragment", () => {
    const { hook, calls } = recordingHook();
    const file = parse("const view = <>hi</>;", "t.ng.mx", {
      mx: true,
      mxRegionCompile: hook,
    });
    expect(calls).toHaveLength(0);
    expect(initializer(file).type).toBe("JSXFragment");
  });

  it("leaves a `.solid.mx` fragment TSX, with its MX children lowered singly", () => {
    const out = print("const el = <><p>x</p><p>y</p></>;", "t.solid.mx", {
      mxRegionCompile: solidRegionCompile,
    });
    expect(out.code).toBe("const el = <><p>x</p><p>y</p></>;");
  });

  it("keeps ordinary regions unchanged when the option is on", () => {
    const { hook, calls } = recordingHook();
    parseFragmentRegions("const view = <b>hi</b>;", hook);
    expect(calls[0]?.fragment).toBe(false);
    expect(calls[0]?.source).toBe("<b>hi</b>");
  });

  it("refuses a nested fragment", () => {
    const { hook } = recordingHook();
    expect(
      caught(() => parseFragmentRegions("const v = <><><b/></></>;", hook)),
    ).toMatchObject({
      message:
        "A fragment `<>…</>` cannot contain another fragment. Its children are already siblings.",
      loc: { line: 1, column: 12 },
    });
  });

  it("names the fragment when it is never closed", () => {
    const { hook } = recordingHook();
    expect(
      caught(() => parseFragmentRegions("const v = <><b/>;", hook)),
    ).toMatchObject({
      message: "Unterminated fragment: expected a closing `</>`.",
      loc: { line: 1, column: 10 },
    });
  });

  it("refuses a mismatched close, without naming the synthetic root", () => {
    const { hook } = recordingHook();
    let message = "";
    try {
      parseFragmentRegions("const v = <><b></i></>;", hook);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("${_}");
    expect(message).not.toBe("");
  });
});

describe("several bare roots", () => {
  const RULE =
    "An MX region has exactly one root element. Wrap sibling elements in a fragment, `<>…</>`.";

  /**
   * The rule's text, plus the position it was raised at. The text carries no
   * `(L:C)` any more — the raise puts it on `loc`, where an editor reads it.
   */
  it.each([
    ["const el = <p>x</p><p>y</p>;", { line: 1, column: 19 }],
    ["const el = <p>x</p> <p>y</p>;", { line: 1, column: 20 }],
    ["const el = <if=a>x</if><if=b>y</if>;", { line: 1, column: 23 }],
    ["const el = <b/>\n<c/>;", { line: 2, column: 0 }],
    ["f(<b/><c/>);", { line: 1, column: 6 }],
  ])("names the rule in .solid.mx for %j", (source, loc) => {
    expect(
      caught(() =>
        print(source, "t.solid.mx", { mxRegionCompile: solidRegionCompile }),
      ),
    ).toEqual({ message: RULE, loc });
  });

  it("names the rule with a plain hook too (the check is the shared bridge's)", () => {
    const { hook } = recordingHook();
    expect(
      caught(() =>
        parse("const el = <p/><p/>;", "t.ng.mx", {
          mx: true,
          mxRegionCompile: hook,
        }),
      ),
    ).toEqual({ message: RULE, loc: { line: 1, column: 15 } });
  });

  it("names the rule for a fragment followed by a root", () => {
    const { hook } = recordingHook();
    expect(
      caught(() => parseFragmentRegions("const el = <>a</><b/>;", hook)),
    ).toEqual({ message: RULE, loc: { line: 1, column: 17 } });
  });

  // The rewrite only replaces a failure. Each of these parsed before it
  // existed (TypeScript reads the second `<` as a comparison, or the two
  // elements are JSX siblings) and must print exactly what it printed then.
  it.each([
    ["const x = <b/> < c;", "const x = <b></b> < c;"],
    ["const x = <b/> <c;", "const x = <b></b> < c;"],
    ["const x = <b/> <c>;", "const x = <b></b><c>;"],
    ["const x = <b/> > c;", "const x = <b></b> > c;"],
    ["const x = (<b/>) < c;", "const x = <b></b> < c;"],
    ["f(<b/> < c);", "f(<b></b> < c);"],
    ["f(<b/> <c);", "f(<b></b> < c);"],
    ["f(<b/>, 1);", "f(<b></b>, 1);"],
    ["const x = <div><b/><c/></div>;", "const x = <div><b></b><c></c></div>;"],
    [
      "const x = <div><b/>\n<c/></div>;",
      "const x = <div><b></b><c></c>\n</div>;",
    ],
    ["const x = <><b/><c/></>;", "const x = <><b></b><c></c></>;"],
    ["const x = <><b/>\n<c/></>;", "const x = <><b></b>\n<c></c></>;"],
    [
      "const x = <div><b>x</b> <if=a>y</if></div>;",
      "const x = <div><b>x</b> <Show when={a}><>y</></Show></div>;",
    ],
    ["const x = <div><b/>, 1</div>;", "const x = <div><b></b>, 1</div>;"],
    // The MX text ` < c` now survives as JSX text: the host emitter escapes
    // the `<` (`jsx-text-lt-unescaped`), so Babel's old "Unexpected token"
    // failure at (1:26) is gone and the region prints the escaped form.
    ["const x = <div><b/> < c</div>;", "const x = <div><b></b> &#60; c</div>;"],
  ])("still parses %j to %j", (source, printed) => {
    expect(
      print(source, "t.solid.mx", { mxRegionCompile: solidRegionCompile }).code,
    ).toBe(printed);
  });

  // ...and a failure with no second root behind it keeps its own message. The
  // first row is a wrapped *host* parse error, so its text still carries the
  // inner parser's 0-based suffix verbatim: that position belongs to another
  // file, and `dropOwnParserPosition` deliberately keeps it. The rest are
  // Babel's own errors on this file, which no longer print one.
  //
  // `const x = <div><b/> < c</div>;` used to sit here too ("Unexpected token
  // (1:26)"), but that error only existed because the solid emitter copied
  // the authored `<` into the JSX verbatim; escaped (`jsx-text-lt-unescaped`)
  // it parses, and is asserted in the table above.
  it.each([
    ["const x = <b/>, 1;", "Unexpected token"],
    [
      "const x = <div><b/> <c</div>;",
      "EOF reached while parsing attribute name",
    ],
  ])("leaves the error of %j alone", (source, message) => {
    expect(() =>
      print(source, "t.solid.mx", { mxRegionCompile: solidRegionCompile }),
    ).toThrow(message);
  });
});
