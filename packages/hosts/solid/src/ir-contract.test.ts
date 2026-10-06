// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import type { Ir, IrNode } from "@mxlang/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * ir-spec 10.2: what the Solid emitter assumes about the IR it is handed.
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
  return compileSolidMx(source, { filename: "fixture.solid.mx" }).code;
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

/** Sets every `Expr.node` to null, as a lowering that has no parser nodes would. */
function dropParserNodes(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string" && "shape" in record) {
    record.node = null;
    return;
  }
  for (const child of Object.values(record)) dropParserNodes(child, seen);
}

describe("Solid emitter: what it assumes about the IR (ir-spec 10.2)", () => {
  it("E3: prints Expr.code, not text rebuilt from Expr.node", () => {
    // Solid does read `node` to *inspect* an expression (the `.class`
    // shorthand fold, a function-valued attribute, a string `by=` key), so
    // nulling every node is not a valid probe here; what it must never do is
    // print from it.
    const changed = emitted("<p>${a}</p><i title=b>x</i>", (ir) => {
      for (const node of all(ir.body, "Interpolation")) {
        node.expr.code = "replaced";
        if (node.expr.node) node.expr.node = { type: "Identifier", name: "z" };
      }
    });
    expect(changed).toContain("replaced");
    expect(changed).not.toMatch(/\ba\b|\bz\b/);
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

  it("5.14: a comment of either kind prints nothing", () => {
    const source = "<!-- shown in html -->\n// author only\n<p>x</p>";
    let kinds: Array<[boolean, string]> = [];
    const out = emitted(source, (ir) => {
      kinds = all(ir.body, "Comment").map((c) => [c.html, c.value.trim()]);
    });
    expect(kinds).toEqual([
      [true, "shown in html"],
      [false, "author only"],
    ]);
    expect(out).not.toContain("shown in html");
    expect(out).not.toContain("author only");
    expect(out).toBe(emitted("<p>x</p>"));
  });

  it("10.4: a Hoisted node in the body is rejected, positioned", () => {
    const position = { line: 3, column: 4 };
    expect(() =>
      emitted("<p>x</p>", (ir) => {
        ir.body.push({
          kind: "Hoisted",
          code: "const a = 1;",
          end: position,
          loc: position,
        } as IrNode);
      }),
    ).toThrow("a hoisted statement cannot be emitted inside a JSX expression");
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

  it.each([
    [
      "a literal range bound folds into a count (numericValue)",
      "<for|i| from=0 to=3><b>${i}</b></for>",
    ],
    [
      "a static template-literal class folds (staticTemplateValue)",
      "<div class=`a b`>x</div>",
    ],
    [
      "an authored class array is told from the shorthand fold",
      '<div class=["a", b]>x</div>',
    ],
  ])("E3: Solid reads Expr.node to inspect — %s", (_name, source) => {
    const authored = emitted(source);
    let nulled: string | Error;
    try {
      nulled = emitted(source, dropParserNodes);
    } catch (error) {
      nulled = error as Error;
    }
    // With the parser node gone the output changes or the compile fails: the
    // read is real, which is why section 4 lists it.
    expect(typeof nulled === "string" ? nulled : "error").not.toBe(authored);
  });
});
