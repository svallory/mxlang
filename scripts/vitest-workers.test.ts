import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ancestorRunPids,
  cliMaxWorkers,
  GIB,
  markRunPid,
  memAvailableBytes,
  readReservedBytes,
  releaseReservation,
  reservedWorkerCount,
  reserveWorkers,
  resolveWorkers,
  workerCap,
  workerExecArgv,
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

describe("workerCap (reserved by others)", () => {
  it("sizes from available minus reserved, floor 1", () => {
    expect(workerCap(10 * GIB - 4 * GIB, 16)).toBe(6);
    expect(workerCap(10 * GIB - 12 * GIB, 16)).toBe(1);
  });
  it("resolveWorkers subtracts reservedBytes and reports it", () => {
    const r = resolveWorkers({}, 10 * GIB, 16, [], 4 * GIB);
    expect(r).toMatchObject({ workers: 6, reservedBytes: 4 * GIB });
    expect(workersLogLine(r)).toBe(
      "vitest workers: 6 (10.0 GiB free, 4.0 GiB reserved by other runs)",
    );
  });
});

describe("workerExecArgv (the heap cap)", () => {
  const dflt = ["--max-old-space-size=2000"];
  it("defaults to 2000 MiB", () => {
    expect(workerExecArgv({})).toEqual(dflt);
  });
  it("MX_VITEST_WORKER_HEAP_MB overrides; junk falls back", () => {
    expect(workerExecArgv({ MX_VITEST_WORKER_HEAP_MB: "3000" })).toEqual([
      "--max-old-space-size=3000",
    ]);
    expect(workerExecArgv({ MX_VITEST_WORKER_HEAP_MB: "0" })).toEqual(dflt);
    expect(workerExecArgv({ MX_VITEST_WORKER_HEAP_MB: "x" })).toEqual(dflt);
  });
});

describe("reservedWorkerCount", () => {
  it("a percentage --maxWorkers reserves ceil(pct x cores), a number its own count", () => {
    const pct = resolveWorkers({}, 30 * GIB, 14, ["--maxWorkers=75%"]);
    expect(reservedWorkerCount(pct, 14)).toBe(11);
    expect(reservedWorkerCount(resolveWorkers({}, 30 * GIB, 14, []), 14)).toBe(
      13,
    );
  });
});

describe("reservation ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-ledger-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const entry = (pid: number, bytes: number) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, bytes }));
  const file = (pid: number) => join(dir, `${pid}.json`);
  beforeEach(() => {
    for (const f of [1, 2, 3, 99]) releaseReservation(dir, f);
    rmSync(join(dir, ".lock"), { recursive: true, force: true });
  });
  const opts = { dir, parallelism: 16, env: {}, alive: () => true };
  const MAIN = 4.5 * GIB;
  const mib = 2 ** 20;

  it("counts a live entry, ignores a dead one, ignores its own and corrupt ones", () => {
    entry(2, 4 * GIB);
    entry(3, 5 * GIB);
    entry(1, 9 * GIB);
    writeFileSync(join(dir, "99.json"), "{nope");
    expect(readReservedBytes(dir, (pid) => pid !== 3, 1)).toBe(4 * GIB);
  });

  it("a new run is sized from available minus a live reservation", () => {
    entry(2, 4 * GIB);
    const r = reserveWorkers({ ...opts, freeBytes: 10 * GIB, pid: 1 });
    expect(r).toEqual({ workers: 6, reservedByOthers: 4 * GIB });
  });

  it("a run does not count the reservation of the run that spawned it", () => {
    entry(2, 4 * GIB);
    entry(3, 5 * GIB);
    const r = reserveWorkers({
      ...opts,
      freeBytes: 10 * GIB,
      pid: 1,
      ignorePids: [2],
    });
    expect(r.reservedByOthers).toBe(5 * GIB);
  });

  it("markRunPid chains pids through the environment", () => {
    const env: NodeJS.ProcessEnv = {};
    markRunPid(env, 7);
    markRunPid(env, 9);
    expect(ancestorRunPids(env)).toEqual([7, 9]);
    expect(ancestorRunPids({})).toEqual([]);
  });

  it("a reserve deletes the entry files of dead runs", () => {
    entry(3, 5 * GIB);
    const r = reserveWorkers({
      ...opts,
      alive: (pid: number) => pid !== 3,
      freeBytes: 10 * GIB,
      pid: 1,
    });
    expect(r.reservedByOthers).toBe(0);
    expect(existsSync(file(3))).toBe(false);
  });

  it("release removes the entry", () => {
    reserveWorkers({ ...opts, freeBytes: 4 * GIB, pid: 1 });
    expect(existsSync(file(1))).toBe(true);
    releaseReservation(dir, 1);
    expect(existsSync(file(1))).toBe(false);
  });

  it("the entry is workers x heap cap + main process, never more than the memory it was sized from", () => {
    reserveWorkers({ ...opts, freeBytes: 30 * GIB, pid: 1, decide: () => 2 });
    expect(readReservedBytes(dir, () => true, 99)).toBe(2 * 2000 * mib + MAIN);
    reserveWorkers({ ...opts, freeBytes: 12 * GIB, pid: 2, decide: () => 12 });
    expect(readReservedBytes(dir, () => true, 99)).toBe(
      2 * 2000 * mib + MAIN + (12 * GIB - (2 * 2000 * mib + MAIN)),
    );
  });

  it("a run waits for a held lock and writes its entry only after it is released", () => {
    mkdirSync(join(dir, ".lock"));
    let sleeps = 0;
    let entryDuringWait = true;
    const clock = {
      now: Date.now,
      sleep: () => {
        sleeps++;
        entryDuringWait = existsSync(file(1));
        rmSync(join(dir, ".lock"), { recursive: true });
      },
    };
    reserveWorkers({ ...opts, freeBytes: 4 * GIB, pid: 1, clock });
    expect(sleeps).toBe(1);
    expect(entryDuringWait).toBe(false);
    expect(existsSync(file(1))).toBe(true);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  });

  it("the entry is on disk while the lock is still held (reserve before release)", () => {
    let entryAtUnlock = false;
    const clock = {
      now: Date.now,
      sleep: () => {},
      onUnlock: () => {
        entryAtUnlock = existsSync(file(1));
      },
    };
    reserveWorkers({ ...opts, freeBytes: 4 * GIB, pid: 1, clock });
    expect(entryAtUnlock).toBe(true);
  });

  it("a lock older than the stale limit is broken without waiting", () => {
    mkdirSync(join(dir, ".lock"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock"), old, old);
    const clock = {
      now: Date.now,
      sleep: () => {
        throw new Error("waited on a stale lock");
      },
    };
    reserveWorkers({ ...opts, freeBytes: 4 * GIB, pid: 1, clock });
    expect(existsSync(file(1))).toBe(true);
  });

  it("after 5 s of a held fresh lock the run proceeds unlocked and leaves the lock alone", () => {
    mkdirSync(join(dir, ".lock"));
    let t = Date.now();
    const clock = {
      now: () => t,
      sleep: () => {
        t += 3_000;
      },
    };
    reserveWorkers({ ...opts, freeBytes: 4 * GIB, pid: 1, clock });
    expect(existsSync(file(1))).toBe(true);
    expect(existsSync(join(dir, ".lock"))).toBe(true);
  });
});

describe("release on exit and signals (spawned under node)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-ledger-proc-"));
  const ledger = join(dir, "ledger");
  const script = join(dir, "run.ts");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(ledger);
  const mod = join(import.meta.dirname, "vitest-workers.ts");
  writeFileSync(
    script,
    `import { reserveWorkers, releaseOnExit } from ${JSON.stringify(mod)};
reserveWorkers({ dir: process.argv[2], freeBytes: 4 * 1024 ** 3, parallelism: 4 });
releaseOnExit(process.argv[2]);
const count = () => process.listenerCount("exit") + process.listenerCount("SIGINT");
const once = count();
releaseOnExit(process.argv[2]);
if (process.argv[3] === "fail") process.exit(1);
console.log("ready", once, count());
setInterval(() => {}, 1000);
`,
  );

  it("entry is gone after a failing run", () => {
    const r = spawnSync(process.execPath, [script, ledger, "fail"]);
    expect(r.status).toBe(1);
    expect(existsSync(join(ledger, `${r.pid}.json`))).toBe(false);
  });

  it("entry is gone after SIGINT, and a second releaseOnExit adds no listeners", async () => {
    const child = spawn(process.execPath, [script, ledger, "wait"]);
    const ready = await new Promise<string>((res) =>
      child.stdout.once("data", (d) => res(String(d))),
    );
    const [, before, after] = ready.trim().split(" ");
    expect(after).toBe(before);
    expect(existsSync(join(ledger, `${child.pid}.json`))).toBe(true);
    const exited = new Promise((res) => child.once("exit", res));
    child.kill("SIGINT");
    await exited;
    expect(existsSync(join(ledger, `${child.pid}.json`))).toBe(false);
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
  it("finds --maxWorkers N and =N, and --max-workers; a percentage is kept as written", () => {
    expect(cliMaxWorkers(["vitest", "run", "--maxWorkers", "3"])).toEqual({
      value: 3,
      raw: "3",
    });
    expect(cliMaxWorkers(["--maxWorkers=4"])).toEqual({ value: 4, raw: "4" });
    expect(cliMaxWorkers(["--max-workers", "2"])).toEqual({
      value: 2,
      raw: "2",
    });
    expect(cliMaxWorkers(["--max-workers=75%"])).toEqual({ raw: "75%" });
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
  it("a percentage --maxWorkers keeps the cap as the config value and reports the token", () => {
    const r = resolveWorkers({}, 12 * GIB, 14, ["--maxWorkers=75%"]);
    expect(r).toMatchObject({ workers: 12, reason: "cli", cliRaw: "75%" });
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

  it("marks a CLI --maxWorkers, including a percentage as written", () => {
    expect(
      workersLogLine({
        workers: 3,
        reason: "cli",
        freeBytes: 12 * GIB,
        cliRaw: "3",
      }),
    ).toBe(
      "vitest workers: 3 (12.0 GiB free, --maxWorkers 3 wins over the cap)",
    );
    expect(
      workersLogLine({
        workers: 9,
        reason: "cli",
        freeBytes: 12 * GIB,
        cliRaw: "75%",
      }),
    ).toBe(
      "vitest workers: 75% of cores (12.0 GiB free, --maxWorkers 75% wins over the cap)",
    );
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
