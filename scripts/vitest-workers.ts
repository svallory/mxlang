import { existsSync, readFileSync } from "node:fs";
import os from "node:os";

/**
 * Cap vitest workers by free memory (operator ruling 2026-10-19):
 *
 *   maxWorkers = clamp(floor(MemAvailable / 1 GiB), 1, availableParallelism - 1)
 *
 * Why: a 14-core WSL2 box with 9 GB free started 13 workers at 0.6-0.8 GB each
 * plus a 1.3 GB main process, swapped for ~2 h and was OOM-killed. One worker
 * per GiB of *available* memory keeps the pool inside what the machine can
 * actually give. An explicit `VITEST_MAX_WORKERS` (or `--maxWorkers`, which
 * overrides the config at the CLI layer) always wins.
 *
 * `MemAvailable` is read from /proc/meminfo where it exists — `os.freemem()`
 * ignores reclaimable page cache and undercounts on Linux.
 */
export const GIB = 1024 ** 3;

export function memAvailableBytes(procMeminfo = "/proc/meminfo"): number {
  if (existsSync(procMeminfo)) {
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(
      readFileSync(procMeminfo, "utf8"),
    );
    if (m) return Number(m[1]) * 1024;
  }
  return os.freemem();
}

/** The clamp itself: never below 1, never above parallelism - 1 (also >= 1). */
export function workerCap(freeBytes: number, parallelism: number): number {
  const byMemory = Math.floor(freeBytes / GIB);
  const byCores = Math.max(parallelism - 1, 1);
  return Math.min(Math.max(byMemory, 1), byCores);
}

export interface ResolvedWorkers {
  workers: number;
  /** "override" when VITEST_MAX_WORKERS decided, "cap" when the memory clamp did. */
  reason: "override" | "cap";
  /** The free-memory figure the decision was based on (always reported, even when overridden). */
  freeBytes: number;
}

export function resolveWorkers(
  env: NodeJS.ProcessEnv = process.env,
  freeBytes: number = memAvailableBytes(),
  parallelism: number = os.availableParallelism(),
): ResolvedWorkers {
  const override = Number(env.VITEST_MAX_WORKERS);
  if (
    env.VITEST_MAX_WORKERS !== undefined &&
    Number.isFinite(override) &&
    override >= 1
  ) {
    return { workers: Math.floor(override), reason: "override", freeBytes };
  }
  return {
    workers: workerCap(freeBytes, parallelism),
    reason: "cap",
    freeBytes,
  };
}

/** The one startup line: `vitest workers: 6 (8.2 GB free)`. */
export function workersLogLine(r: ResolvedWorkers): string {
  const gb = (r.freeBytes / GIB).toFixed(1);
  return `vitest workers: ${r.workers} (${gb} GB free${r.reason === "override" ? ", VITEST_MAX_WORKERS override" : ""})`;
}
