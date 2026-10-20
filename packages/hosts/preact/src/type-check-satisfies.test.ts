import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * Parity pin: preact keeps the authored TypeScript wrappers in the
 * `typeCheck` projection (`stripTypes: false`), the same retention html's
 * tooling projection has, so the tools that type-check the module report a
 * failing `satisfies`; the runtime compile still strips it, byte for byte
 * as before. Angle assertions become parenthesized `as` expressions in
 * the projection, where they are checked without being parsed as JSX.
 */
const compile = (source: string, typeCheck?: boolean) =>
  compilePreactMx(source, "/fixtures/satisfies.preact.mx", { typeCheck });

// biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
const PLACEHOLDER = "<span>${(1 as number) satisfies string}</span>";
// biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
const EXCESS = "<span>${({ a: 1 } satisfies { b: number })}</span>";
const CONST_TAG = "<const/y=(1 as number) satisfies string/>y";
// biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
const ANGLE = "<span>${(<number>1)}</span>";

describe("preact keeps satisfies in the type-check module (parity with html)", () => {
  it("keeps the wrapper in the type-check module and strips it at runtime", () => {
    const checked = compile(PLACEHOLDER, true).code;
    expect(checked).toContain("satisfies string");
    expect(compile(PLACEHOLDER).code).not.toContain("satisfies");
  });

  it("keeps an object literal's excess-property `satisfies`", () => {
    expect(compile(EXCESS, true).code).toContain("{ a: 1 } satisfies");
  });

  it("keeps `satisfies` on a `<const>` value", () => {
    const checked = compile(CONST_TAG, true).code;
    expect(checked).toContain("satisfies string");
    expect(compile(CONST_TAG).code).not.toContain("satisfies");
  });

  it("checks the angle-bracket cast as an equivalent as assertion (TSX)", () => {
    const checked = compile(ANGLE, true).code;
    expect(checked).toContain("(1 as number)");
    expect(checked).not.toContain("<number>");
    expect(compile(ANGLE).code).not.toContain("<number>");
  });
});
