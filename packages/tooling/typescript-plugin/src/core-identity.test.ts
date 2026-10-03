import { createRequire } from "node:module";
import * as core from "@mxlang/core";
import { expect, it } from "vitest";

it("shares core state with native lazy descriptor requires", () => {
  const native = createRequire(import.meta.url)("@mxlang/core") as typeof core;
  expect(core.withCalleeInputSources).toBe(native.withCalleeInputSources);
});
