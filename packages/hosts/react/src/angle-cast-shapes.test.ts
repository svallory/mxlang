// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template fixtures
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

function outcome(source: string, typeCheck: boolean) {
  try {
    compileReactMx(source, "/fixtures/angle-shapes.mx", { typeCheck });
    return { accepted: true };
  } catch (error) {
    const failure = error as { message: string; line: number; column: number };
    return {
      accepted: false,
      message: failure.message,
      line: failure.line,
      column: failure.column,
    };
  }
}

describe("shape checks through angle and authored as wrappers", () => {
  it.each([
    '<p ...(<any>{style: "red"})/>',
    '<p ...({style: "red"} as any)/>',
    '<p ...{style: <any>"red"}/>',
  ])("retains React spread-style refusals: %s", (source) => {
    const runtime = outcome(source, false);
    expect(runtime.accepted).toBe(false);
    expect(outcome(source, true)).toEqual(runtime);
  });
});
