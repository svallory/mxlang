import { afterEach } from "vitest";

/**
 * Lets the event loop run between tests.
 *
 * A file of many synchronous tests (a TypeScript language service or an
 * ngtsc program per test) never leaves the event loop: vitest awaits only
 * microtasks between them, so timers and the worker's RPC replies wait for the
 * whole file. Under CI contention that stretched to 40-72 s, and birpc's fixed
 * 60 s round-trip timeout then failed the run with `Timeout calling
 * "onTaskUpdate"` although every test passed (#390). A macrotask hop after
 * each test bounds the longest block to one test.
 */
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
