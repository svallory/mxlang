// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import type { Ir } from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * ir-spec 10.2 E21: an emitter never mutates the IR it is handed.
 *
 * The Solid emitter rewrites every read of a `<for>` param into an accessor
 * call and registers the names it generates in `For.bindings`. It used to do
 * both on the lowered nodes themselves. Here `lower` hands the emitter an IR
 * frozen all the way down (parser nodes included), so a write anywhere in the
 * emitter throws a `TypeError` instead of passing silently.
 */

const lowered: Ir[] = [];

vi.mock("@mxlang/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@mxlang/core")>();
  const freeze = (value: unknown, seen = new Set<object>()): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  };
  return {
    ...core,
    lower: (...args: Parameters<typeof core.lower>) => {
      const ir = core.lower(...args);
      freeze(ir);
      lowered.push(ir);
      return ir;
    },
  };
});

const TEMPLATES: Record<string, string> = {
  "keyed row": '<ul><for|row| of=rows by="id"><li>${row.name}</li></for></ul>',
  "destructured keyed row":
    '<for|{ a, b }| of=rows by="id"><p>${a}${b}</p></for>',
  "nested keyed rows":
    '<for|a| of=xs by="id"><for|q| of=ys by="id">${q.z}${a.id}</for></for>',
  "nested destructured rows":
    '<for|{ a }| of=xs by="id"><for|{ b }| of=ys by="id">${a}${b}</for></for>',
  "for in": "<for|k, v| in=obj><li>${k}${v}</li></for>",
  "destructured for in": "<for|{ a }, v| in=obj><li>${a}${v}</li></for>",
  "stepped range": "<for|i| from=0 to=10 step=2><li>${i}</li></for>",
  "plain rows": "<for|row, i| of=rows><li>${i}${row}</li></for>",
};

describe("the Solid emitter leaves the IR alone (E21)", () => {
  it.each(Object.entries(TEMPLATES))("%s", (_name, source) => {
    lowered.length = 0;
    const { code } = compileSolidMx(source, { filename: "fixture.solid.mx" });
    expect(code).not.toBe("");
    // The mock saw the one lowering this compile made, and froze it.
    expect(lowered).toHaveLength(1);
    expect(Object.isFrozen(lowered[0]?.body)).toBe(true);
  });
});
