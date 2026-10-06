// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import type { Ir } from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";
import { compileTagModule } from "../src/tag-module.ts";

/**
 * ir-spec 10.2 E21: an emitter never mutates the IR it is handed.
 *
 * A tag module rewrites `input.x` to the class property `x` (editing the
 * `Expr.node` parser tree and reassigning `Expr.code`) and swaps slot reads
 * (`input.content()`) for `<ng-content>` text nodes. It used to do both on the
 * lowered nodes. The mock freezes the IR the host receives all the way down, so
 * any such write throws a `TypeError`.
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

const TAGS: Record<string, string> = {
  "input reads": "<p>${input.title}</p><b>${input.a.b}${input['c']}</b>",
  "input in attributes and conditions":
    "<if=input.open><a href=input.url title=`t ${input.title}`>go</a></if>",
  "input in a loop": "<for|row| of=input.rows><li>${row.name}</li></for>",
  "input in a callback":
    "<button onClick=() => input.pick(input.id)>x</button>",
  "shadowed input": "<for|input| of=xs><i>${input.x}</i></for>",
  "body slot": "<div>${input.content()}</div>",
  "named slot": "<div>${input.header()}${input.content()}</div>",
  "slot beside reads": "<h2>${input.title}</h2>${input.content()}",
};

describe("the Angular tag module leaves the IR alone (E21)", () => {
  it.each(Object.entries(TAGS))("%s", (_name, source) => {
    seen.length = 0;
    const { code } = compileTagModule(source, "/f/tags/card.mx");
    expect(code).not.toBe("");
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0]?.body)).toBe(true);
  });
});
