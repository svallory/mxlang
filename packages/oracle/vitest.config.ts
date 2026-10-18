import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mxlang/oracle",
    // No global state (audited: no vi.mock, no globalThis writes); the oracle
    // reads fixture tables and renders them, so files share a worker.
    isolate: false,
  },
});
