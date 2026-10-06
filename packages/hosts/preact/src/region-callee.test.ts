// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A region calling a `.preact.mx` callee's attribute tag, compiled through
 * `compilePreactRegion` directly — no `@mxlang/target-registry` loaded, so no
 * reader was registered for `.preact.mx`. The entry's own lookup (its
 * `targets` default) declares the `preact` file kind's `readCalleeInput`, and
 * core reads callee readers from the compile's lookup, so the callee's
 * `Input` contract still reaches the call site as a `satisfies` check.
 */
import { join } from "node:path";
import type { MxWarning } from "@mxlang/core";
import { print } from "@mxlang/parser";
import { describe, expect, it } from "vitest";
import { compilePreactRegion } from "./index.ts";

const DIR = join(import.meta.dirname, "fixtures", "region-callee");

describe("a direct compilePreactRegion reads a .preact.mx callee's Input", () => {
  it("emits the attribute-tag satisfies check against the callee", () => {
    const file = join(DIR, "Page.preact.mx");
    const source = `import Card from "./Card.preact.mx";

export const page = (
  <Card>
    <@row|count|><strong>\${count.toFixed(1)}</strong></@row>
  </Card>
);
`;
    const warnings: MxWarning[] = [];
    const printed = print(source, file, {
      mx: true,
      // No `targets`: the entry's own lookup is the default under test.
      mxRegionCompile: (input) =>
        compilePreactRegion(input.source, { ...input, warnings }) as ReturnType<
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
