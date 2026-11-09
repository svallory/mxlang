import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mxlang/vscode",
    // Module reset per file in a reused process (root forks pool shares
    // workers): server-command.test.ts relies on hoisted vi.mock("fs") and
    // vi.mock("child_process") applying to ./server-command.js, which a module
    // already imported by another file in the worker would bypass.
    poolOptions: { forks: { isolate: true } },
  },
});
