import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectQuiet, waitFor, waitForValue } from "./wait-for.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Settles a promise into `{ ok }` or `{ error }` once timers have run. */
const settle = <T>(promise: Promise<T>) => {
  const outcome: { ok?: T; error?: Error; done: boolean } = { done: false };
  promise.then(
    (ok) => {
      outcome.ok = ok;
      outcome.done = true;
    },
    (error: Error) => {
      outcome.error = error;
      outcome.done = true;
    },
  );
  return outcome;
};

describe("waitFor", () => {
  it("resolves at once when the condition already holds", async () => {
    const outcome = settle(waitFor(() => true, "nothing"));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeUndefined();
  });

  it("resolves on the poll after the condition becomes true", async () => {
    let ready = false;
    const outcome = settle(waitFor(() => ready, "the flag"));
    await vi.advanceTimersByTimeAsync(120);
    expect(outcome.done).toBe(false);
    ready = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeUndefined();
  });

  it("throws, naming what it waited for and for how long, when it never holds", async () => {
    const outcome = settle(
      waitFor(() => false, "publishDiagnostics for a.mx", { timeoutMs: 1000 }),
    );
    await vi.advanceTimersByTimeAsync(1100);
    expect(outcome.error?.message).toBe(
      "timed out after 1000 ms waiting for publishDiagnostics for a.mx",
    );
  });

  it("defaults to the 15 s the old loops gave", async () => {
    const outcome = settle(waitFor(() => false, "x"));
    await vi.advanceTimersByTimeAsync(14_900);
    expect(outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome.error?.message).toBe(
      "timed out after 15000 ms waiting for x",
    );
  });

  it("adds the last observed value, read when it gives up", async () => {
    const seen: string[] = ["a.mx"];
    const outcome = settle(
      waitFor(() => seen.includes("b.mx"), "b.mx to be published", {
        timeoutMs: 200,
        observed: () => seen,
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    seen.push("pkg.json");
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome.error?.message).toBe(
      'timed out after 200 ms waiting for b.mx to be published; last observed: ["a.mx","pkg.json"]',
    );
  });

  it("prints an observed value JSON cannot hold", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const outcome = settle(
      waitFor(() => false, "x", { timeoutMs: 50, observed: () => circular }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.error?.message).toMatch(
      /^timed out after 50 ms waiting for x; last observed: /,
    );
  });

  it("prints an undefined observed value", async () => {
    const outcome = settle(
      waitFor(() => false, "x", { timeoutMs: 50, observed: () => undefined }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.error?.message).toBe(
      "timed out after 50 ms waiting for x; last observed: undefined",
    );
  });

  it("lets an error thrown by the condition through", async () => {
    const outcome = settle(
      waitFor(() => {
        throw new Error("boom");
      }, "x"),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.error?.message).toBe("boom");
  });
});

describe("waitForValue", () => {
  it("resolves with the first defined value, falsy ones included", async () => {
    let value: number[] | undefined;
    const outcome = settle(waitForValue(() => value, "the third publish"));
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.done).toBe(false);
    value = [];
    await vi.advanceTimersByTimeAsync(50);
    expect(outcome.ok).toEqual([]);
  });

  it("fails like waitFor", async () => {
    const outcome = settle(
      waitForValue(() => undefined, "the third publish", {
        timeoutMs: 100,
        observed: () => ["first", "second"],
      }),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome.error?.message).toBe(
      'timed out after 100 ms waiting for the third publish; last observed: ["first","second"]',
    );
  });
});

describe("expectQuiet", () => {
  it("resolves after the whole window when nothing arrives", async () => {
    const outcome = settle(expectQuiet(() => [], "publish", { windowMs: 300 }));
    await vi.advanceTimersByTimeAsync(250);
    expect(outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeUndefined();
  });

  it("ignores what was in the log before the window opened", async () => {
    const log = ["early"];
    const outcome = settle(
      expectQuiet(() => log, "publish", { windowMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome.done).toBe(true);
    expect(outcome.error).toBeUndefined();
  });

  it("fails as soon as something arrives, naming it", async () => {
    const log: unknown[] = [];
    const outcome = settle(
      expectQuiet(() => log, "publish for the page", { windowMs: 800 }),
    );
    await vi.advanceTimersByTimeAsync(100);
    log.push({ uri: "file:///a.mx", diagnostics: 2 });
    await vi.advanceTimersByTimeAsync(30);
    expect(outcome.error?.message).toBe(
      'expected no publish for the page within 800 ms, but 1 arrived: [{"uri":"file:///a.mx","diagnostics":2}]',
    );
  });

  it("catches an event that lands on the window's last poll", async () => {
    const log: unknown[] = [];
    const outcome = settle(
      expectQuiet(() => log, "publish", { windowMs: 100, pollMs: 50 }),
    );
    await vi.advanceTimersByTimeAsync(99);
    log.push("late");
    await vi.advanceTimersByTimeAsync(10);
    expect(outcome.error?.message).toBe(
      'expected no publish within 100 ms, but 1 arrived: ["late"]',
    );
  });

  it("counts every event that arrived", async () => {
    const log: unknown[] = [];
    const outcome = settle(
      expectQuiet(() => log, "publish", { windowMs: 100 }),
    );
    log.push(1, 2);
    await vi.advanceTimersByTimeAsync(50);
    expect(outcome.error?.message).toBe(
      "expected no publish within 100 ms, but 2 arrived: [1,2]",
    );
  });
});
