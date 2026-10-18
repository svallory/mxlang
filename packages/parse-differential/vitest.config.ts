import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mxlang/parse-differential",
    // No global state (audited: no vi.mock, no globalThis writes).
    isolate: false,
  },
});
