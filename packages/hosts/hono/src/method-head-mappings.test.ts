import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

describe("Hono method head mappings through the shared emitter", () => {
  it.each([
    ["onClick(e: Missing) {}", "Missing"],
    ['onClick(e: number = "bad") {}', "e"],
    ["onClick<T extends Missing>(e: T) {}", "Missing"],
  ])("maps %s exactly", (method, token) => {
    const source = `<div>\n  <button ${method}/>\n</div>`;
    const { code, mappings } = compileHonoMx(source, "/fixtures/head.mx", {
      typeCheck: true,
    });
    const at = code.indexOf(token, code.indexOf("onClick="));
    const m = mappings.find(
      (item) =>
        item.generatedStart <= at && at + token.length <= item.generatedEnd,
    );
    expect(m).toBeDefined();
    expect(m && m.sourceStart + at - m.generatedStart).toBe(
      source.indexOf(token, source.indexOf("onClick")),
    );
  });
});
