import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * A top-level concise line holding only `,` has no tag to continue; core's
 * positioned error replaces Marko's `TypeError` (`tag.name.value`). Core's
 * bare-comma.test.ts owns the matrix through both parse entries; this host
 * keeps one positioned refusal and a valid continuation as wiring smokes.
 */
const MESSAGE =
  "a `,` continues the attributes of the tag above; there is no tag here";

function run(source: string): unknown {
  try {
    compileSolidMx(source, { filename: "a.solid.mx" });
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("a bare `,` line", () => {
  it.each([[",", 1, 0]])(
    "%j is a positioned error, not a throw",
    (source, line, column) => {
      const error = run(source);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ message: MESSAGE, line, column });
    },
  );

  it("a `,` that continues a tag above still compiles", () => {
    expect(run('div\n  , class="a"')).toBeUndefined();
  });
});
