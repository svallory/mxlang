// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import type { Ir } from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";
import { parseData } from "./parse.ts";

/**
 * ir-spec 10.2 E21: an emitter never mutates the IR it is handed.
 *
 * `compileSource` hands the lowered IR to the target's `emitIr`, which keeps it
 * and builds the tree from it afterwards; the mock below
 * freezes it all the way down (parser nodes included), so a write anywhere in
 * the emitter throws a `TypeError` instead of passing silently.
 */

const seen: Ir[] = [];

vi.mock("@mxlang/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@mxlang/core")>();
  const freeze = (value: unknown, done = new Set<object>()): void => {
    if (!value || typeof value !== "object" || done.has(value)) return;
    done.add(value);
    for (const child of Object.values(value)) freeze(child, done);
    Object.freeze(value);
  };
  return {
    ...core,
    compileSource: (...args: Parameters<typeof core.compileSource>) => {
      const [source, filename, declarations, host] = args;
      return core.compileSource(source, filename, declarations, {
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
};

describe("the data target leaves the IR alone (E21)", () => {
  it.each(Object.entries(DOCUMENTS))("%s", (_name, source) => {
    seen.length = 0;
    const result = parseData(source, "/f/x.mx");
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0]?.body)).toBe(true);
  });
});
