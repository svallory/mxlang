// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import type { Ir } from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";
import { compile } from "./index.ts";

/**
 * ir-spec 10.2 E21: an emitter never mutates the IR it is handed.
 *
 * `compileSource` hands the lowered IR to the host's `emitIr`; the mock below
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
          const first = host.emitIr(ir, ctx);
          // A second emission from the same IR prints the same thing.
          expect(host.emitIr(ir, ctx)).toBe(first);
          return first;
        },
      });
    },
  };
});

const TEMPLATES: Record<string, string> = {
  rows: "<ul><for|row, i| of=rows><li>${i}${row.name}</li></for></ul>",
  "keyed destructured rows":
    '<for|{ a, b }| of=rows by="id"><p>${a}${b}</p></for>',
  "nested rows": "<for|a| of=xs><for|q| of=ys>${q.z}${a.id}</for></for>",
  "for in": "<for|k, v| in=obj><li>${k}${v}</li></for>",
  range: "<for|i| from=0 to=3><li>${i}</li></for>",
  "if chain":
    "<if=a><p>a</p></if><else if=b><p>b</p></else><else><p>c</p></else>",
  const: "<const/n=a+1/>\n<p>${n}</p>",
  define: "<define/Row|x|><li>${x}</li></define><Row(1)/>",
  "void element": '<input type="text" value=v/><br/>',
  "class and style": "<div class=[a, { b: c }] style={ color: d }>x</div>",
  comments: "<!-- kept --><p>x</p>",
  "raw html": "<p>$!{raw}</p>",
  spread: "<button ...rest>go</button>",
};

describe("the html emitter leaves the IR alone (E21)", () => {
  it.each(Object.entries(TEMPLATES))("%s", (_name, source) => {
    seen.length = 0;
    const { code } = compile(source, "/f/x.mx");
    expect(code).not.toBe("");
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0]?.body)).toBe(true);
  });
});
