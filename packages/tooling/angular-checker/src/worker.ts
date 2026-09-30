/**
 * The checker worker: owns one {@link AngularChecker} for one project and
 * answers {@link WorkerRequest}s over the IPC channel.
 *
 * It exists because `check()` is synchronous and takes seconds; run in the
 * tsserver thread it would freeze every editor feature. It is a forked
 * *process*, not a `worker_threads` thread: ngtsc keeps process-global state
 * (TypeScript's shared caches, `process.cwd`-relative resolution) that has not
 * been shown safe across threads, and a stuck run must be killable -- a thread
 * that spins in synchronous code cannot be terminated cooperatively, a
 * process can be `SIGKILL`ed.
 *
 * It never outlives its host: the IPC channel closing (the host exited, or was
 * killed) ends it, and so does the parent pid changing.
 */

import { createAngularChecker } from "./checker.ts";
import {
  CompilerCliUnavailableError,
  resolveCompilerCli,
} from "./compiler-cli.ts";
import type { AngularChecker } from "./types.ts";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.ts";

/** How often a busy-free worker checks that its parent is still alive. */
const PARENT_POLL_MS = 2_000;

/** The slice of `process` the worker uses, so a test can drive it. */
export interface WorkerProcess {
  send?: (message: WorkerResponse) => boolean;
  on(event: "message", listener: (message: WorkerRequest) => void): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  exit(code?: number): never;
  ppid: number;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Run the worker loop on `proc` (the real `process` by default). */
export function runCheckerWorker(proc: WorkerProcess = process as never): void {
  if (!proc.send) {
    throw new Error("the checker worker must be started with an IPC channel");
  }
  const send = (message: WorkerResponse): void => {
    proc.send?.(message);
  };
  let checker: AngularChecker | undefined;

  const parent = proc.ppid;
  const timer = setInterval(() => {
    if (proc.ppid !== parent) proc.exit(0);
  }, PARENT_POLL_MS);
  timer.unref();
  // The host closing the channel (including by dying) is the primary signal.
  proc.on("disconnect", () => proc.exit(0));

  proc.on("message", (message) => {
    switch (message.type) {
      case "init": {
        const resolution = resolveCompilerCli(message.projectDir);
        if (resolution.status !== "ok") {
          send({
            type: "init-error",
            kind: "compiler-cli",
            message: resolution.message,
          });
          return;
        }
        try {
          checker = createAngularChecker({
            projectDir: message.projectDir,
            ...(message.tsconfigPath
              ? { tsconfigPath: message.tsconfigPath }
              : {}),
          });
          send({ type: "ready" });
        } catch (cause) {
          send({
            type: "init-error",
            kind:
              cause instanceof CompilerCliUnavailableError
                ? "compiler-cli"
                : "config",
            message: messageOf(cause),
          });
        }
        return;
      }
      case "check": {
        try {
          if (!checker) throw new Error("check before init");
          send({
            type: "result",
            requestId: message.requestId,
            diagnostics: checker.check(message.virtualPath, message.code),
          });
        } catch (cause) {
          send({
            type: "error",
            requestId: message.requestId,
            message: messageOf(cause),
          });
        }
        return;
      }
      case "configDiagnostics": {
        try {
          if (!checker) throw new Error("configDiagnostics before init");
          send({
            type: "result",
            requestId: message.requestId,
            diagnostics: checker.configDiagnostics(),
          });
        } catch (cause) {
          send({
            type: "error",
            requestId: message.requestId,
            message: messageOf(cause),
          });
        }
        return;
      }
      case "dispose":
        checker?.dispose();
        proc.exit(0);
    }
  });
}
