// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import type { Ir } from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * ir-spec 10.2 E21: an emitter never mutates the IR it is handed.
 *
 * `lowerAstroMx` lowers the template and emits it in one step. Here `lower` hands the emitter an IR
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

const FENCE = "---\nconst x = 1;\n---\n";

const TEMPLATES: Record<string, string> = {
  rows: "<ul><for|row, i| of=rows><li>${i}${row.name}</li></for></ul>",
  "keyed destructured rows":
    '<for|{ a, b }| of=rows by="id"><p>${a}${b}</p></for>',
  "nested rows": "<for|a| of=xs><for|q| of=ys>${q.z}${a.id}</for></for>",
  "for in": "<for|k, v| in=obj><li>${k}${v}</li></for>",
  range: "<for|i| from=0 to=3><li>${i}</li></for>",
  "if chain":
    "<if=a><p>a</p></if><else if=b><p>b</p></else><else><p>c</p></else>",
  "void element": '<input type="text" value=v/><br/>',
  "class and style": "<div class=[a, { b: c }] style={ color: d }>x</div>",
  comments: "<!-- kept --><p>x</p>",
  "raw html": "<p>$!{raw}</p>",
  spread: "<button ...rest>go</button>",
};

describe("the Astro emitter leaves the IR alone (E21)", () => {
  it.each(Object.entries(TEMPLATES))("%s", (_name, source) => {
    lowered.length = 0;
    const { code } = lowerAstroMx(`${FENCE}${source}`, "Test.astro.mx");
    expect(code).not.toBe("");
    expect(lowered).toHaveLength(1);
    expect(Object.isFrozen(lowered[0]?.body)).toBe(true);
  });
});
