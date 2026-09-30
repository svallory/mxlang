/**
 * The host side of the checker worker: one forked process per project, a
 * request queue in front of it, and the rules that keep a slow check from
 * either blocking the editor or delivering an out-of-date answer.
 *
 * - **Supersede.** A newer `check` of the same file makes every older one for
 *   that file moot: its promise resolves `superseded` and its records are
 *   never delivered, even if the worker computes them.
 * - **Kill and restart.** The worker's `check` is synchronous and its
 *   cancellation token only acts between compiler phases, so a stale run
 *   cannot be interrupted. If one is still running `graceMs` after it became
 *   stale, the worker is killed and a fresh one started for the queue. The
 *   default grace (5 s) is a little over a typical cold check (the spike
 *   measured 0.6-8 s under load): a stale run that is merely finishing is
 *   allowed to, and its warm program is kept; only a run that has clearly
 *   overstayed is worth a cold restart.
 * - **No orphans.** The worker ends itself when this process's IPC channel
 *   closes (see `worker.ts`); `dispose` ends it explicitly.
 */

import { type ChildProcess, fork } from "node:child_process";
import type { Diagnostic } from "./types.ts";
import type {
  InitErrorKind,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.ts";

/** What became of a request. */
export type CheckOutcome =
  | { kind: "ok"; diagnostics: Diagnostic[] }
  /** A newer request made this one moot; nothing is delivered. */
  | { kind: "superseded" }
  /**
   * The project cannot be checked at all (no usable compiler-cli, an invalid
   * tsconfig, a worker that cannot start). Sticky: every later request gets
   * the same answer without another process, so a caller can show the
   * message once.
   */
  | { kind: "unavailable"; reason: InitErrorKind | "worker"; message: string }
  /** This one request failed (the worker threw, or died mid-run). */
  | { kind: "failed"; message: string };

export interface CheckerWorkerOptions {
  projectDir: string;
  tsconfigPath?: string;
  /** Absolute path to the worker entry (`worker-main` / the plugin's bundle). */
  workerPath: string;
  /** How long a stale run may keep the worker busy before it is killed. */
  graceMs?: number;
}

export interface CheckerWorker {
  /** Check `code` as `virtualPath`. Never rejects except after `dispose`. */
  check(virtualPath: string, code: string): Promise<CheckOutcome>;
  /** The project's compiler option diagnostics; ask once per project. */
  configDiagnostics(): Promise<CheckOutcome>;
  /** The live worker's pid, or `undefined` before the first request. */
  pid(): number | undefined;
  /** End the worker. Later requests reject. */
  dispose(): void;
}

export const DEFAULT_GRACE_MS = 5_000;

interface Pending {
  requestId: number;
  kind: "check" | "config";
  virtualPath: string;
  code: string;
  superseded: boolean;
  resolve(outcome: CheckOutcome): void;
}

/** Whether `pid` names a running process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: exists but not ours. Anything else (ESRCH): gone.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createCheckerWorker(
  options: CheckerWorkerOptions,
): CheckerWorker {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  let child: ChildProcess | undefined;
  let ready = false;
  let disposed = false;
  let unavailable: Extract<CheckOutcome, { kind: "unavailable" }> | undefined;
  let nextId = 0;
  let inflight: Pending | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Pending[] = [];

  function settle(p: Pending, outcome: CheckOutcome): void {
    p.resolve(p.superseded ? { kind: "superseded" } : outcome);
  }

  function clearGrace(): void {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    graceTimer = undefined;
  }

  function failAll(outcome: CheckOutcome): void {
    clearGrace();
    if (inflight) settle(inflight, outcome);
    inflight = undefined;
    for (const p of queue.splice(0)) settle(p, outcome);
  }

  function killChild(): void {
    const dying = child;
    child = undefined;
    ready = false;
    if (dying) {
      dying.removeAllListeners("exit");
      dying.removeAllListeners("message");
      // Late 'error' events (a send racing the kill) must not go uncaught.
      dying.on("error", () => {});
      // A worker in a synchronous run cannot read a `dispose` message.
      dying.kill("SIGKILL");
    }
  }

  function spawn(): void {
    const proc = fork(options.workerPath, [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
    });
    child = proc;
    proc.stderr?.on("data", (chunk) => {
      stderrTails.set(
        proc,
        ((stderrTails.get(proc) ?? "") + String(chunk)).slice(-2_000),
      );
    });
    proc.on("message", (message: WorkerResponse) => onMessage(message));
    // A failed spawn or a send on a closed channel arrives as 'error', not a
    // throw; unhandled, it would crash the host (tsserver). Treat it as the
    // worker being gone.
    proc.on("error", (error) => gone(proc, `failed (${error.message})`));
    proc.on("exit", (code, signal) =>
      gone(proc, `exited (${signal ?? `code ${code}`})`),
    );
    send(proc, {
      type: "init",
      projectDir: options.projectDir,
      ...(options.tsconfigPath ? { tsconfigPath: options.tsconfigPath } : {}),
    });
  }

  function gone(proc: ChildProcess, what: string): void {
    if (child !== proc) return;
    {
      child = undefined;
      proc.removeAllListeners("message");
      proc.kill("SIGKILL");
      const wasReady = ready;
      ready = false;
      const reason = `the Angular checker worker ${what}`;
      const stderrTail = stderrTails.get(proc) ?? "";
      if (!wasReady) {
        // Died before it could answer `init`: restarting would loop.
        unavailable = {
          kind: "unavailable",
          reason: "worker",
          message: stderrTail.trim()
            ? `${reason}: ${stderrTail.trim().split("\n").pop()}`
            : reason,
        };
        failAll(unavailable);
        return;
      }
      if (inflight) {
        settle(inflight, { kind: "failed", message: reason });
        inflight = undefined;
        clearGrace();
      }
      pump();
    }
  }

  const stderrTails = new WeakMap<ChildProcess, string>();

  function send(target: ChildProcess, message: WorkerRequest): void {
    // Callback form: a closed channel reports through the callback instead of
    // an uncaught 'error' event.
    if (!target.connected) {
      gone(target, "is not connected");
      return;
    }
    target.send(message, (error) => {
      if (error) gone(target, `failed (${error.message})`);
    });
  }

  function onMessage(message: WorkerResponse): void {
    switch (message.type) {
      case "ready":
        ready = true;
        pump();
        return;
      case "init-error":
        unavailable = {
          kind: "unavailable",
          reason: message.kind,
          message: message.message,
        };
        killChild();
        failAll(unavailable);
        return;
      case "result":
      case "error": {
        if (!inflight || inflight.requestId !== message.requestId) return;
        const done = inflight;
        inflight = undefined;
        clearGrace();
        settle(
          done,
          message.type === "result"
            ? { kind: "ok", diagnostics: message.diagnostics }
            : { kind: "failed", message: message.message },
        );
        pump();
      }
    }
  }

  function pump(): void {
    if (disposed) return;
    if (unavailable) {
      failAll(unavailable);
      return;
    }
    if (queue.length === 0) return;
    if (!child) spawn();
    if (!ready || inflight) return;
    const next = queue.shift() as Pending;
    inflight = next;
    send(
      child as ChildProcess,
      next.kind === "check"
        ? {
            type: "check",
            requestId: next.requestId,
            virtualPath: next.virtualPath,
            code: next.code,
          }
        : { type: "configDiagnostics", requestId: next.requestId },
    );
  }

  /** The in-flight run went stale: give it `graceMs`, then restart. */
  function armGrace(stale: Pending): void {
    clearGrace();
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (inflight !== stale) return;
      inflight = undefined;
      killChild();
      settle(stale, { kind: "superseded" });
      pump();
    }, graceMs);
  }

  function enqueue(kind: Pending["kind"], virtualPath: string, code: string) {
    if (disposed) {
      return Promise.reject(new Error("this checker worker has been disposed"));
    }
    nextId += 1;
    return new Promise<CheckOutcome>((resolve) => {
      const request: Pending = {
        requestId: nextId,
        kind,
        virtualPath,
        code,
        superseded: false,
        resolve,
      };
      if (kind === "check") {
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          const old = queue[i] as Pending;
          if (old.kind === "check" && old.virtualPath === virtualPath) {
            queue.splice(i, 1);
            old.resolve({ kind: "superseded" });
          }
        }
        if (
          inflight?.kind === "check" &&
          inflight.virtualPath === virtualPath &&
          !inflight.superseded
        ) {
          inflight.superseded = true;
          armGrace(inflight);
        }
      }
      queue.push(request);
      pump();
    });
  }

  return {
    check: (virtualPath, code) => enqueue("check", virtualPath, code),
    configDiagnostics: () => enqueue("config", "", ""),
    pid: () => child?.pid,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearGrace();
      const live = child;
      if (live) {
        try {
          live.send({ type: "dispose" } satisfies WorkerRequest, () => {});
        } catch {
          // Channel already closed: the worker is going anyway.
        }
      }
      killChild();
      failAll({ kind: "superseded" });
    },
  };
}
