import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIB,
  memAvailableBytes,
  resolveWorkers,
  workerCap,
  workersLogLine,
} from "./vitest-workers.ts";

describe("workerCap (the clamp)", () => {
  it("gives one worker per GiB of available memory", () => {
    expect(workerCap(8.2 * GIB, 16)).toBe(8);
    expect(workerCap(9 * GIB, 14)).toBe(9);
  });

  it("never falls below 1, whatever the memory", () => {
    expect(workerCap(0, 16)).toBe(1);
    expect(workerCap(0.4 * GIB, 14)).toBe(1);
  });

  it("never exceeds availableParallelism - 1", () => {
    // win's WSL2: 30 GiB free on 14 cores would ask for 30 workers.
    expect(workerCap(30 * GIB, 14)).toBe(13);
    // a 2-core CI runner with plenty of memory still gets 1.
    expect(workerCap(30 * GIB, 2)).toBe(1);
  });

  it("stays at 1 when parallelism itself is 1", () => {
    expect(workerCap(30 * GIB, 1)).toBe(1);
  });
});

describe("resolveWorkers (the override)", () => {
  it("VITEST_MAX_WORKERS wins over the clamp", () => {
    const r = resolveWorkers({ VITEST_MAX_WORKERS: "6" }, 30 * GIB, 14);
    expect(r).toMatchObject({ workers: 6, reason: "override" });
  });

  it("an unparsable or zero VITEST_MAX_WORKERS falls back to the clamp", () => {
    expect(
      resolveWorkers({ VITEST_MAX_WORKERS: "nope" }, 30 * GIB, 14).reason,
    ).toBe("cap");
    expect(
      resolveWorkers({ VITEST_MAX_WORKERS: "0" }, 30 * GIB, 14).reason,
    ).toBe("cap");
    expect(
      resolveWorkers({ VITEST_MAX_WORKERS: "-2" }, 30 * GIB, 14).reason,
    ).toBe("cap");
  });

  it("unset env uses the memory clamp", () => {
    expect(resolveWorkers({}, 8.2 * GIB, 16)).toMatchObject({
      workers: 8,
      reason: "cap",
      freeBytes: 8.2 * GIB,
    });
  });

  it("the CI case by injected values: a small runner with ~5 GiB available on 4 cores gets 3", () => {
    // GitHub ubuntu-latest: 4 vCPU, ~7 GB total, ~5-6 GB MemAvailable.
    expect(resolveWorkers({}, 5.5 * GIB, 4).workers).toBe(3);
    expect(resolveWorkers({}, 2.1 * GIB, 4).workers).toBe(2);
  });
});

describe("workersLogLine", () => {
  it("states the count and the free memory", () => {
    expect(
      workersLogLine({ workers: 8, reason: "cap", freeBytes: 8.2 * GIB }),
    ).toBe("vitest workers: 8 (8.2 GB free)");
  });

  it("marks an override", () => {
    expect(
      workersLogLine({ workers: 6, reason: "override", freeBytes: GIB }),
    ).toBe("vitest workers: 6 (1.0 GB free, VITEST_MAX_WORKERS override)");
  });
});

describe("memAvailableBytes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads MemAvailable from a meminfo file, in bytes", () => {
    const d = mkdtempSync(join(tmpdir(), "mx-workers-"));
    dirs.push(d);
    const f = join(d, "meminfo");
    writeFileSync(
      f,
      "MemTotal:       16000000 kB\nMemAvailable:    8400000 kB\n",
    );
    expect(memAvailableBytes(f)).toBe(8400000 * 1024);
  });

  it("falls back to os.freemem() when there is no meminfo", () => {
    expect(
      memAvailableBytes(join(tmpdir(), "mx-workers-no-such-file")),
    ).toBeGreaterThan(0);
  });

  it("falls back when MemAvailable is missing but the file exists", () => {
    const d = mkdtempSync(join(tmpdir(), "mx-workers-"));
    dirs.push(d);
    const f = join(d, "meminfo");
    writeFileSync(f, "MemTotal: 16000000 kB\n");
    expect(memAvailableBytes(f)).toBeGreaterThan(0);
  });
});
