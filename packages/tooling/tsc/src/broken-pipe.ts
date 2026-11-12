/** The part of a writable stream the guard touches. */
interface GuardedStream {
  write: (...args: never[]) => boolean;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

const guarded = new WeakSet<object>();

const isBrokenPipe = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "EPIPE";

/**
 * Lets the reader of a stream (`process.stdout`) close early, as in
 * `mx-tsc --help | head -1`, without crashing the process: from the first
 * `EPIPE` on, every write is dropped. Plain `tsc` gets this for free, because
 * it writes and calls `process.exit` before the closed pipe is reported;
 * `mx-tsc` catches that exit and goes on writing (its own counts, the dry-run
 * report, the Angular pass), so the report reaches it. Node reports the closed
 * pipe as an `error` event a tick after the write, uncaught with no listener;
 * Bun throws it from the write itself. Any other error is left as it was
 * (thrown again).
 *
 * Installed once per stream, for the life of the process, by the CLI entry
 * (`bin.ts`) only, so an in-process caller of `runMxTsc` keeps its own
 * stdout's `EPIPE` behaviour. Later interceptors wrap this one, so a write
 * made after they stop is still guarded.
 *
 * A dropped write reports success (`true`, nothing to wait a `drain` for) and
 * hands the `EPIPE` to a trailing callback, on a microtask, as a failed write
 * would.
 */
export function guardBrokenPipe(stream: GuardedStream): void {
  if (guarded.has(stream)) return;
  guarded.add(stream);
  const original = stream.write as (...args: unknown[]) => boolean;
  let closed: unknown;
  stream.on("error", (error) => {
    if (!isBrokenPipe(error)) throw error;
    closed ??= error;
  });
  const drop = (args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      queueMicrotask(() => callback(closed));
    }
    return true;
  };
  stream.write = ((...args: unknown[]) => {
    if (closed !== undefined) return drop(args);
    try {
      return original.apply(stream, args);
    } catch (error) {
      if (!isBrokenPipe(error)) throw error;
      closed = error;
      return drop(args);
    }
  }) as GuardedStream["write"];
}
