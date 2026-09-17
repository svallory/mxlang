import type { File } from "@babel/types";
import { describe, expect, it } from "vitest";
import { parse } from "../index.ts";
import type {
  MxRegionCompile,
  MxRegionCompileInput,
} from "./region-compile.ts";

/** The spliced region node of `const view = <…>;`, the shape these assert on. */
function regionNode(file: File): {
  type: string;
  value?: string;
  start: number;
  end: number;
  extra: {
    mx: {
      hoistedImports: Array<{ binding: string }>;
      returnVars: string[];
    };
  };
} {
  // Not `body[0]`: a hook returning `hoistedImports`/`returnVars` makes
  // `parse` prepend the injected import and the `/var` declaration, so the
  // author's own `const view = …` is no longer first.
  const statement = file.program.body.find(
    (node) => node.type === "VariableDeclaration" && node.kind === "const",
  ) as unknown as {
    declarations: Array<{ init: ReturnType<typeof regionNode> }>;
  };
  const init = statement?.declarations[0]?.init;
  if (!init) throw new Error("no region node in the parsed file");
  return init;
}

/**
 * The compile hook, from the outside: a caller supplying `mxRegionCompile`
 * lowers regions with its own host instead of Solid's.
 *
 * The default path (no hook) is covered by every other test in this package —
 * they all parse `.solid.mx` through `compileSolidMx` and would fail if the
 * default changed, which is the real regression gate for "no behavior change".
 */
describe("mxRegionCompile", () => {
  /** Records what the bridge handed the hook, and returns trivial code. */
  function recordingHook(code = "null"): {
    hook: MxRegionCompile;
    calls: MxRegionCompileInput[];
  } {
    const calls: MxRegionCompileInput[] = [];
    return {
      calls,
      hook: (input) => {
        calls.push(input);
        return { code };
      },
    };
  }

  it("receives the region text and its file-relative position", () => {
    const { hook, calls } = recordingHook();
    const source = ["const a = 1;", "const view = <div>hi</div>;"].join("\n");
    parse(source, "x.solid.mx", { mxRegionCompile: hook });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.source).toBe("<div>hi</div>");
    expect(call?.filename).toBe("x.solid.mx");
    // Second line, so `baseLine` is 1 (0-based) and `baseOffset` points at
    // the `<` in the original file.
    expect(call?.baseLine).toBe(1);
    expect(call?.baseOffset).toBe(source.indexOf("<div>"));
    expect(call?.baseColumn).toBe("const view = ".length);
  });

  it("splices the hook's own output in place of the region", () => {
    const { hook } = recordingHook('"lowered by the test host"');
    const file = parse("const view = <div>hi</div>;", "x.solid.mx", {
      mxRegionCompile: hook,
    });

    const region = regionNode(file);
    // The hook's code is what got parsed and spliced, not Solid JSX.
    expect(region.type).toBe("StringLiteral");
    expect(region.value).toBe("lowered by the test host");
  });

  it("keeps the spliced node anchored to the region's own span", () => {
    const source = "const view = <div>hi</div>;";
    const { hook } = recordingHook("null");
    const file = parse(source, "x.solid.mx", { mxRegionCompile: hook });

    const region = regionNode(file);
    // Positions stay in the *source* coordinate system, so a later source map
    // still points at the `.mx` text rather than at the host's output.
    expect(region.start).toBe(source.indexOf("<div>"));
    expect(region.end).toBe(source.indexOf(";"));
  });

  it("forwards registered custom tags to the hook", () => {
    const { hook, calls } = recordingHook();
    const tags = { icon: {} as never };
    parse("const view = <div/>;", "x.solid.mx", {
      mxRegionCompile: hook,
      mxCustomTags: tags,
    });

    expect(calls[0]?.customTags).toBe(tags);
  });

  it("stamps the hoisted imports and /var names the hook returns", () => {
    const hook: MxRegionCompile = () => ({
      code: "null",
      hoistedImports: [
        {
          code: 'import $mx_Icon1 from "./icon.mx";',
          binding: "$mx_Icon1",
          specifier: "./icon.mx",
          resolvedPath: "/abs/icon.mx",
        },
      ],
      returnVars: ["total"],
    });
    const file = parse("const view = <div/>;", "x.solid.mx", {
      mxRegionCompile: hook,
    });

    const mx = regionNode(file).extra.mx;
    expect(mx.hoistedImports[0].binding).toBe("$mx_Icon1");
    expect(mx.returnVars).toEqual(["total"]);
    // Both are not merely stamped but *placed* by `parse`: the injected
    // import lands at module scope and the `/var` gets its `let`, which is
    // the whole reason a region hands them back rather than emitting them.
    expect(file.program.body[0]?.type).toBe("ImportDeclaration");
    expect(
      file.program.body.some(
        (node) => node.type === "VariableDeclaration" && node.kind === "let",
      ),
    ).toBe(true);
  });

  it("runs the position check before the compile hook", () => {
    const order: string[] = [];
    expect(() =>
      parse("const view = <div/>;", "x.solid.mx", {
        mxRegionPositionCheck: () => {
          order.push("check");
          return { ok: false, message: "rejected by the test host" };
        },
        mxRegionCompile: () => {
          order.push("compile");
          return { code: "null" };
        },
      }),
    ).toThrow(/rejected by the test host/);
    // A vetoed region is never lowered, so a host's check can rely on its
    // compile hook not seeing a position it already rejected.
    expect(order).toEqual(["check"]);
  });

  it("turns the grammar on for a non-.solid.mx filename via `mx: true`", () => {
    const { hook, calls } = recordingHook();
    parse("const view = <div>hi</div>;", "x.ng.mx", {
      mx: true,
      mxRegionCompile: hook,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("<div>hi</div>");
  });

  it("honours an explicit `mx: false` on a .solid.mx file", () => {
    const { hook, calls } = recordingHook();
    // The opt-out direction of the gate: the extension says MX, the caller
    // says no. The region stays plain JSX and the hook is never called.
    const file = parse("const view = <div>hi</div>;", "x.solid.mx", {
      mx: false,
      mxRegionCompile: hook,
    });

    expect(calls).toHaveLength(0);
    expect(regionNode(file).type).toBe("JSXElement");
  });

  describe("a throwing hook", () => {
    /**
     * `@mxlang/core`'s `TranslateError`, reproduced exactly: `line`/`column`
     * and **nothing else** — no `loc`, no `reasonCode`. Measured against the
     * real class, and the distinction matters: an earlier version of this
     * test carried a `loc` the real error does not have, which made it pass
     * while a genuine `TranslateError` was still being dropped to the
     * region-start fallback.
     */
    class FakeTranslateError extends Error {
      constructor(
        message: string,
        readonly line: number,
        readonly column: number,
      ) {
        super(message);
        this.name = "TranslateError";
      }
    }

    // The region opens at line 3, column 10 — distinct from the file start
    // and from the host's own throw site. The file is deliberately **40+
    // lines long with the region early**: `offsetAt` clamps a past-EOF
    // position to the end of the file, so a short fixture makes a wrong line
    // land on the region by coincidence and hides the bug this pins.
    const regionLineText = "const v = <div/>;";
    const source = (() => {
      const lines = Array(40).fill("// filler");
      lines[2] = regionLineText;
      return lines.join("\n");
    })();
    const regionLine = 3; // 1-based; `lines[2]`
    const regionColumn = regionLineText.indexOf("<"); // 0-based, derived

    it("keeps a positioned error's own file-absolute coordinates", () => {
      expect(() =>
        parse(source, "x.solid.mx", {
          mxRegionCompile: ({ baseLine, baseColumn }) => {
            // What a correct host does: apply the region's base itself, as
            // `compileSolidMx` does by pre-padding its source.
            throw new FakeTranslateError(
              "host says no",
              baseLine + 1,
              baseColumn,
            );
          },
        }),
      ).toThrow(/host says no \(3:10\)/);
    });

    it("honours a position that is not the region's own start", () => {
      // The region opens at 3:10, so reporting 5:2 proves the coordinates
      // were *used* rather than coincidentally matching the fallback. This
      // is what caught a `positioned` predicate that recognised a `loc` the
      // real `TranslateError` never carries.
      expect(() =>
        parse(source, "x.solid.mx", {
          mxRegionCompile: () => {
            throw new FakeTranslateError("elsewhere", 5, 2);
          },
        }),
      ).toThrow(/elsewhere \(5:2\)/);
    });

    it("positions a plain Error at the region's start, not V8's throw site", () => {
      // An ordinary `Error` carries V8's `line`, which points inside the
      // *host's* module. Trusting it reported a line in neither file.
      expect(() =>
        parse(source, "x.solid.mx", {
          mxRegionCompile: () => {
            throw new Error("plain failure");
          },
        }),
      ).toThrow(
        new RegExp(`plain failure \\(${regionLine}:${regionColumn}\\)`),
      );
    });

    it("positions a thrown non-Error at the region's start too", () => {
      // Rethrowing this raw escaped the positioned-`SyntaxError` contract
      // `toSyntaxError` relies on, and broke `tryParse`'s discipline.
      expect(() =>
        parse(source, "x.solid.mx", {
          mxRegionCompile: () => {
            throw "a string";
          },
        }),
      ).toThrow(new RegExp(`a string \\(${regionLine}:${regionColumn}\\)`));
    });
  });

  it("hands the hook the region's syntactic context (C3)", () => {
    let seen: unknown;
    parse("@Component({ template: <div/> })\nclass X {}", "x.solid.mx", {
      plugins: ["typescript", "jsx", "decorators"],
      // The context is only tracked when a position check asked for it.
      mxRegionPositionCheck: () => ({ ok: true }),
      mxRegionCompile: (input) => {
        seen = input.context;
        return { code: "null" };
      },
    });

    expect(seen).toMatchObject({
      propertyKey: "template",
      decoratorNames: ["Component"],
      isDirectPropertyValue: true,
      argumentIndex: 0,
    });
  });

  it("leaves the hook's context undefined when no position check is set", () => {
    const { hook, calls } = recordingHook();
    parse("const view = <div/>;", "x.solid.mx", { mxRegionCompile: hook });
    expect(calls[0]?.context).toBeUndefined();
  });

  it("leaves the grammar off for a non-.solid.mx filename without `mx`", () => {
    const { hook, calls } = recordingHook();
    // Without the gate this is ordinary JSX, so the bridge never runs and the
    // hook is never called — the behavior every non-MX file relies on.
    parse("const view = <div>hi</div>;", "x.ng.mx", { mxRegionCompile: hook });

    expect(calls).toHaveLength(0);
  });
});
