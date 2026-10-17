import { expect, it } from "vitest";
import { solidDeclarations } from "./emitter.ts";

// A `<define>` called with attributes passes one attribute object on Solid, so core's multi-param `<define>` warning
// (it advises destructuring the one attribute object) is on for this host.
it("sets defineCallPassesAttrs, so the multi-param define warning is on", () => {
  expect(solidDeclarations.defineCallPassesAttrs).toBe(true);
});
