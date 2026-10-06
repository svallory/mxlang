/**
 * The host-author docs hand a copy-paste snippet that loads data's descriptor
 * by specifier. A stale specifier (`@mxlang/data` has no default export) made
 * the snippet throw at load, so this reads it out of the page and checks that
 * it names a real export.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const page = readFileSync(
  join(root, "../../../apps/docs/docs/targets/third-party-targets.md"),
  "utf8",
);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
};

describe("third-party-targets.md: the data descriptor snippet", () => {
  const match = /require\("(@mxlang\/data[^"]*)"\)\.default/.exec(page);

  it("requires a specifier @mxlang/data exports", () => {
    expect(match).not.toBeNull();
    const subpath = (match?.[1] ?? "").replace("@mxlang/data", ".");
    expect(Object.keys(pkg.exports)).toContain(subpath);
  });

  it("whose default export is the descriptor", async () => {
    expect(match?.[1]).toBe("@mxlang/data/descriptor");
    const { default: descriptor } = await import("./descriptor.ts");
    expect(descriptor).toMatchObject({ defaultTag: "object" });
  });
});
