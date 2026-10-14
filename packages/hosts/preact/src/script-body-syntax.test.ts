// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A `<script>` body that does not parse is refused on a JSX host, ahead of the
 * host's own refusal of `<script>` (`MX_UNSUPPORTED_CONSTRUCT`): core reads the
 * body for its analyses first, the way it reads a stale read in a handler
 * before the host refuses the handler. Whole file and `.preact.mx` region
 * alike; a region reports the position in the surrounding file.
 */
import { createTargetLookup } from "@mxlang/core";
import { print } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const targets = createTargetLookup([descriptor]);
const FILE = "/fixtures/script-body/Panel.preact.mx";

const DECORATOR =
  "Decorators are not read inside a `<script>` body: its text is TypeScript without decorator syntax. Move the decorated class to a `.ts` module and import it, or apply the decorator as a plain function call";

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
  it("is refused at the decorator", () => {
    const error = thrown(() =>
      compilePreactMx("<div/>\n<script>\n@d class C {}\n</script>", "page.mx"),
    );
    expect(error.diagnosticCode).toBe("MX_INVALID_STATEMENT");
    expect(error.message).toBe(DECORATOR);
    expect([error.line, error.column]).toEqual([3, 0]);
    expect(error.end).toEqual({ line: 3, column: 2 });
  });

  it("is refused at a syntax error", () => {
    const error = thrown(() =>
      compilePreactMx("<div/>\n<script>\nconst = 1;\n</script>", "page.mx"),
    );
    expect(error.diagnosticCode).toBe("MX_INVALID_STATEMENT");
    expect(error.message).toBe("Unexpected token");
    expect([error.line, error.column]).toEqual([3, 6]);
  });

  it("is left to the host's own refusal when it parses", () => {
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

  it("reports a line below the first at the file's line, not the region's", () => {
    const error = region("<div/>\n<script>\n@d class C {}\n</script>");
    expect(error.diagnosticCode).toBe("MX_INVALID_STATEMENT");
    expect([error.line, error.column]).toEqual([5, 0]);
    expect(error.end).toEqual({ line: 5, column: 2 });
  });

  it("adds the region's column on the region's first line", () => {
    // `<script>const = 1;` starts the region: 4 + 8 (`<script>`) + 6.
    const error = region("<script>const = 1;</script>");
    expect([error.line, error.column]).toEqual([3, 18]);
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
    expect(error.message).toContain("Decorators are not read");
    expect(error.loc).toMatchObject({ line: 6, column: 0 });
  });
});
