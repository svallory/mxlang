import { describe, expect, it } from "vitest";
import {
  type FragmentBase,
  type Node,
  parseFragment,
  parseFragmentNative,
} from "./index.ts";

/**
 * `parseFragmentNative` is `parseFragment` (port PR 5): it was the proof that
 * the upstream offset patches (`docs/upstream/`) give the shifted positions
 * directly, and the MX front end now creates file-absolute positions from the
 * base, so it delegates. These pin the delegation: the same document, the
 * same positions, the same throws. `fragment.test.ts` pins the positions.
 */

const BASE: FragmentBase = { baseOffset: 120, baseLine: 5, baseColumn: 8 };

/** The first tag in a fragment's body. */
function firstTag(body: Node[]): Node {
  const tag = body.find((node: Node) => node.type === "MxTag");
  if (!tag) throw new Error("no MxTag in fragment body");
  return tag;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("parseFragmentNative", () => {
  it.each([
    ["no base", "<p>hello</p>\n", {}],
    ["a base", '<div class="a">x</div>\n', BASE],
    ["a later line", "<div>\n  <a href=input.url>x</a>\n</div>\n", BASE],
  ] as const)("parses like parseFragment with %s", (_label, source, base) => {
    const native = parseFragmentNative(source, base);
    expect(native.ast.type).toBe("MxDocument");
    expect(native.body).toBe(native.ast.body);
    expect(JSON.stringify(native.ast)).toBe(
      JSON.stringify(parseFragment(source, base).ast),
    );
  });

  it("puts the first tag at the base", () => {
    const { body } = parseFragmentNative('<div class="a">x</div>\n', BASE);
    expect(firstTag(body).start).toBe(120);
  });

  it.each([
    ["a template error", "<div>unclosed\n"],
    ["a bare `,` line", "<div/>\n,"],
    ["a method's type parameters", "<div x<A<B>>(a) {b}/>"],
  ])("throws what parseFragment throws for %s", (_label, source) => {
    const native = thrown(() => parseFragmentNative(source, BASE)) as Error;
    const shim = thrown(() => parseFragment(source, BASE)) as Error;
    expect(native).toBeInstanceOf(Error);
    expect(native.constructor).toBe(shim.constructor);
    expect(native.message).toBe(shim.message);
    const where = (error: unknown) => {
      const { line, column } = error as { line?: number; column?: number };
      return [line, column];
    };
    expect(where(native)).toEqual(where(shim));
    expect((native as { loc?: unknown }).loc).toEqual(
      (shim as { loc?: unknown }).loc,
    );
  });
});
