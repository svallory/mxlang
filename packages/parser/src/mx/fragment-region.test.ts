import type { File } from "@babel/types";
import { describe, expect, it } from "vitest";
import { parse, print } from "../index.ts";
import type {
  MxRegionCompile,
  MxRegionCompileInput,
} from "./region-compile.ts";
import { solidRegionCompile } from "./test-helpers.ts";

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
    expect(() =>
      parseFragmentRegions("const v = <><><b/></></>;", hook),
    ).toThrow(
      "A fragment `<>…</>` cannot contain another fragment. Its children are already siblings. (1:12)",
    );
  });

  it("names the fragment when it is never closed", () => {
    const { hook } = recordingHook();
    expect(() => parseFragmentRegions("const v = <><b/>;", hook)).toThrow(
      "Unterminated fragment: expected a closing `</>`. (1:10)",
    );
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

  it.each([
    ["const el = <p>x</p><p>y</p>;", "1:19"],
    ["const el = <p>x</p> <p>y</p>;", "1:20"],
    ["const el = <if=a>x</if><if=b>y</if>;", "1:23"],
    ["const el = <b/>\n<c/>;", "2:0"],
    ["f(<b/><c/>);", "1:6"],
  ])("names the rule in .solid.mx for %j", (source, at) => {
    expect(() =>
      print(source, "t.solid.mx", { mxRegionCompile: solidRegionCompile }),
    ).toThrow(`${RULE} (${at})`);
  });

  it("names the rule with a plain hook too (the check is the shared bridge's)", () => {
    const { hook } = recordingHook();
    expect(() =>
      parse("const el = <p/><p/>;", "t.ng.mx", {
        mx: true,
        mxRegionCompile: hook,
      }),
    ).toThrow(`${RULE} (1:15)`);
  });

  it("names the rule for a fragment followed by a root", () => {
    const { hook } = recordingHook();
    expect(() => parseFragmentRegions("const el = <>a</><b/>;", hook)).toThrow(
      `${RULE} (1:17)`,
    );
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
  ])("still parses %j to %j", (source, printed) => {
    expect(
      print(source, "t.solid.mx", { mxRegionCompile: solidRegionCompile }).code,
    ).toBe(printed);
  });

  // ...and a failure with no second root behind it keeps its own message.
  it.each([
    ["const x = <div><b/> < c</div>;", "Unexpected token (1:26)"],
    ["const x = <b/>, 1;", "Unexpected token (1:16)"],
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
