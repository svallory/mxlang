import { setImmediate as realSetImmediate } from "node:timers";
import { afterEach } from "vitest";

/**
 * Lets the event loop run between tests, like `scripts/vitest-yield.ts`, but
 * on `setImmediate` taken from `node:timers`: the watch-* files install fake
 * timers (`vi.useFakeTimers`), which replace the global `setTimeout` and
 * `setImmediate`, so the shared hook's `setTimeout` hop never fires there and
 * its afterEach fails. The module import is not patched by fake timers.
 *
 * Without a hop, a file's synchronous `runInProcess` tests (about 0.6 s each)
 * hold the worker's event loop for the whole file.
 */
afterEach(() => new Promise<void>((resolve) => realSetImmediate(resolve)));
