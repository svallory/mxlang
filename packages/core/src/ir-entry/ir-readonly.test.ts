import { describe, expect, it, vi } from "vitest";
import type { Ir } from "../ir.ts";
import { lowerSource } from "./index.ts";

/**
 * ir-spec 10.2 E21: a consumer of the lowered IR never mutates it.
 *
 * `lowerSource` keeps the IR `compileSource` hands its `emitIr` and finishes
 * it (span trim, `args`) afterwards; the mock below freezes it all the way
 * down (parser nodes included), so a write anywhere in the entry point throws
 * a `TypeError` instead of passing silently.
 */

const seen: Ir[] = [];

vi.mock("../compile.ts", async (importOriginal) => {
  const compile = await importOriginal<typeof import("../compile.ts")>();
  const freeze = (value: unknown, done = new Set<object>()): void => {
    if (!value || typeof value !== "object" || done.has(value)) return;
    done.add(value);
    for (const child of Object.values(value)) freeze(child, done);
    Object.freeze(value);
  };
  return {
    ...compile,
    compileSource: (...args: Parameters<typeof compile.compileSource>) => {
      const [source, filename, declarations, host] = args;
      return compile.compileSource(source, filename, declarations, {
        ...host,
        emitIr: (ir, ctx) => {
          freeze(ir);
          seen.push(ir);
          return host.emitIr(ir, ctx);
        },
      });
    },
  };
});

const DOCUMENTS: Record<string, string> = {
  "attributes and text": '<page title="a" count=2 on>hello</page>',
  "nested elements": "<a><b x=1/><b x=2/></a>",
  "attribute tags": "<list><@item>one</@item><@item>two</@item></list>",
  "an expression value": "<point x=1+2 y=[1, 2, 3] z={ a: 1 }/>",
  atoms: "<field mode=:strict accept=[:a, :b]/>",
  comments: "<!-- note --><a>x</a>",
  "a concise tag (its span is trimmed)": "a\n  b\n",
};

describe("lowerSource leaves the lowered IR alone (E21)", () => {
  it.each(Object.entries(DOCUMENTS))("%s", (_name, source) => {
    seen.length = 0;
    const result = lowerSource(source, "/f/x.mx");
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0]?.body)).toBe(true);
    // The returned IR is a copy, not the frozen original.
    expect(result.ir?.body).not.toBe(seen[0]?.body);
    expect(Object.isFrozen(result.ir?.body)).toBe(false);
  });
});
