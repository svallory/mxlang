import { expect, it } from "vitest";
import { angularDeclarations } from "../src/index.ts";

// Decision 160 is not implemented here yet (`define-call-attrs-angular`), so
// core's multi-param `<define>` warning, which gives advice that is wrong for
// this host's per-param binding, must stay off.
it("does not set defineCallPassesAttrs, so the multi-param define warning stays off", () => {
  expect(angularDeclarations.defineCallPassesAttrs).toBeUndefined();
});
