import { existsSync } from "node:fs";
import { join } from "node:path";
import { runMxTscArgs } from "./index.ts";

export interface InProcessRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Test helper: `mx-tsc` run in this process through its exported entry
 * (`runMxTscArgs`) with `process.stdout`/`process.stderr` captured. No node
 * start-up, no second copy of TypeScript and Angular's compiler in memory, and
 * no child process competing with the other test workers for the CPU (a worker
 * blocked in a synchronous spawn is what made CI's `[vitest-worker]: Timeout
 * calling "onTaskUpdate"` fire).
 *
 * Synchronous and process-global (`process.argv`, the stream writes), so runs
 * never overlap. Nothing changes directory: `cwd` only resolves `.` and
 * relative project arguments that exist under it. Each run re-evaluates
 * TypeScript's own `tsc.js`, so no compiler state is shared between runs. The
 * real binary (exit code, bin path) is covered by cases that spawn it.
 */
export function runInProcess(
  args: readonly string[],
  cwd?: string,
): InProcessRun {
  const mapped = cwd
    ? args.map((arg) =>
        arg === "."
          ? cwd
          : !arg.startsWith("-") && existsSync(join(cwd, arg))
            ? join(cwd, arg)
            : arg,
      )
    : [...args];
  let stdout = "";
  let stderr = "";
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let status: number;
  try {
    status = runMxTscArgs(mapped);
  } catch (cause) {
    status = 1;
    stderr +=
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
  return { status, stdout, stderr };
}
