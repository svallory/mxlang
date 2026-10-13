import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * A handler, a `<script>` body or a `<lifecycle>` hook cannot read a derived
 * `<const>` after writing a `<let>` it depends on (core raises it for every
 * target that has `<let>`; the html target's default policy has it). The
 * strict policy refuses `<let>` itself, so it never reaches the read.
 */

const file = "/tmp/mx-stale-read-test/page.mx";
const CART =
  "<let/items=[]/>\n<const/total=items.length/>\n<button onClick() {\n  items = [];\n  log(total);\n}>x</button>\n";

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(source: string, options?: { strict?: boolean }): any {
  try {
    compile(source, file, options);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the html target's default policy", () => {
  it("refuses the read, not the handler's missing runtime", () => {
    const error = thrown(CART);
    expect(error.message).toBe(
      "`total` is stale here: it derives from `items`, which this handler wrote on line 4. Compute from `items` directly, or move the check into a `<script>`, which runs after the write settles on every target.",
    );
    expect(error.diagnosticCode).toBe("MX_STALE_DERIVED_READ");
    expect([error.line, error.column]).toEqual([5, 6]);
    expect(error.end).toEqual({ line: 5, column: 11 });
    expect(error.fixes).toBeUndefined();
  });

  it("accepts the read before the write (the handler still needs a runtime)", () => {
    const error = thrown(
      CART.replace(
        "  items = [];\n  log(total);",
        "  log(total);\n  items = [];",
      ),
    );
    expect(error.diagnosticCode).not.toBe("MX_STALE_DERIVED_READ");
  });
});

const HEAD = "<let/items=[]/>\n<const/total=items.length/>\n";
const BODIES: Array<[string, string, string]> = [
  [
    "a `<script>` body",
    `${HEAD}<script>\n  items = [];\n  log(total);\n</script>\n`,
    "this `<script>`",
  ],
  [
    "a `<lifecycle>` hook",
    `${HEAD}<lifecycle onMount() {\n  items = [];\n  log(total);\n}/>\n`,
    "this `<lifecycle>` hook",
  ],
];

describe.each(BODIES)(
  "the html target's default policy: %s",
  (_name, source, writer) => {
    it("refuses the read, with the one fix a writing body has", () => {
      const error = thrown(source);
      expect(error.message).toBe(
        `\`total\` is stale here: it derives from \`items\`, which ${writer} wrote on line 4. Compute from \`items\` directly.`,
      );
      expect(error.diagnosticCode).toBe("MX_STALE_DERIVED_READ");
      expect([error.line, error.column]).toEqual([5, 6]);
      expect(error.end).toEqual({ line: 5, column: 11 });
      expect(error.fixes).toBeUndefined();
    });

    it("accepts the read before the write", () => {
      const error = thrown(
        source.replace(
          "  items = [];\n  log(total);",
          "  log(total);\n  items = [];",
        ),
      );
      expect(error?.diagnosticCode).not.toBe("MX_STALE_DERIVED_READ");
    });
  },
);

describe.each(BODIES)("the strict policy: %s", (_name, source) => {
  it("refuses `<let>` itself, and the read is not reported", () => {
    const error = thrown(source, { strict: true });
    expect(error.message).toBe(
      "`<let>` is reactive state and requires a runtime; this strict policy has no reactive target",
    );
    expect(error.message).not.toContain("is stale here");
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error.line, error.column]).toEqual([1, 0]);
  });
});

describe("the strict policy", () => {
  it("refuses `<let>` itself, and the read is not reported", () => {
    const error = thrown(CART, { strict: true });
    expect(error.message).toBe(
      "`<let>` is reactive state and requires a runtime; this strict policy has no reactive target",
    );
    expect(error.message).not.toContain("is stale here");
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error.line, error.column]).toEqual([1, 0]);
  });
});
