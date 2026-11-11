import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";

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

/**
 * Per-worker V8 heap cap, in MiB (`--max-old-space-size` on every forks
 * worker; the threads pool cannot take it, ERR_WORKER_INVALID_EXEC_ARGV).
 * Set `MX_VITEST_WORKER_HEAP_MB` to override (a positive integer).
 * The default is HEAP_PEAK_MB plus HEAP_MARGIN_MB: the highest used heap of
 * any forks worker over a full gate-equivalent run (66 workers, isolate:false,
 * so a reused worker carries heap across files), sampled per process every
 * 300 ms: 1271 MB, RSS 1849 MB. The margin rounds the cap to 2000.
 */
const HEAP_PEAK_MB = 1271;
const HEAP_MARGIN_MB = 729;
const DEFAULT_WORKER_HEAP_MB = HEAP_PEAK_MB + HEAP_MARGIN_MB;
/** Main process reservation, in bytes: measured peak RSS 4.7 GB, heap 1.7 GB. */
const MAIN_PROCESS_BYTES = 4.5 * GIB;

function workerHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MX_VITEST_WORKER_HEAP_MB);
  return env.MX_VITEST_WORKER_HEAP_MB !== undefined &&
    Number.isInteger(v) &&
    v >= 1
    ? v
    : DEFAULT_WORKER_HEAP_MB;
}

/** The execArgv for the forks workers (the threads pool cannot take it: ERR_WORKER_INVALID_EXEC_ARGV). */
export function workerExecArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [`--max-old-space-size=${workerHeapMb(env)}`];
}

/** Bytes a run reserves: its workers at the heap cap, plus the main process. */
function reservationBytes(
  workers: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return workers * workerHeapMb(env) * 1024 * 1024 + MAIN_PROCESS_BYTES;
}

// ---- Per-host reservation ledger -----------------------------------------
// One JSON file per live run in `<os.tmpdir()>/mx-vitest-ledger/<pid>.json`.
// Reading and writing happen under a mkdir lock (atomic on every OS), so two
// runs starting together are ordered: the second reads the first's entry.
// A SIGKILLed run leaves its file; readers drop entries whose pid is gone.

interface LedgerEntry {
  pid: number;
  bytes: number;
}

function defaultLedgerDir(): string {
  return join(os.tmpdir(), "mx-vitest-ledger");
}

/** True when a process with this pid exists (EPERM means it exists). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Bytes held by other live runs, and the entry files of dead ones. */
function readLedger(
  dir: string,
  alive: (pid: number) => boolean,
  selfPid: number,
  ignorePids: readonly number[] = [],
): { total: number; dead: string[] } {
  let total = 0;
  const dead: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { total, dead };
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const e = JSON.parse(
        readFileSync(join(dir, name), "utf8"),
      ) as LedgerEntry;
      if (e.pid === selfPid || ignorePids.includes(e.pid)) continue;
      if (!alive(e.pid)) {
        dead.push(name);
        continue;
      }
      if (Number.isFinite(e.bytes) && e.bytes > 0) total += e.bytes;
    } catch {
      // half-written or corrupt entry: counts for nothing
    }
  }
  return { total, dead };
}

export function readReservedBytes(
  dir: string = defaultLedgerDir(),
  alive: (pid: number) => boolean = pidAlive,
  selfPid: number = process.pid,
): number {
  return readLedger(dir, alive, selfPid).total;
}

export function releaseReservation(
  dir: string = defaultLedgerDir(),
  pid: number = process.pid,
): void {
  rmSync(join(dir, `${pid}.json`), { force: true });
}

const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface LockClock {
  now: () => number;
  sleep: (ms: number) => void;
  /** Test hook: called right before the lock is released. */
  onUnlock?: () => void;
}
const realClock: LockClock = { now: Date.now, sleep: sleepSync };

function withLock<T>(
  dir: string,
  fn: () => T,
  clock: LockClock = realClock,
): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const deadline = clock.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (clock.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished: retry
      }
      // Never block a run on the ledger: proceed unlocked after 5 s.
      if (clock.now() > deadline) return fn();
      clock.sleep(5);
    }
  }
  try {
    return fn();
  } finally {
    clock.onUnlock?.();
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Known and deliberate: `freeBytes` (MemAvailable) already excludes memory a
 * live run is using, and that run's full reservation is subtracted from it
 * again, so a later run is sized conservatively (counted twice). The floor
 * stays 1 worker, and a reservation never exceeds the memory its run was
 * sized from.
 *
 * Reserve first, then read: under the lock, read what other live runs hold,
 * size the run from `freeBytes` minus that, and write this run's entry before
 * releasing the lock, so the next run to start sees it.
 */
export function reserveWorkers(opts: {
  dir?: string;
  freeBytes: number;
  parallelism: number;
  env?: NodeJS.ProcessEnv;
  alive?: (pid: number) => boolean;
  pid?: number;
  /** Pids whose entries are not counted: the runs this one was spawned by. */
  ignorePids?: readonly number[];
  /** Final worker count given what others hold; defaults to the memory clamp. */
  decide?: (reservedByOthers: number) => number;
  clock?: LockClock;
}): { workers: number; reservedByOthers: number } {
  const dir = opts.dir ?? defaultLedgerDir();
  const pid = opts.pid ?? process.pid;
  return withLock(
    dir,
    () => {
      const { total: reservedByOthers, dead } = readLedger(
        dir,
        opts.alive ?? pidAlive,
        pid,
        opts.ignorePids,
      );
      // A dead run's file would count again once the OS reuses its pid.
      for (const name of dead) rmSync(join(dir, name), { force: true });
      const workers = opts.decide
        ? opts.decide(reservedByOthers)
        : workerCap(opts.freeBytes - reservedByOthers, opts.parallelism);
      // Never claim more than the memory this run was sized from.
      const entry: LedgerEntry = {
        pid,
        bytes: Math.min(
          reservationBytes(workers, opts.env),
          Math.max(0, opts.freeBytes - reservedByOthers),
        ),
      };
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify(entry));
      return { workers, reservedByOthers };
    },
    opts.clock,
  );
}

// Kept on the process, not the module: vite re-bundles the config (and this
// file) on every watch-mode reload, which would reset a module-level set.
const REGISTERED_KEY = Symbol.for("mx.vitest-ledger.release");
function registeredDirs(): Set<string> {
  const g = globalThis as { [REGISTERED_KEY]?: Set<string> };
  g[REGISTERED_KEY] ??= new Set<string>();
  return g[REGISTERED_KEY];
}

// Deliberately not MX_*/VITEST*: the test:affected cache hashes those env
// names into its namespace key, and this value is a pid that differs per run.
const ANCESTORS_ENV = "MXLEDGER_ANCESTOR_RUNS";

/** Pids of the vitest runs this process descends from (set by `markRunPid`). */
export function ancestorRunPids(
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  return (env[ANCESTORS_ENV] ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Record this run in the environment, so a vitest started by a test of this
 * run (inherited env) does not count this run's reservation against itself.
 */
export function markRunPid(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): void {
  const pids = ancestorRunPids(env);
  if (pids.includes(pid)) return; // a watch-mode config reload runs this again
  env[ANCESTORS_ENV] = [...pids, pid].join(",");
}

/** Release this run's entry on exit, and on SIGINT/SIGTERM (then re-raise). */
export function releaseOnExit(dir: string = defaultLedgerDir()): void {
  // A config re-evaluated in the same process (watch reload) registers once.
  const registered = registeredDirs();
  if (registered.has(dir)) return;
  registered.add(dir);
  process.on("exit", () => releaseReservation(dir));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      releaseReservation(dir);
      process.removeListener(sig, handler);
      // Keep the default (terminate) when nothing else handles the signal.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

export interface ResolvedWorkers {
  workers: number;
  /** "cli" when --maxWorkers won, "override" when VITEST_MAX_WORKERS decided, "cap" when the memory clamp did. */
  reason: "cli" | "override" | "cap";
  /** The free-memory figure the decision was based on (always reported, even when overridden). */
  freeBytes: number;
  /** Bytes other live runs on this host hold in the ledger (0 when none). */
  reservedBytes?: number;
  /** The --maxWorkers token as written ("3", "75%"), when reason is "cli". */
  cliRaw?: string;
}

/**
 * The `--maxWorkers`/`--max-workers` value in argv ("N", "=N", "N%"), or
 * undefined. A percentage has no count until vitest resolves it against the
 * cores, so it is kept as written (`raw`) with `value` unset.
 */
export interface CliWorkers {
  value?: number;
  raw: string;
}

export function cliMaxWorkers(argv: readonly string[]): CliWorkers | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--maxWorkers=(.+)$/.exec(a) ?? /^--max-workers=(.+)$/.exec(a);
    const token = m ? m[1] : undefined;
    if (!token && a !== "--maxWorkers" && a !== "--max-workers") continue;
    const v = token ?? argv[i + 1];
    if (v === undefined || !/^\d+%?$/.test(v)) return undefined;
    return v.endsWith("%") ? { raw: v } : { value: Number(v), raw: v };
  }
  return undefined;
}

export function resolveWorkers(
  env: NodeJS.ProcessEnv = process.env,
  freeBytes: number = memAvailableBytes(),
  parallelism: number = os.availableParallelism(),
  argv: readonly string[] = process.argv,
  reservedBytes = 0,
): ResolvedWorkers {
  // A --maxWorkers on the CLI overrides this config value at the vitest CLI
  // layer, above the config; report it, not the cap it defeated.
  const cli = cliMaxWorkers(argv);
  if (cli) {
    // For a percentage only vitest can resolve the count; report the token as
    // written and keep the memory cap as the config value (the CLI value wins
    // inside vitest either way).
    return {
      workers: cli.value ?? workerCap(freeBytes - reservedBytes, parallelism),
      reason: "cli",
      freeBytes,
      reservedBytes,
      cliRaw: cli.raw,
    };
  }
  const override = Number(env.VITEST_MAX_WORKERS);
  if (
    env.VITEST_MAX_WORKERS !== undefined &&
    Number.isFinite(override) &&
    override >= 1
  ) {
    return {
      workers: Math.floor(override),
      reason: "override",
      freeBytes,
      reservedBytes,
    };
  }
  return {
    workers: workerCap(freeBytes - reservedBytes, parallelism),
    reason: "cap",
    freeBytes,
    reservedBytes,
  };
}

/**
 * The worker count a run reserves for: what vitest will use. A percentage
 * `--maxWorkers` resolves against the cores (ceil), as vitest does.
 */
export function reservedWorkerCount(
  r: ResolvedWorkers,
  parallelism: number,
): number {
  if (r.cliRaw?.endsWith("%"))
    return Math.max(
      1,
      Math.ceil((Number.parseInt(r.cliRaw, 10) / 100) * parallelism),
    );
  return r.workers;
}

/** The one startup line: `vitest workers: 6 (8.2 GiB free)`. */
export function workersLogLine(r: ResolvedWorkers): string {
  const gb = (r.freeBytes / GIB).toFixed(1);
  const others = r.reservedBytes
    ? `, ${(r.reservedBytes / GIB).toFixed(1)} GiB reserved by other runs`
    : "";
  const why =
    r.reason === "cli"
      ? `, --maxWorkers ${r.cliRaw ?? String(r.workers)} wins over the cap`
      : r.reason === "override"
        ? ", VITEST_MAX_WORKERS override"
        : "";
  const count = r.cliRaw?.endsWith("%")
    ? `${r.cliRaw} of cores`
    : String(r.workers);
  return `vitest workers: ${count} (${gb} GiB free${others}${why})`;
}
