import { expect, it, vi } from "vitest";

// An aggregate that carries no errors still has to surface: one report, never
// a silent `[]`. The compile is replaced so it can throw one.
const state = vi.hoisted(() => ({ thrown: undefined as unknown }));
vi.mock("@mxlang/tsx-bridge", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mxlang/tsx-bridge")>();
  return {
    ...original,
    print: () => {
      throw state.thrown;
    },
  };
});

import { diagnoseDocument } from "./diagnose.ts";

it("hands an aggregate with no errors to onUnexpectedError, once", () => {
  const empty = Object.assign(new Error(""), {
    name: "CompileErrors",
    errors: [],
  });
  state.thrown = empty;
  const unexpected: unknown[] = [];
  const diagnostics = diagnoseDocument(
    "export const x = 1;\n",
    "file:///project/Panel.preact.mx",
    { target: "html" },
    (error) => unexpected.push(error),
  );
  expect(diagnostics).toEqual([]);
  expect(unexpected).toEqual([empty]);
});
