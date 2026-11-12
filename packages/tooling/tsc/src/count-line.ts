/**
 * The part of a writable stream the count-line interceptor touches: its
 * `write`, and its `error` event (where Node reports a closed pipe).
 */
export interface InterceptedStream {
  write: (...args: never[]) => boolean;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/** Streams whose reader went away: later writes are dropped, as tsc's are. */
const closedPipes = new WeakSet<object>();
/** Streams that already carry the `error` listener, so it is added once. */
const listening = new WeakSet<object>();

const isBrokenPipe = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "EPIPE";

/**
 * Lets a stream's reader close early (`mx-tsc --help | head -1`) without
 * crashing the process, as plain `tsc` does: tsc writes and calls
 * `process.exit` before the closed pipe is reported, while `mx-tsc` catches
 * that exit and goes on, so the report reaches it. Node reports the closed pipe
 * as an `error` event a tick after the write, and with no listener that event
 * is an uncaught exception; Bun throws it from the write itself. Both are
 * `EPIPE`; any other error is left as it was (thrown again).
 */
function ignoreBrokenPipe(stream: InterceptedStream): void {
  if (listening.has(stream)) return;
  listening.add(stream);
  // Stays on after the interceptor stops: Node's report arrives a tick after
  // the write, when the run that wrote it has usually returned.
  stream.on("error", (error) => {
    if (!isBrokenPipe(error)) throw error;
    closedPipes.add(stream);
  });
}

/**
 * Watches a stream (`process.stdout`) for tsc's own count line (`Found 1 error
 * in a.ts:1`, `Found 2 errors in 2 files.`), which tsc writes only under
 * `--pretty` and only when it has errors. Every write passes through untouched,
 * except after the stream's reader went away (`EPIPE`): then the write is
 * dropped and reported as not flushed (`false`) instead of throwing.
 */
export function watchForCountLine(stream: InterceptedStream = process.stdout): {
  seen(): boolean;
  stop(): void;
} {
  const original = stream.write;
  let seen = false;
  ignoreBrokenPipe(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (
      !seen &&
      typeof chunk === "string" &&
      /(?:^|\n)Found \d+ errors?\b/.test(chunk)
    ) {
      seen = true;
    }
    if (closedPipes.has(stream)) return false;
    try {
      return (original as (...args: unknown[]) => boolean).call(
        stream,
        chunk,
        ...rest,
      );
    } catch (error) {
      if (!isBrokenPipe(error)) throw error;
      closedPipes.add(stream);
      return false;
    }
  }) as InterceptedStream["write"];
  return {
    seen: () => seen,
    stop: () => {
      // Restored unconditionally: runs nest and stop in order.
      stream.write = original;
    },
  };
}
