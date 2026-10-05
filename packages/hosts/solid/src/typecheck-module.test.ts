import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { appendSolidBuiltinImport } from "./typecheck-module.ts";

describe("appendSolidBuiltinImport parse-failure fallback (source-bindings-silent-parse-failure)", () => {
  it("appends the built-in normally when the generated text parses cleanly", () => {
    const generated = "function C() { return <Show>x</Show>; }";
    const { code, warning } = appendSolidBuiltinImport(generated);
    expect(code).toContain('import { Show } from "solid-js";');
    expect(warning).toBeUndefined();
  });

  it("skips a built-in already bound by the generated text's own import", () => {
    const generated =
      'import { Show } from "solid-js";\nfunction C() { return <Show>x</Show>; }';
    const { code, warning } = appendSolidBuiltinImport(generated);
    expect(code).toBe(generated);
    expect(warning).toBeUndefined();
  });

  it("appends every referenced built-in unconditionally, and returns a positioned warning, when the generated text fails to parse", () => {
    // Only reachable if the printer itself ever emitted invalid TSX (a bug
    // in the printer, not an author mistake -- see the function's own doc
    // comment). Over-importing here is the safe failure mode: it risks a
    // redundant import TypeScript tolerates, never a missing one that would
    // hide every real diagnostic inside the JSX behind TS2304 noise.
    const generated = "const x = ; function C() { return <Show>x</Show>; }";
    const { code, warning } = appendSolidBuiltinImport(generated);
    expect(code).toContain('import { Show } from "solid-js";');
    expect(warning).toBeDefined();
    expect(warning?.line).toBe(1);
    expect(warning?.column).toBe(0);
    expect(warning?.message).toContain("could not be parsed");
    expect(warning?.message).toContain("added conservatively");
  });

  // The positive case -- this warning reaching a real caller's
  // getCompileDiagnostics, not just this function's own return value -- is
  // covered in `@mxlang/typescript-plugin`'s
  // `typecheck-module-warning.test.ts`.
});

describe("Solid's completeTypecheckModule", () => {
  it("is appendSolidBuiltinImport behind the descriptor's lazy require", () => {
    const kind = descriptor.host?.fileKinds?.[0];
    const generated = "function C() { return <For each={[]}>{() => 1}</For>; }";
    expect(kind?.completeTypecheckModule?.(generated)).toEqual(
      appendSolidBuiltinImport(generated),
    );
  });
});
