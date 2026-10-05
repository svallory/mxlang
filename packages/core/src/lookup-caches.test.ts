import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCalleeInput, resetCalleeInputCache } from "./callee-input.ts";
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
function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mx-lookup-caches-"));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return join(dir, "page.mx");
}
afterEach(() => {
  resetCalleeInputCache();
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

for (const order of [
  [own, lookup],
  [lookup, own],
]) {
  it(`partitions callee Input analysis by lookup (${order[0] === own ? "own first" : "full first"})`, () => {
    const importer = project({
      "package.json": "{}",
      "card.ts":
        'import type { AttrTag } from "@t/unit"; export interface Input { header: AttrTag<{ title: string }> }',
    });
    const results = order.map((targets) =>
      readCalleeInput(
        { kind: "name", name: "Card" },
        { importer, targets, imports: new Map([["Card", "./card.ts"]]) },
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const input = results[i]!.input;
      expect(input.kind).toBe("declared");
      if (input.kind === "declared")
        expect([...input.attrTags.keys()]).toEqual(
          order[i] === own ? [] : ["header"],
        );
    }
    expect(results[0]).not.toBe(results[1]);
  });
}

it("distinguishes no scan filtering from a target with no host filter key in either cache order", () => {
  for (const order of [
    [undefined, null],
    [null, undefined],
  ]) {
    const file = project({
      "package.json": JSON.stringify({
        mx: { tags: [{ dir: "extra", hosts: ["unit"] }] },
      }),
      "extra/thing.mx": "<div/>",
      "tags/shared.mx": "<div/>",
    });
    for (const host of order) {
      const result = scanCached(file, { targets: lookup, host });
      expect([...result.tags.keys()].sort()).toEqual(
        host === null ? ["shared"] : ["shared", "thing"],
      );
    }
  }
});
