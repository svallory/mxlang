import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliMaxWorkers,
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
    // GitHub ubuntu-latest for a public repo: 4 vCPU, 16 GB total (so ~14 GiB
    // MemAvailable). The core cap binds, not memory: clamp(14, 1, 3) = 3.
    expect(resolveWorkers({}, 14 * GIB, 4).workers).toBe(3);
    expect(resolveWorkers({}, 5.5 * GIB, 4).workers).toBe(3);
    expect(resolveWorkers({}, 2.1 * GIB, 4).workers).toBe(2);
  });
});

describe("cliMaxWorkers (the CLI override)", () => {
  it("finds --maxWorkers N and =N, and --max-workers", () => {
    expect(cliMaxWorkers(["vitest", "run", "--maxWorkers", "3"])).toBe(3);
    expect(cliMaxWorkers(["--maxWorkers=4"])).toBe(4);
    expect(cliMaxWorkers(["--max-workers", "2"])).toBe(2);
    expect(cliMaxWorkers(["--max-workers=75%"])).toBe(75);
  });
  it("returns undefined when absent or unparsable", () => {
    expect(cliMaxWorkers(["vitest", "run"])).toBeUndefined();
    expect(cliMaxWorkers(["--maxWorkers", "nope"])).toBeUndefined();
    expect(cliMaxWorkers(["--maxWorkers"])).toBeUndefined();
  });
  it("a --maxWorkers on the CLI is reported instead of the cap", () => {
    const r = resolveWorkers({}, 30 * GIB, 14, ["--maxWorkers", "3"]);
    expect(r).toMatchObject({ workers: 3, reason: "cli" });
  });
  it("VITEST_MAX_WORKERS wins when there is no --maxWorkers", () => {
    expect(
      resolveWorkers({ VITEST_MAX_WORKERS: "6" }, 30 * GIB, 14, []),
    ).toMatchObject({ workers: 6, reason: "override" });
  });
});

describe("workersLogLine", () => {
  it("states the count and the free memory in GiB", () => {
    expect(
      workersLogLine({ workers: 8, reason: "cap", freeBytes: 8.2 * GIB }),
    ).toBe("vitest workers: 8 (8.2 GiB free)");
  });

  it("marks an override", () => {
    expect(
      workersLogLine({ workers: 6, reason: "override", freeBytes: GIB }),
    ).toBe("vitest workers: 6 (1.0 GiB free, VITEST_MAX_WORKERS override)");
  });

  it("marks a CLI --maxWorkers", () => {
    expect(
      workersLogLine({ workers: 3, reason: "cli", freeBytes: 12 * GIB }),
    ).toBe("vitest workers: 3 (12.0 GiB free, --maxWorkers wins over the cap)");
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
