import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearScanCache, scanCached } from "./scan-cache.ts";
import { createTargetLookup } from "./target-descriptor.ts";
import { lookup } from "./test-targets.ts";

const own = createTargetLookup([
  {
    descriptorVersion: 0,
    name: "page",
    packageName: "@t/page",
    defaultTag: "node",
  },
]);
const dirs: string[] = [];
function project(manifest: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mx-dotted-cache-"));
  dirs.push(dir);
  mkdirSync(join(dir, "tags"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "tags/x.u.mx"), "<div/>");
  return join(dir, "page.mx");
}
afterEach(() => {
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

for (const order of [
  [own, lookup],
  [lookup, own],
]) {
  it(`derives dotted filename wording per cached caller (${order[0] === own ? "own first" : "full first"})`, () => {
    const file = project();
    const results = order.map((targets) => scanCached(file, { targets }));
    for (let i = 0; i < results.length; i++) {
      expect(results[i]!.diagnostics[0]!.message).toContain(
        order[i] === own
          ? "cannot be called as a tag"
          : "is a host module file",
      );
      expect(results[i]!.tags.size).toBe(0);
    }
    expect(results[0]!.customTags).toBe(results[1]!.customTags);
  });
}
it("preserves scan diagnostic ordering while re-deriving dotted wording", () => {
  const file = project({ mx: { tags: ["missing"] } });
  for (const targets of [own, lookup]) {
    const diagnostics = scanCached(file, { targets }).diagnostics;
    expect(diagnostics.map((d) => d.file)).toEqual([
      join(file, "../tags/x.u.mx"),
      join(file, "../package.json"),
    ]);
  }
});
