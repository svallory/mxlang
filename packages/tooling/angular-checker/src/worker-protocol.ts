/**
 * The IPC protocol between a host (the TypeScript plugin's client) and the
 * checker worker process. Every message is a plain JSON-safe object, so it
 * crosses `child_process.fork`'s IPC channel unchanged.
 */

import type { Diagnostic } from "./types.ts";

/** Host to worker. */
export type WorkerRequest =
  | { type: "init"; projectDir: string; tsconfigPath?: string }
  | { type: "check"; requestId: number; virtualPath: string; code: string }
  | { type: "configDiagnostics"; requestId: number }
  | { type: "dispose" };

/** Why a worker could not start checking. */
export type InitErrorKind = "compiler-cli" | "config";

/** Worker to host. */
export type WorkerResponse =
  | { type: "ready" }
  | { type: "init-error"; kind: InitErrorKind; message: string }
  | { type: "result"; requestId: number; diagnostics: Diagnostic[] }
  | { type: "error"; requestId: number; message: string };
