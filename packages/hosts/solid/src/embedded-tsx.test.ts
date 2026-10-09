import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * The MX front end parses a container's code as TypeScript, so JSX nested in
 * an attribute method's body or in tag parameters is a parse error on the
 * container; `repairEmbeddedTsx` reparses it as TSX at the container's file
 * position. Each region sits at a non-zero base, so a repaired node read at a
 * fragment-relative offset would slice the wrong text.
 */
const BASE = { baseOffset: 10, baseLine: 1, baseColumn: 3 } as const;

function compile(source: string): string {
  return compileSolidMx(source, { filename: "fixture.solid.mx", ...BASE }).code;
}

describe("compileSolidMx: JSX nested in TypeScript containers", () => {
  it("compiles JSX inside an attribute method's body", () => {
    expect(compile("<button onClick() { setX(<div/>) }>x</button>")).toBe(
      "<button onClick={function () { setX(<div />); }}>x</button>",
    );
  });

  it("compiles JSX in a declaration inside the method body", () => {
    expect(
      compile("<button onClick(e) { const a = <b>{e}</b>; go(a) }>x</button>"),
    ).toBe(
      "<button onClick={function (e) { const a = <b>{e}</b>; go(a); }}>x</button>",
    );
  });

  it("compiles JSX in a tag parameter's default, at its file position", () => {
    expect(compile("<div><for|a = <i/>| of=xs>x</for></div>")).toContain(
      "{(a = <i/>) =>",
    );
  });

  it("still reports code that is not TSX either, with the TypeScript error", () => {
    let error: { message?: string; line?: number; column?: number } = {};
    try {
      compile("<button onClick() { go(<div/> + ) }>x</button>");
    } catch (caught) {
      error = caught as typeof error;
    }
    // The front end's own error, at its file position (line 2 is baseLine 1).
    expect(error).toMatchObject({
      message: 'Unexpected token, expected ","',
      line: 2,
      column: 30,
    });
  });
});
