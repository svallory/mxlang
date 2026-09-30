import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CheckerWorker,
  createCheckerWorker,
  isProcessAlive,
} from "./worker-client.ts";

const FAKE = path.resolve(
  import.meta.dirname,
  "../fixtures/worker/fake-worker.mjs",
);
const DIR = "/proj";

const live: CheckerWorker[] = [];
function make(over: { projectDir?: string; graceMs?: number } = {}) {
  const worker = createCheckerWorker({
    projectDir: over.projectDir ?? DIR,
    workerPath: FAKE,
    graceMs: over.graceMs ?? 5_000,
  });
  live.push(worker);
  return worker;
}
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
});

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("createCheckerWorker", () => {
  it("returns the worker's records for a check", async () => {
    const w = make();
    const out = await w.check("/proj/a.ts", "hello");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.diagnostics[0]?.message).toBe("hello");
  });

  it("starts the worker lazily and reuses one process for many files", async () => {
    const w = make();
    expect(w.pid()).toBeUndefined();
    await w.check("/proj/a.ts", "a");
    const pid = w.pid();
    expect(pid).toBeTypeOf("number");
    await w.check("/proj/b.ts", "b");
    await w.check("/proj/a.ts", "a2");
    expect(w.pid()).toBe(pid);
  });

  it("never delivers a superseded run's result", async () => {
    const w = make();
    const stale = w.check("/proj/a.ts", "SLOW:300");
    const fresh = w.check("/proj/a.ts", "fresh");
    expect((await stale).kind).toBe("superseded");
    const out = await fresh;
    expect(out.kind === "ok" && out.diagnostics[0]?.message).toBe("fresh");
  });

  it("supersedes a request that is still queued, not only the running one", async () => {
    const w = make();
    const running = w.check("/proj/b.ts", "SLOW:300");
    const queued = w.check("/proj/a.ts", "old");
    const newer = w.check("/proj/a.ts", "new");
    expect((await queued).kind).toBe("superseded");
    expect((await running).kind).toBe("ok");
    const out = await newer;
    expect(out.kind === "ok" && out.diagnostics[0]?.message).toBe("new");
  });

  it("does not supersede a check of a different file", async () => {
    const w = make();
    const a = w.check("/proj/a.ts", "SLOW:200");
    const b = w.check("/proj/b.ts", "b");
    expect((await a).kind).toBe("ok");
    expect((await b).kind).toBe("ok");
  });

  it("kills and restarts a worker still running a stale run past the grace period", async () => {
    const w = make({ graceMs: 200 });
    await w.check("/proj/warm.ts", "warm"); // worker ready: HANG goes in flight at once
    const firstPid = w.pid() as number;
    const stale = w.check("/proj/a.ts", "HANG");
    const fresh = w.check("/proj/a.ts", "after-restart");
    expect((await stale).kind).toBe("superseded");
    const out = await fresh;
    expect(out.kind === "ok" && out.diagnostics[0]?.message).toBe(
      "after-restart",
    );
    expect(w.pid()).not.toBe(firstPid);
    await waitFor(() => !isProcessAlive(firstPid));
  });

  it("survives a send to a worker that just died (no uncaught 'error')", async () => {
    const w = make();
    await w.check("/proj/warm.ts", "warm");
    process.kill(w.pid() as number, "SIGKILL");
    // Sent before the 'exit' event is processed: the channel is closing.
    const racing = await w.check("/proj/a.ts", "racing");
    expect(["ok", "failed"]).toContain(racing.kind);
    // The worker is replaced, not wedged.
    const after = await w.check("/proj/a.ts", "after");
    expect(after.kind).toBe("ok");
  });

  it("does not kill a stale run that finishes inside the grace period", async () => {
    const w = make({ graceMs: 3_000 });
    await w.check("/proj/warm.ts", "warm");
    const pid = w.pid();
    const stale = w.check("/proj/a.ts", "SLOW:200");
    const fresh = w.check("/proj/a.ts", "fresh");
    expect((await stale).kind).toBe("superseded");
    expect((await fresh).kind).toBe("ok");
    expect(w.pid()).toBe(pid);
  });

  it("reports an unavailable compiler-cli as a result, not a throw", async () => {
    const w = make({ projectDir: "/proj-no-cli" });
    const out = await w.check("/proj-no-cli/a.ts", "x");
    expect(out).toMatchObject({ kind: "unavailable", reason: "compiler-cli" });
    // Sticky: asking again answers the same without another process.
    const again = await w.check("/proj-no-cli/a.ts", "y");
    expect(again.kind).toBe("unavailable");
  });

  it("answers configDiagnostics", async () => {
    const w = make();
    const out = await w.configDiagnostics();
    expect(out).toEqual({ kind: "ok", diagnostics: [] });
  });

  it("dispose ends the worker and later checks fail loudly", async () => {
    const w = make();
    await w.check("/proj/a.ts", "a");
    const pid = w.pid() as number;
    w.dispose();
    await waitFor(() => !isProcessAlive(pid));
    await expect(w.check("/proj/a.ts", "b")).rejects.toThrow(/disposed/);
  });
});

describe("no orphans", () => {
  it("the worker exits when its host is SIGKILLed", async () => {
    // The host is a throwaway node process that forks the worker through the
    // real client, prints the worker pid, and is then killed with SIGKILL.
    const host = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { createCheckerWorker } from ${JSON.stringify(path.resolve(import.meta.dirname, "worker-client.ts"))};
        const w = createCheckerWorker({ projectDir: "/proj", workerPath: ${JSON.stringify(FAKE)}, graceMs: 5000 });
        await w.check("/proj/a.ts", "x");
        console.log("PID:" + w.pid());
        setInterval(() => {}, 1000);
        `,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let workerPid: number | undefined;
    try {
      workerPid = await new Promise<number>((resolve, reject) => {
        let buf = "";
        host.stdout.on("data", (d) => {
          buf += String(d);
          const m = /PID:(\d+)/.exec(buf);
          if (m) resolve(Number(m[1]));
        });
        host.on("exit", () => reject(new Error(`host exited early: ${buf}`)));
      });
      expect(isProcessAlive(workerPid)).toBe(true);
      host.kill("SIGKILL");
      await waitFor(() => !isProcessAlive(workerPid as number), 10_000);
    } finally {
      host.kill("SIGKILL");
      if (workerPid !== undefined && isProcessAlive(workerPid)) {
        process.kill(workerPid, "SIGKILL");
      }
    }
  });
});
