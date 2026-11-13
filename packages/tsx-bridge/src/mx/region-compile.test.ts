import type { File } from "@babel/types";
import type { MxRegionCompile, MxRegionCompileInput } from "@mxlang/babel";
import { describe, expect, it } from "vitest";
import { parse } from "../index.ts";

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
 * There is no default path any more: the parser imports no host and names no
 * file suffix. The grammar is on when `mx: true` is passed or a hook is
 * supplied; with the grammar on and no hook, the first region is a compile
 * error — see `describe("mxRegionCompile: required when the grammar is on")`.
 * Every other test in this package supplies the hook explicitly (via
 * `test-helpers.ts`'s `parseSolid`), which is what keeps the *behavior* of
 * `compileSolidMx` itself covered as a regression gate.
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

    /**
     * The raised error's text plus its structured position. MX-raised
     * diagnostics carry `loc` (1-based line, 0-based column) and their text
     * no longer repeats Babel's 0-based ` (L:C)` suffix, so the position is
     * asserted where it is authoritative rather than through the message.
     */
    function caughtAt(run: () => unknown): {
      message: string;
      line: number;
      column: number;
    } {
      try {
        run();
      } catch (error) {
        const e = error as Error & {
          loc?: { line: number; column: number };
        };
        if (error instanceof Error && e.loc) {
          expect(error.message).not.toMatch(/\s*\(\d+:\d+\)\s*$/);
          return {
            message: error.message,
            line: e.loc.line,
            column: e.loc.column,
          };
        }
      }
      throw new Error("expected a positioned MX error");
    }

    it("keeps a positioned error's own file-absolute coordinates", () => {
      const raised = caughtAt(() =>
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
      );
      expect(raised.message).toBe("host says no");
      expect(raised.line).toBe(regionLine);
      expect(raised.column).toBe(regionColumn);
    });

    it("honours a position that is not the region's own start", () => {
      // The region opens at 3:10, so reporting 5:2 proves the coordinates
      // were *used* rather than coincidentally matching the fallback. This
      // is what caught a `positioned` predicate that recognised a `loc` the
      // real `TranslateError` never carries.
      const raised = caughtAt(() =>
        parse(source, "x.solid.mx", {
          mxRegionCompile: () => {
            throw new FakeTranslateError("elsewhere", 5, 2);
          },
        }),
      );
      expect(raised.message).toBe("elsewhere");
      expect(raised.line).toBe(5);
      expect(raised.column).toBe(2);
    });

    /** What a tool reads off the thrown error: code, start and exclusive end. */
    function carriedBy(error: Error & Record<string, unknown>) {
      const loc = error.loc as { line: number; column: number; end?: unknown };
      return {
        diagnosticCode: error.diagnosticCode,
        end: error.end,
        fixes: error.fixes,
        locEnd: loc.end,
        keys: Object.keys(error),
      };
    }

    function thrownBy(hookError: unknown): Error & Record<string, unknown> {
      try {
        parse(source, "x.solid.mx", {
          mxRegionCompile: () => {
            throw hookError;
          },
        });
      } catch (error) {
        return error as Error & Record<string, unknown>;
      }
      throw new Error("expected the region to fail");
    }

    it("carries the host error's code and end onto the raised error", () => {
      // A host error with a code and a range: the tools show the code and
      // underline to `end`, so both must survive the rethrow.
      const hostError = Object.assign(new FakeTranslateError("x", 5, 2), {
        diagnosticCode: "MX_INVALID_FOR",
        end: { line: 5, column: 9 },
      });
      const raised = thrownBy(hostError);
      expect(raised.message).toBe("x");
      expect(carriedBy(raised)).toMatchObject({
        diagnosticCode: "MX_INVALID_FOR",
        end: { line: 5, column: 9 },
        locEnd: { line: 5, column: 9 },
      });
    });

    it("adds them without changing the error's enumerable shape", () => {
      const plain = thrownBy(new FakeTranslateError("x", 5, 2));
      const carried = thrownBy(
        Object.assign(new FakeTranslateError("x", 5, 2), {
          diagnosticCode: "MX_INVALID_FOR",
          end: { line: 5, column: 9 },
        }),
      );
      expect(carriedBy(carried).keys).toEqual(carriedBy(plain).keys);
    });

    const FIXES = [
      {
        title: "Rename to `<script>`",
        edits: [{ offset: 40, end: 46, newText: "script" }],
      },
    ];

    it("carries the host error's fixes, untouched, with the code and end", () => {
      const raised = thrownBy(
        Object.assign(new FakeTranslateError("x", 5, 2), {
          diagnosticCode: "MX_RESERVED_EFFECT_TAG",
          end: { line: 5, column: 9 },
          fixes: FIXES,
        }),
      );
      expect(carriedBy(raised).fixes).toEqual(FIXES);
      // Offsets are file-absolute, as the position is: not shifted by the region.
      expect(carriedBy(raised).fixes).toBe(FIXES);
    });

    it("adds the fixes without changing the error's enumerable shape", () => {
      const plain = thrownBy(new FakeTranslateError("x", 5, 2));
      const carried = thrownBy(
        Object.assign(new FakeTranslateError("x", 5, 2), { fixes: FIXES }),
      );
      expect(carriedBy(carried).keys).toEqual(carriedBy(plain).keys);
      expect(carriedBy(carried).fixes).toEqual(FIXES);
    });

    it("carries no fixes for a missing, empty or non-array value", () => {
      for (const fixes of [undefined, [], "rename", { title: "x" }]) {
        const raised = thrownBy(
          Object.assign(new FakeTranslateError("x", 5, 2), { fixes }),
        );
        expect(carriedBy(raised).fixes).toBeUndefined();
      }
    });

    it("carries a code with no end, and an end with no code", () => {
      const codeOnly = carriedBy(
        thrownBy(
          Object.assign(new FakeTranslateError("x", 5, 2), {
            diagnosticCode: "MX_X",
          }),
        ),
      );
      expect(codeOnly).toMatchObject({
        diagnosticCode: "MX_X",
        end: undefined,
        locEnd: undefined,
      });
      const endOnly = carriedBy(
        thrownBy(
          Object.assign(new FakeTranslateError("x", 5, 2), {
            end: { line: 6, column: 1 },
          }),
        ),
      );
      expect(endOnly).toMatchObject({
        diagnosticCode: undefined,
        end: { line: 6, column: 1 },
        locEnd: { line: 6, column: 1 },
      });
    });

    it("ignores a code that is not a string and an end that is not a position", () => {
      const raised = carriedBy(
        thrownBy(
          Object.assign(new FakeTranslateError("x", 5, 2), {
            diagnosticCode: 42,
            end: { line: "6", column: 1 },
          }),
        ),
      );
      expect(raised).toMatchObject({
        diagnosticCode: undefined,
        end: undefined,
        locEnd: undefined,
      });
    });

    it("carries nothing for a plain Error, which has no code or end to give", () => {
      expect(carriedBy(thrownBy(new Error("plain")))).toMatchObject({
        diagnosticCode: undefined,
        end: undefined,
        locEnd: undefined,
      });
    });

    it.each([
      ["a positioned error", new FakeTranslateError("x", 5, 2)],
      ["a plain Error", new Error("plain")],
    ])(
      "carries the callee files %s read onto the raised error",
      (_, hostError) => {
        const raised = thrownBy(
          Object.assign(hostError, { dependencies: ["/project/Card.mx"] }),
        );
        expect(raised.dependencies).toEqual(["/project/Card.mx"]);
      },
    );

    it.each([
      ["a positioned error", () => new FakeTranslateError("x", 5, 2)],
      ["a plain Error", () => new Error("plain")],
    ])(
      "adds the callees of the regions accepted before it to %s",
      (_, hostError) => {
        let calls = 0;
        const raised = (() => {
          try {
            parse("const a = <A/>;\nconst b = <B/>;\n", "x.solid.mx", {
              mxRegionCompile: () => {
                if (++calls === 1)
                  return { code: "null", dependencies: ["/project/A.mx"] };
                throw Object.assign(hostError(), {
                  dependencies: ["/project/B.mx"],
                });
              },
            });
          } catch (error) {
            return error as Error & Record<string, unknown>;
          }
          throw new Error("expected the second region to fail");
        })();
        expect(raised.dependencies).toEqual(["/project/A.mx", "/project/B.mx"]);
      },
    );

    it("positions a plain Error at the region's start, not V8's throw site", () => {
      // An ordinary `Error` carries V8's `line`, which points inside the
      // *host's* module. Trusting it reported a line in neither file.
      const raised = caughtAt(() =>
        parse(source, "x.solid.mx", {
          mxRegionCompile: () => {
            throw new Error("plain failure");
          },
        }),
      );
      expect(raised.message).toBe("plain failure");
      expect(raised.line).toBe(regionLine);
      expect(raised.column).toBe(regionColumn);
    });

    it("positions a thrown non-Error at the region's start too", () => {
      // Rethrowing this raw escaped the positioned-`SyntaxError` contract
      // `toSyntaxError` relies on, and broke `tryParse`'s discipline.
      const raised = caughtAt(() =>
        parse(source, "x.solid.mx", {
          mxRegionCompile: () => {
            throw "a string";
          },
        }),
      );
      expect(raised.message).toBe("a string");
      expect(raised.line).toBe(regionLine);
      expect(raised.column).toBe(regionColumn);
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

  it("turns the grammar on for any file name when a hook is given", () => {
    const { hook, calls } = recordingHook();
    // The parser names no suffix: a host's region file (`.fake.mx` here) is
    // a region file because its caller supplies that host's region compile.
    parse("const view = <div>hi</div>;", "x.fake.mx", {
      mxRegionCompile: hook,
    });

    expect(calls.map((call) => call.source)).toEqual(["<div>hi</div>"]);
  });

  it("leaves the grammar off with `mx: false`, hook or not", () => {
    const { hook, calls } = recordingHook();
    // Ordinary JSX, so the bridge never runs and the hook is never called.
    parse("const view = <div>hi</div>;", "x.solid.mx", {
      mx: false,
      mxRegionCompile: hook,
    });

    expect(calls).toHaveLength(0);
  });

  it("parses a .solid.mx name with no hook and no `mx` as plain TSX", () => {
    // The suffix alone no longer turns the grammar on: a tool says `mx: true`.
    expect(() =>
      parse("const view = <div>hi</div>;", "x.solid.mx"),
    ).not.toThrow();
  });
});

describe("mxRegionCompile: required when the grammar is on", () => {
  it("raises a positioned error at the first region with mx: true and no hook", () => {
    // Two regions: the error must land at the first one's own start, not the
    // file start or the second region's — the same "no fallback to a wrong
    // line" discipline the throwing-hook tests above pin.
    const source = ["const a = <div>1</div>;", "const b = <div>2</div>;"].join(
      "\n",
    );
    const regionStart = source.indexOf("<div>1</div>");

    let error: unknown;
    try {
      parse(source, "x.solid.mx", { mx: true });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SyntaxError);
    const err = error as SyntaxError & {
      loc?: { line: number; column: number; index: number };
    };
    expect(err.message).toContain("mxRegionCompile");
    // Host-free: it names the contract, never one host's entry.
    expect(err.message).toContain("HostFileKind.compileRegion");
    expect(err.message).not.toContain("compileSolidMx");
    expect(err.loc?.index).toBe(regionStart);
  });

  it("raises the same error for mx: true on a non-.solid.mx filename with no hook", () => {
    let error: unknown;
    try {
      parse("const view = <div>hi</div>;", "x.ng.mx", { mx: true });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toContain("mxRegionCompile");
    expect((error as Error).message).toContain("HostFileKind.compileRegion");
  });

  it("never invokes a hook when the grammar is off", () => {
    let called = false;
    // `mx: false` wins over the hook: the grammar never turns on, so the
    // hook must not run even though one is supplied and would throw.
    expect(() =>
      parse("const view = <div>hi</div>;", "x.ng.mx", {
        mx: false,
        mxRegionCompile: () => {
          called = true;
          throw new Error("must not run");
        },
      }),
    ).not.toThrow();
    expect(called).toBe(false);
  });
});

/**
 * Recorded mappings: a host that rewrote an expression says where each
 * emitted span came from, and the bridge believes it over a text search.
 */
describe("mxRegionCompile: recorded mappings", () => {
  const source = "const view = <p a=~m b=m c=pick(~m, miss)/>;";
  const code = '<p a={"m"} b={m} c={pick("m", miss)}/>';
  const at = (text: string, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = source.indexOf(text, i + 1);
    return i;
  };
  /** Region-relative offset of the `nth` `text` in the emitted code. */
  const gen = (text: string, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = code.indexOf(text, i + 1);
    return i;
  };
  const recorded = [
    // `~m` -> `"m"` (first), `m` -> `m`, `~m` -> `"m"` (second), `miss`.
    [gen('"m"'), gen('"m"') + 3, at("~m"), at("~m") + 2],
    [gen("{m}") + 1, gen("{m}") + 2, at(" m") + 1, at(" m") + 2],
    [gen('"m"', 1), gen('"m"', 1) + 3, at("~m", 1), at("~m", 1) + 2],
    [gen("miss"), gen("miss") + 4, at("miss"), at("miss") + 4],
  ].map(([generatedStart, generatedEnd, sourceStart, sourceEnd]) => ({
    generatedStart: generatedStart as number,
    generatedEnd: generatedEnd as number,
    sourceStart: sourceStart as number,
    sourceEnd: sourceEnd as number,
  }));

  function nodes(file: File) {
    const found: Array<{
      type: string;
      name?: string;
      value?: string;
      start: number;
      end: number;
    }> = [];
    const walk = (n: unknown) => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      const r = n as Record<string, unknown>;
      if (r.type === "Identifier" || r.type === "StringLiteral") {
        found.push(r as never);
      }
      for (const k of Object.keys(r))
        if (k !== "loc" && k !== "extra") walk(r[k]);
    };
    walk(file.program);
    return found;
  }

  it("maps an atom the host rewrote and the text after a skipped one", () => {
    const file = parse(source, "x.solid.mx", {
      mxRegionCompile: () => ({ code, mappings: recorded }),
    });
    const all = nodes(file);
    const atoms = all.filter((n) => n.type === "StringLiteral");
    expect(atoms.map((n) => [n.start, n.end])).toEqual([
      [at("~m"), at("~m") + 2],
      [at("~m", 1), at("~m", 1) + 2],
    ]);
    // Without the record the search skips `~m` and lands `m` on the `"m"`.
    const b = all.find((n) => n.name === "m");
    expect(b && [b.start, b.end]).toEqual([at(" m") + 1, at(" m") + 2]);
    const miss = all.find((n) => n.name === "miss");
    expect(miss && [miss.start, miss.end]).toEqual([
      at("miss"),
      at("miss") + 4,
    ]);
  });

  it("rebases recorded offsets when the bridge unwraps a brace-wrapped region", () => {
    const plain = "const view = <p a=m/>;";
    const wrapped = "{<p a={m}/>}";
    const g = wrapped.indexOf("{m}") + 1;
    const at = plain.indexOf("m/>");
    const file = parse(plain, "x.solid.mx", {
      mxRegionCompile: () => ({
        code: wrapped,
        mappings: [
          {
            generatedStart: g,
            generatedEnd: g + 1,
            sourceStart: at,
            sourceEnd: at + 1,
          },
        ],
      }),
    });
    const m = nodes(file).find((n) => n.name === "m");
    expect(m && [m.start, m.end]).toEqual([at, at + 1]);
  });

  it("keeps a recorded name inside a host-generated `as` type at its authored span", () => {
    // A host types a call by the public name: `(__mxDef_Row as typeof Row)`.
    // Only `typeof Row`'s `Row` is recorded; the private name is not.
    const plain = "const view = <p a=Row/>;";
    const emitted = "<p a={(__mxDef_Row as typeof Row)}/>";
    const g = emitted.indexOf("Row)");
    const at = plain.indexOf("Row/>");
    const file = parse(plain, "x.solid.mx", {
      mxRegionCompile: () => ({
        code: emitted,
        mappings: [
          {
            generatedStart: g,
            generatedEnd: g + 3,
            sourceStart: at,
            sourceEnd: at + 3,
          },
        ],
      }),
    });
    const row = nodes(file).find((n) => n.name === "Row");
    expect(row && [row.start, row.end]).toEqual([at, at + 3]);
  });

  it("keeps the verbatim search for an expression the host did not record", () => {
    const plain = "const view = <p a=x b=y/>;";
    const gy = "<p a={x} b={y}/>".indexOf("{y}") + 1;
    const ay = plain.indexOf("y/>");
    const file = parse(plain, "x.solid.mx", {
      mxRegionCompile: () => ({
        code: "<p a={x} b={y}/>",
        // Only `y` is recorded; `x` is found by text.
        mappings: [
          {
            generatedStart: gy,
            generatedEnd: gy + 1,
            sourceStart: ay,
            sourceEnd: ay + 1,
          },
        ],
      }),
    });
    const x = nodes(file).find((n) => n.name === "x");
    expect(x && [x.start, x.end]).toEqual([
      plain.indexOf("x b"),
      plain.indexOf("x b") + 1,
    ]);
  });
});

/**
 * A method shorthand's generic head (`onClick<T extends Missing>(e: T) {}`)
 * is printed verbatim by the host, so its type nodes are found by text like
 * the parameters and body; a type error in a constraint is reported where the
 * author wrote it, not at the generated offset.
 */
describe("mxRegionCompile: a method shorthand's generic head", () => {
  const source =
    "const view = <button onClick<T extends Missing>(e: T) { go() }/>;";
  const code =
    "<button onClick={function <T extends Missing>(e: T) { go(); }}/>";

  it("remaps the constraint's type nodes to their authored span", () => {
    const file = parse(source, "x.solid.mx", {
      mxRegionCompile: () => ({ code }),
    });
    const found: Array<[string, number, number]> = [];
    const walk = (n: unknown) => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      const r = n as Record<string, unknown>;
      if (r.type === "Identifier" && r.name === "Missing") {
        found.push([r.name, r.start as number, r.end as number]);
      }
      for (const k of Object.keys(r))
        if (k !== "loc" && k !== "extra") walk(r[k]);
    };
    walk(file.program);
    const at = source.indexOf("Missing");
    expect(found).toEqual([["Missing", at, at + "Missing".length]]);
  });
});
