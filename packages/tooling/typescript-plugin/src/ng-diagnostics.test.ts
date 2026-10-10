import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CheckerWorker,
  CheckOutcome,
  Diagnostic,
} from "@mxlang/angular-checker";
import { compileNgMx } from "@mxlang/host-angular";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledNgMx } from "./language.ts";
import { createNgDiagnosticsService } from "./ng-diagnostics.ts";

const SOURCE = [
  'import { Component } from "@angular/core";',
  "@Component({",
  '  selector: "app-x",',
  "  standalone: true,",
  "  template: <p>${user.nmae}</p>,",
  "})",
  "export class XComponent { user = { name: 'a' }; }",
].join("\n");

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mx-ngdiag-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

/** A project dir with a package.json carrying `mx.angular.diagnostics`. */
function project(name: string, diagnostics?: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(diagnostics ? { mx: { angular: { diagnostics } } } : {}),
  );
  return dir;
}

function entry(dir: string, name: string, source = SOURCE): CompiledNgMx {
  const fileName = path.join(dir, `${name}.component.ng.mx`);
  return { fileName, source, result: compileNgMx(source, fileName) };
}

interface FakeWorker extends CheckerWorker {
  checks: Array<{
    path: string;
    code: string;
    resolve(o: CheckOutcome): void;
  }>;
  configCalls: number;
  disposed: boolean;
}

function fakes(opts: { config?: Diagnostic[]; open?: Set<string> } = {}) {
  const workers = new Map<string, FakeWorker>();
  const watchers = new Map<string, () => void>();
  const refresh = vi.fn();
  const createWorker = vi.fn((o: { projectDir: string }) => {
    const w: FakeWorker = {
      checks: [],
      configCalls: 0,
      disposed: false,
      check(p, code) {
        return new Promise<CheckOutcome>((resolve) => {
          w.checks.push({ path: p, code, resolve });
        });
      },
      async configDiagnostics() {
        w.configCalls += 1;
        return { kind: "ok", diagnostics: opts.config ?? [] };
      },
      pid: () => 1,
      dispose() {
        w.disposed = true;
      },
    };
    workers.set(o.projectDir, w);
    return w;
  });
  const watchFile = vi.fn((file: string, cb: () => void) => {
    watchers.set(file, cb);
    return { close: () => watchers.delete(file) };
  });
  const service = createNgDiagnosticsService({
    workerPath: "/x/ng-worker.cjs",
    ...(opts.open ? { isOpen: (f: string) => opts.open?.has(f) === true } : {}),
    createWorker,
    watchFile,
    refresh,
  });
  return { service, workers, watchers, refresh, createWorker, watchFile };
}

const ngtscRecord = (
  e: CompiledNgMx,
  over: Partial<Diagnostic> = {},
): Diagnostic => ({
  file: `${e.fileName}.ts`,
  start: e.result.code.indexOf("user.nmae"),
  length: 4,
  code: 2339,
  message: "Property 'nmae' does not exist",
  category: "error",
  source: "ngtsc",
  ...over,
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("scheduling", () => {
  it('"idle" (default) runs once, 1 s after the last edit', async () => {
    vi.useFakeTimers();
    const dir = project("idle");
    const { service, workers } = fakes();
    const e = entry(dir, "a");
    service.notifyCompiled(e);
    await vi.advanceTimersByTimeAsync(900);
    service.notifyCompiled({ ...e }); // another edit: the clock restarts
    await vi.advanceTimersByTimeAsync(900);
    expect(workers.get(dir)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(workers.get(dir)?.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(workers.get(dir)?.checks).toHaveLength(1);
  });

  it("never runs per keystroke", async () => {
    vi.useFakeTimers();
    const dir = project("keys");
    const { service, workers } = fakes();
    for (let i = 0; i < 20; i += 1) {
      service.notifyCompiled(entry(dir, "a"));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(workers.get(dir)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers.get(dir)?.checks).toHaveLength(1);
  });

  it('"save" runs only when the file is saved', async () => {
    vi.useFakeTimers();
    const dir = project("save", "save");
    const { service, workers, watchers } = fakes();
    const e = entry(dir, "a");
    service.notifyCompiled(e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workers.get(dir)).toBeUndefined();
    watchers.get(e.fileName)?.();
    await flush();
    expect(workers.get(dir)?.checks).toHaveLength(1);
  });

  it('"off" never runs, never starts a worker, never watches', async () => {
    vi.useFakeTimers();
    const dir = project("off", "off");
    const { service, workers, createWorker, watchFile } = fakes();
    service.notifyCompiled(entry(dir, "a"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createWorker).not.toHaveBeenCalled();
    expect(workers.size).toBe(0);
    expect(watchFile).not.toHaveBeenCalled();
  });
});

describe("workers", () => {
  it("two files in one project share one worker", async () => {
    vi.useFakeTimers();
    const dir = project("shared");
    const { service, createWorker } = fakes();
    service.notifyCompiled(entry(dir, "a"));
    service.notifyCompiled(entry(dir, "b"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("different projects get different workers", async () => {
    vi.useFakeTimers();
    const p1 = project("p1");
    const p2 = project("p2");
    const { service, createWorker } = fakes();
    service.notifyCompiled(entry(p1, "a"));
    service.notifyCompiled(entry(p2, "a"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it("dispose ends every worker and cancels pending timers", async () => {
    vi.useFakeTimers();
    const dir = project("disp");
    const { service, workers } = fakes();
    service.notifyCompiled(entry(dir, "a"));
    await vi.advanceTimersByTimeAsync(1_000);
    service.notifyCompiled(entry(dir, "a"));
    service.dispose();
    expect(workers.get(dir)?.disposed).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(workers.get(dir)?.checks).toHaveLength(1);
  });
});

describe("delivery", () => {
  it("delivers mapped angular diagnostics for the current source and refreshes", async () => {
    vi.useFakeTimers();
    const dir = project("deliver");
    const { service, workers, refresh } = fakes();
    const e = entry(dir, "a");
    service.notifyCompiled(e);
    await vi.advanceTimersByTimeAsync(1_000);
    workers.get(dir)?.checks[0]?.resolve({
      kind: "ok",
      diagnostics: [ngtscRecord(e), ngtscRecord(e, { source: "ts" })],
    });
    await flush();
    const got = service.getDiagnostics(e.fileName);
    expect(got?.source).toBe(SOURCE);
    expect(got?.diagnostics).toHaveLength(1);
    expect(got?.diagnostics[0]).toMatchObject({
      source: "angular",
      code: 2339,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("drops a result computed for a superseded source", async () => {
    vi.useFakeTimers();
    const dir = project("stale");
    const { service, workers, refresh } = fakes();
    const old = entry(dir, "a");
    service.notifyCompiled(old);
    await vi.advanceTimersByTimeAsync(1_000);
    service.notifyCompiled(entry(dir, "a", `${SOURCE}\n// edit`)); // newer edit
    workers
      .get(dir)
      ?.checks[0]?.resolve({ kind: "ok", diagnostics: [ngtscRecord(old)] });
    await flush();
    expect(service.getDiagnostics(old.fileName)).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows nothing for a file whose text changed since the last result", async () => {
    vi.useFakeTimers();
    const dir = project("changed");
    const { service, workers } = fakes();
    const e = entry(dir, "a");
    service.notifyCompiled(e);
    await vi.advanceTimersByTimeAsync(1_000);
    workers
      .get(dir)
      ?.checks[0]?.resolve({ kind: "ok", diagnostics: [ngtscRecord(e)] });
    await flush();
    service.notifyCompiled(entry(dir, "a", `${SOURCE}\n// edit`));
    expect(service.getDiagnostics(e.fileName)).toBeUndefined();
  });
});

describe("project notices", () => {
  it("computes a missing compiler-cli notice once and shows it on every open file", async () => {
    vi.useFakeTimers();
    const dir = project("nocli");
    const { service, workers, refresh, createWorker } = fakes();
    const a = entry(dir, "a");
    const b = entry(dir, "b");
    service.notifyCompiled(a);
    service.notifyCompiled(b);
    await vi.advanceTimersByTimeAsync(1_000);
    for (const c of workers.get(dir)?.checks ?? []) {
      c.resolve({
        kind: "unavailable",
        reason: "compiler-cli",
        message: "install compiler-cli",
      });
    }
    await flush();
    expect(createWorker).toHaveBeenCalledTimes(1);
    for (const f of [a, b]) {
      const notices = service.getNotices(f.fileName);
      expect(notices).toHaveLength(1); // deduplicated per file
      expect(notices[0]?.message).toContain("install compiler-cli");
      // Names where the project is configured, and how to recover.
      expect(notices[0]?.message).toContain(path.join(dir, "package.json"));
      expect(notices[0]?.message).toContain("Restart TS Server");
    }
    expect(refresh).toHaveBeenCalled();
    // Later edits do not repeat or re-compute it.
    service.notifyCompiled(entry(dir, "a"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getNotices(a.fileName)).toHaveLength(1);
  });

  it("shows configDiagnostics once per project: ngtsc kept, ts dropped, warnings stay warnings", async () => {
    vi.useFakeTimers();
    const dir = project("cfg");
    const cfg = path.join(dir, "tsconfig.json");
    const base = {
      file: cfg,
      start: 0,
      length: 0,
      code: 1,
      message: "",
      source: "ngtsc",
    };
    const { service, workers } = fakes({
      config: [
        { ...base, message: "bad option", category: "error" },
        { ...base, message: "soft option", category: "warning" },
        { ...base, message: "ts thing", category: "error", source: "ts" },
      ],
    });
    const a = entry(dir, "a");
    const b = entry(dir, "b");
    service.notifyCompiled(a);
    service.notifyCompiled(b);
    await vi.advanceTimersByTimeAsync(1_000);
    for (const c of workers.get(dir)?.checks ?? [])
      c.resolve({ kind: "ok", diagnostics: [] });
    await flush();
    expect(workers.get(dir)?.configCalls).toBe(1);
    for (const f of [a, b]) {
      const notices = service.getNotices(f.fileName);
      expect(notices.map((n) => [n.category, n.message])).toEqual([
        ["error", expect.stringContaining("bad option")],
        ["warning", expect.stringContaining("soft option")],
      ]);
      expect(notices[0]?.message).toContain("tsconfig.json");
    }
  });
});

describe("open files only", () => {
  it("never checks a closed file, and the notice lands on the open one", async () => {
    vi.useFakeTimers();
    const dir = project("closed-first");
    const closed = entry(dir, "closed");
    const open = entry(dir, "open");
    const { service, workers } = fakes({ open: new Set([open.fileName]) });
    service.notifyCompiled(closed); // compiled first, never open
    service.notifyCompiled(open);
    await vi.advanceTimersByTimeAsync(1_000);
    const checks = workers.get(dir)?.checks ?? [];
    expect(checks.map((c) => c.path)).toEqual([`${open.fileName}.ts`]);
    checks[0]?.resolve({
      kind: "unavailable",
      reason: "compiler-cli",
      message: "install compiler-cli",
    });
    await flush();
    expect(service.getNotices(open.fileName)).toHaveLength(1);
    expect(service.getNotices(closed.fileName)).toEqual([]);
  });

  it("keeps the notice on B after A (the file that raised it) closes", async () => {
    vi.useFakeTimers();
    const dir = project("owner-close");
    const a = entry(dir, "a");
    const b = entry(dir, "b");
    const open = new Set([a.fileName, b.fileName]);
    const { service, workers } = fakes({ open });
    service.notifyCompiled(a);
    await vi.advanceTimersByTimeAsync(1_000);
    workers.get(dir)?.checks[0]?.resolve({
      kind: "unavailable",
      reason: "compiler-cli",
      message: "install compiler-cli",
    });
    await flush();
    open.delete(a.fileName);
    service.notifyCompiled(b);
    expect(service.getNotices(a.fileName)).toEqual([]);
    expect(service.getNotices(b.fileName)).toHaveLength(1);
  });

  it("save mode installs no watcher for a closed file, and drops it on close", async () => {
    vi.useFakeTimers();
    const dir = project("save-closed", "save");
    const closed = entry(dir, "closed");
    const open = entry(dir, "open");
    const openSet = new Set([open.fileName]);
    const { service, watchers, watchFile } = fakes({ open: openSet });
    service.notifyCompiled(closed);
    service.notifyCompiled(open);
    expect(watchFile).toHaveBeenCalledTimes(1);
    expect(watchers.has(closed.fileName)).toBe(false);
    openSet.delete(open.fileName);
    service.request(open.fileName); // the editor's next request sweeps it
    expect(watchers.has(open.fileName)).toBe(false);
  });

  it("drops a pending idle timer when the file closes", async () => {
    vi.useFakeTimers();
    const dir = project("timer-close");
    const a = entry(dir, "a");
    const openSet = new Set([a.fileName]);
    const { service, workers, createWorker } = fakes({ open: openSet });
    service.notifyCompiled(a);
    openSet.delete(a.fileName);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(createWorker).not.toHaveBeenCalled();
    expect(workers.size).toBe(0);
  });

  it("schedules a file that was compiled before it was opened, on the editor's first request", async () => {
    vi.useFakeTimers();
    const dir = project("late-open");
    const a = entry(dir, "a");
    const openSet = new Set<string>();
    const { service, workers } = fakes({ open: openSet });
    service.notifyCompiled(a); // compiled while closed: nothing scheduled
    await vi.advanceTimersByTimeAsync(2_000);
    expect(workers.size).toBe(0);
    openSet.add(a.fileName);
    service.request(a.fileName);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers.get(dir)?.checks).toHaveLength(1);
    // Asking again for the same text does not re-arm it.
    service.request(a.fileName);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers.get(dir)?.checks).toHaveLength(1);
  });
});
