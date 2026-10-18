import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No global state: pure parser-fork checks (audited: no vi.mock, no
    // globalThis writes), so files share a worker and skip re-imports.
    isolate: false,
    exclude: ["**/node_modules/**"],
  },
});
