// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import type { Ir, IrNode } from "@mxlang/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * ir-spec 10.2: what the Astro emitter assumes about the IR it is handed.
 *
 * Each test lowers a real template, edits the IR at the `lower` seam (the mock
 * below runs `edit` on it) so one assumption is false or one field is
 * different, and asserts the emitter's output follows the IR and nothing else.
 */

let edit: ((ir: Ir) => void) | undefined;

vi.mock("@mxlang/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@mxlang/core")>();
  return {
    ...core,
    lower: (...args: Parameters<typeof core.lower>) => {
      const ir = core.lower(...args);
      edit?.(ir);
      return ir;
    },
  };
});

afterEach(() => {
  edit = undefined;
});

/** Compiles `source`, running `change` on the lowered IR before it is emitted. */
function emitted(source: string, change?: (ir: Ir) => void): string {
  edit = change;
  return lowerAstroMx(`---\nconst x = 1;\n---\n${source}`, "Test.astro.mx")
    .code;
}

type RangeSource = Extract<
  Extract<IrNode, { kind: "For" }>["source"],
  { kind: "range" }
>;

/** Every node of `kind` in an IR body, depth first. */
function all<K extends IrNode["kind"]>(
  value: unknown,
  kind: K,
  found: Array<Extract<IrNode, { kind: K }>> = [],
): Array<Extract<IrNode, { kind: K }>> {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) all(item, kind, found);
    return found;
  }
  if ((value as { kind?: string }).kind === kind) {
    found.push(value as Extract<IrNode, { kind: K }>);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "node" && key !== "loc") all(child, kind, found);
  }
  return found;
}

describe("Astro emitter: what it assumes about the IR (ir-spec 10.2)", () => {
  it("E3: prints Expr.code, not text rebuilt from Expr.node", () => {
    // Like the other hosts it may read `node` to inspect an expression, so
    // nulling every node is not a valid probe; what it must never do is print
    // from it.
    const changed = emitted("<p>${qwertyA}</p><i title=b>x</i>", (ir) => {
      for (const node of all(ir.body, "Interpolation")) {
        node.expr.code = "replaced";
        if (node.expr.node)
          node.expr.node = { type: "Identifier", name: "qwertyZ" };
      }
    });
    expect(changed).toContain("replaced");
    expect(changed).not.toMatch(/qwerty[AZ]/);
  });

  it("E8: Element.void alone omits the close tag and the children", () => {
    const source = "<section>body</section>";
    expect(emitted(source)).toContain("</section>");
    const voided = emitted(source, (ir) => {
      for (const node of all(ir.body, "Element")) {
        node.void = true;
        node.children = [];
      }
    });
    expect(voided).toContain("<section");
    expect(voided).not.toContain("</section>");
    expect(voided).not.toContain("body");
  });

  it("E9: Text.value is printed as it stands, never re-normalized", () => {
    const out = emitted("<p>x</p>", (ir) => {
      for (const node of all(ir.body, "Text")) node.value = "a   b  c";
    });
    expect(out).toContain("a   b  c");
  });

  it("5.14: an HTML comment is written out, a `//` comment is not", () => {
    const out = emitted("<!-- shown -->\n// author only\n<p>x</p>");
    expect(out).toContain("<!-- shown --><p>x</p>");
    expect(out).not.toContain("author only");
  });

  it("E12: a range's from: null starts at 0 and inclusive picks the bound", () => {
    const source = "<for|i| from=lowbound to=highbound><b>${i}</b></for>";
    const edited = (change: (range: RangeSource) => void) =>
      emitted(source, (ir) => {
        for (const node of all(ir.body, "For")) {
          if (node.source.kind === "range") change(node.source);
        }
      });
    const authored = edited(() => {});
    expect(authored).toContain("lowbound");
    const fromNull = edited((range) => {
      range.from = null;
    });
    expect(fromNull).not.toContain("lowbound");
    expect(fromNull).toContain("0");
    const exclusive = edited((range) => {
      range.inclusive = false;
    });
    expect(exclusive).not.toBe(authored);
  });
});
