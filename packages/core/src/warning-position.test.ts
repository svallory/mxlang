import { describe, expect, it, vi } from "vitest";
import { newCtx, warn } from "./core.ts";
import { lookup } from "./test-targets.ts";

function context() {
  return newCtx(
    "",
    () => "",
    { tags: {}, isElement: () => true, isComponent: () => false },
    undefined,
    "test.mx",
    lookup,
  );
}

describe("warning text positions", () => {
  it("prints 1-based columns without changing the structured warning", () => {
    const print = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warning = {
      file: "test.mx",
      line: 5,
      column: 20,
      message: "a warning",
    };
    try {
      warn(context(), warning);
      expect(print.mock.calls).toEqual([["test.mx:5:21: a warning"]]);
      const ctx = context();
      ctx.warnings = [];
      warn(ctx, warning);
      expect(ctx.warnings).toEqual([
        { file: "test.mx", line: 5, column: 20, message: "a warning" },
      ]);
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      print.mockRestore();
    }
  });

  it("prints column one when the warning has no filename and column zero", () => {
    const print = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warn(context(), { line: 1, column: 0, message: "a warning" });
      expect(print.mock.calls).toEqual([["1:1: a warning"]]);
    } finally {
      print.mockRestore();
    }
  });
});
