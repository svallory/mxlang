import { describe, expect, it } from "vitest";
import * as main from "./index.ts";
import { createOut } from "./runtime.ts";

describe("@mxlang/host-astro/runtime", () => {
  it("exports a createOut that makes a working sink", () => {
    const out = createOut();
    out.write("<b>");
    out.write("x</b>");
    expect(out.toString()).toBe("<b>x</b>");
  });

  it("is not re-exported from the main entry, which cannot load in an SSR bundle", () => {
    expect("createOut" in main).toBe(false);
  });
});
