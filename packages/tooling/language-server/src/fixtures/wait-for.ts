/**
 * Waiting helpers for the stdio end-to-end tests. A test drives a real server
 * process, so it can only learn that something happened by watching what
 * arrives; these helpers poll for it and, when it does not, fail naming what
 * the test was waiting for, not three assertions later.
 *
 * Test support only: nothing here is used by the server.
 */

/** How long a wait gives the server before it fails (the old loops' 15 s). */
export const DEFAULT_WAIT_MS = 15_000;
/** How often a wait looks. */
export const POLL_MS = 50;

export interface WaitOptions {
  /** Fail after this long. Default 15 s. */
  timeoutMs?: number;
  /** Look this often. Default 50 ms. */
  pollMs?: number;
  /**
   * What the test can see right now, for the failure message: a timeout then
   * says what was there instead of what was expected. Must be JSON-printable
   * (turn a `Map` into an object first).
   */
  observed?: () => unknown;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Resolves once `done()` is true. Rejects with
 * `timed out after <ms> ms waiting for <what>` (and `; last observed: <value>`
 * when the caller supplies `observed`) when it never becomes true.
 */
export async function waitFor(
  done: () => boolean,
  what: string,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) {
      const seen = options.observed
        ? `; last observed: ${show(options.observed())}`
        : "";
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${what}${seen}`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Resolves with the first value `read()` returns that is not `undefined`.
 * Fails like `waitFor`.
 */
export async function waitForValue<T>(
  read: () => T | undefined,
  what: string,
  options: WaitOptions = {},
): Promise<T> {
  let found: T | undefined;
  await waitFor(
    () => {
      found = read();
      return found !== undefined;
    },
    what,
    options,
  );
  return found as T;
}

export interface QuietOptions {
  /** How long nothing may arrive. Default 500 ms. */
  windowMs?: number;
  /** Look this often. Default 25 ms. */
  pollMs?: number;
}

/**
 * Waits `windowMs` and asserts that nothing arrived in it. `arrivals` returns
 * the log of the events that must not happen (already filtered to the
 * offending ones, and only ever growing); what is in it when the window opens
 * is ignored. Rejects as soon as something is added, with
 * `expected no <what> within <ms> ms, but N arrived: <events>`.
 */
export async function expectQuiet(
  arrivals: () => readonly unknown[],
  what: string,
  options: QuietOptions = {},
): Promise<void> {
  const windowMs = options.windowMs ?? 500;
  const pollMs = options.pollMs ?? 25;
  const before = arrivals().length;
  const check = () => {
    const late = arrivals().slice(before);
    if (late.length > 0) {
      throw new Error(
        `expected no ${what} within ${windowMs} ms, but ${late.length} arrived: ${show(late)}`,
      );
    }
  };
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    await sleep(Math.min(pollMs, Math.max(end - Date.now(), 1)));
    check();
  }
  check();
}
