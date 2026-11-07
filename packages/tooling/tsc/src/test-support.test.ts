import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runAsync } from "./test-support.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it("runAsync kills its child when the signal aborts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-tsc-run-async-"));
  try {
    const pidFile = join(dir, "pid");
    const script = join(dir, "sleeper.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const pending = runAsync(script, [], controller.signal);
    // Abort only once the child is provably running.
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    controller.abort();
    expect((await pending).status).not.toBe(0);
    // The abort reports first; the kill signal lands a moment later.
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
