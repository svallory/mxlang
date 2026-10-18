// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * Preact does not support `<script>`, so a `<script>` body that does not parse
 * is not read: the host's refusal (`MX_UNSUPPORTED_CONSTRUCT`) is the only
 * error, at the tag. Whole file and `.preact.mx` region alike; a region
 * reports the position in the surrounding file.
 */
import { createTargetLookup } from "@mxlang/core";
import { print } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const targets = createTargetLookup([descriptor]);
const FILE = "/fixtures/script-body/Panel.preact.mx";

const REFUSAL = "`<script>` is not supported in embedded MX on Preact.";
const CODE = "MX_UNSUPPORTED_CONSTRUCT";

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(run: () => unknown): any {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a compile error, but it compiled");
}

describe("a whole-file <script> body on Preact", () => {
  it("a decorator in the body is not read: the host refusal comes alone", () => {
    const error = thrown(() =>
      compilePreactMx("<div/>\n<script>\n@d class C {}\n</script>", "page.mx"),
    );
    expect(error.diagnosticCode).toBe(CODE);
    expect(error.message).toContain(REFUSAL);
    expect([error.line, error.column]).toEqual([2, 0]);
  });

  it("a syntax error in the body is not read: the host refusal comes alone", () => {
    const error = thrown(() =>
      compilePreactMx("<div/>\n<script>\nconst = 1;\n</script>", "page.mx"),
    );
    expect(error.diagnosticCode).toBe(CODE);
    expect(error.message).toContain(REFUSAL);
    expect([error.line, error.column]).toEqual([2, 0]);
  });

  it("a body that parses gets the same refusal", () => {
    const error = thrown(() =>
      compilePreactMx("<div/>\n<script>\nconst n = 1;\n</script>", "page.mx"),
    );
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
  });
});

describe("a <script> body in a .preact.mx region", () => {
  // The region sits at file line 3 (0-based 2), column 4, offset 40.
  const region = (source: string) =>
    thrown(() =>
      compilePreactRegion(source, {
        filename: FILE,
        baseOffset: 40,
        baseLine: 2,
        baseColumn: 4,
        targets,
      }),
    );

  it("reports the tag at the file's line, not the region's", () => {
    const error = region("<div/>\n<script>\n@d class C {}\n</script>");
    expect(error.diagnosticCode).toBe(CODE);
    expect(error.message).toContain(REFUSAL);
    expect([error.line, error.column]).toEqual([4, 0]);
  });

  it("adds the region's column on the region's first line", () => {
    const error = region("<script>const = 1;</script>");
    expect(error.diagnosticCode).toBe(CODE);
    expect([error.line, error.column]).toEqual([3, 4]);
  });

  it("is found in the module the bridge reads", () => {
    const source = `import { useState } from "preact/hooks";\nexport function Panel() {\n  return (\n    <div>\n      <script>\n@d class C {}\n      </script>\n    </div>\n  );\n}\n`;
    const error = thrown(() =>
      print(source, FILE, {
        mx: true,
        mxRegionCompile: (input) =>
          compilePreactRegion(input.source, {
            ...input,
            targets,
          }) as ReturnType<
            NonNullable<
              NonNullable<Parameters<typeof print>[2]>["mxRegionCompile"]
            >
          >,
      }),
    );
    expect(error.message).toContain(REFUSAL);
    expect(error.loc).toMatchObject({ line: 5, column: 6 });
  });
});
