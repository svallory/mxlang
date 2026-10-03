import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { builtinLookup } from "../../../target-registry/src/index.ts";
import { build } from "../src/build.ts";
import { readAngularConfig } from "../src/config.ts";
import { discoverFiles } from "../src/discover.ts";
import { startWatch, type WatchHandle } from "../src/watch.ts";

let dir: string | undefined;
let handle: WatchHandle | undefined;
function fixture(host: string) {
  dir = mkdtempSync(join(tmpdir(), "mx-angular-hosts-r2-"));
  mkdirSync(join(dir, "extra"));
  writeFileSync(join(dir, "extra/thing.mx"), "<div/>");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      mx: { angular: { include: [] }, tags: [{ dir: "extra", hosts: [host] }] },
    }),
  );
  return dir;
}
afterEach(() => {
  handle?.close();
  handle = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

it("own-only Angular discovery leaves peer hosts unresolved without a warning", () => {
  const root = fixture("solid");
  const result = discoverFiles(root, readAngularConfig(root));
  expect(result.files).toEqual([]);
  expect(result.diagnostics).toEqual([]);
});
it("own-only Angular build does not warn about peer hosts, including per-file scans", () => {
  const root = fixture("solid");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/page.mx"), "<div/>");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      mx: {
        angular: { include: ["src/**/*.mx"] },
        tags: [{ dir: "extra", hosts: ["solid"] }],
      },
    }),
  );
  expect(build(root)).toMatchObject({ ok: true, errors: [], warnings: [] });
});
it("own-only Angular watch does not warn about peer hosts", async () => {
  const lines: string[] = [];
  handle = startWatch(fixture("solid"), {
    once: true,
    onLine: (line) => lines.push(line),
  });
  await handle.onIdle;
  expect(lines.filter((line) => line.includes("warning:"))).toEqual([]);
});

it("reports positioned unknown hosts during registry-backed discovery with zero routed files", () => {
  const root = fixture("bogus");
  const result = discoverFiles(
    root,
    readAngularConfig(root),
    builtinLookup(),
    true,
  );
  expect(result.files).toEqual([]);
  expect(result.diagnostics).toEqual([
    {
      file: join(root, "package.json"),
      message: "`mx.tags` names an unknown host in `hosts`: bogus",
      line: 1,
      column: expect.any(Number),
    },
  ]);
});
it("reports unknown hosts from registry-backed zero-file build", () => {
  const root = fixture("bogus");
  const result = build(root, builtinLookup(), true);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]?.message).toContain(
    "unknown host in `hosts`: bogus",
  );
});
it("reports unknown hosts from registry-backed zero-file watch", async () => {
  const lines: string[] = [];
  handle = startWatch(fixture("bogus"), {
    once: true,
    targets: builtinLookup(),
    validateHostNames: true,
    onLine: (line) => lines.push(line),
  });
  await handle.onIdle;
  expect(
    lines.filter((line) => line.includes("unknown host in `hosts`: bogus")),
  ).toHaveLength(1);
});
