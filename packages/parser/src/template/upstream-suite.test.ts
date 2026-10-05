/**
 * Runs the upstream htmljs-parser suite (`__tests__/`, 552 tests under
 * `node:test`, fixtures and snapshots included) from inside the workspace
 * test run, so `bun run test`, `bun run verify` and the remote gate cover it.
 * Vitest cannot collect `node:test` files, so they run in a child `node`.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const dir = fileURLToPath(new URL("./__tests__/", import.meta.url));

it("passes the upstream htmljs-parser test suite", () => {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", `${dir}*.test.ts`],
    { encoding: "utf8", env: { ...process.env, UPDATE_SNAPSHOTS: "" } },
  );
  const out = `${result.stdout}\n${result.stderr}`;
  expect(out, out.slice(-4000)).toMatch(/^# fail 0$/m);
  expect(result.status, out.slice(-4000)).toBe(0);
  expect(Number(/^# pass (\d+)$/m.exec(out)?.[1])).toBeGreaterThanOrEqual(552);
}, 120_000);
