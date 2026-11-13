import { describe, expect, it } from "vitest";
import State from "./tokenizer/state.ts";

// `tryParse` keeps a clone and restores it when an attempt loses. The callee
// files of a region compiled inside that attempt must go with it, so the
// clone's list cannot be the live state's own array.
describe("State.clone", () => {
  it("copies mxRegionDependencies, so a losing attempt's callees are dropped", () => {
    const state = new State();
    state.mxRegionDependencies.push("/project/A.mx");
    const kept = state.clone();
    state.mxRegionDependencies.push("/project/Speculative.mx");
    expect(kept.mxRegionDependencies).toEqual(["/project/A.mx"]);
  });
});
