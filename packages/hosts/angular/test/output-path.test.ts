import { describe, expect, it } from "vitest";
import { outputPathFor } from "../src/build.ts";

// The output sits where the emitted imports point: the source's name with its
// MX suffix (`.mx`, or `.ng.mx` for a component file) removed whatever its
// case, so `./tags/Badge` names the module `tags/Badge.MX` compiles to.
describe("outputPathFor", () => {
  it.each([
    ["/p/tags/badge.mx", ".ts", "/p/tags/badge.ts"],
    ["/p/tags/Badge.MX", ".ts", "/p/tags/Badge.ts"],
    ["/p/src/x.component.ng.mx", ".ts", "/p/src/x.component.ts"],
    ["/p/src/X.component.NG.MX", ".ts", "/p/src/X.component.ts"],
    ["/p/src/page.Mx", ".html", "/p/src/page.html"],
  ])("%s -> %s output is %s", (mxPath, extension, expected) => {
    expect(outputPathFor(mxPath, extension)).toBe(expected);
  });
});
