// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A region calling a `.hono.mx` callee's attribute tag, compiled through
 * `compileHonoRegion` directly — no `@mxlang/targets` loaded, so no
 * reader was registered for `.hono.mx`. The entry's own lookup (its
 * `targets` default) declares the `hono` file kind's `readCalleeInput`, and
 * core reads callee readers from the compile's lookup, so the callee's
 * `Input` contract still reaches the call site as a `satisfies` check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MxWarning } from "@mxlang/core";
import { print } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import { compileHonoRegion } from "./index.ts";

const DIR = join(import.meta.dirname, "fixtures", "region-callee");

describe("a direct compileHonoRegion reads a .hono.mx callee's Input", () => {
  it("emits the attribute-tag satisfies check against the callee", () => {
    const file = join(DIR, "Page.hono.mx");
    const source = readFileSync(file, "utf8");
    const warnings: MxWarning[] = [];
    const printed = print(source, file, {
      mx: true,
      // No `targets`: the entry's own lookup is the default under test.
      mxRegionCompile: (input) =>
        compileHonoRegion(input.source, { ...input, warnings }) as ReturnType<
          NonNullable<
            NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"]
          >
        >,
    }).code;
    expect(printed).toContain(
      'satisfies NonNullable<Parameters<typeof Card>[0]["row"]>',
    );
    expect(warnings).toEqual([]);
  });
});
