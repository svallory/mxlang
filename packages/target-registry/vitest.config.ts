import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares
    // workers): target-select-read.test.ts hoists vi.mock("node:fs") and
    // vi.mock("@mxlang/core") and they must apply to ./index.ts, which twelve
    // other files here import. A shared graph would bypass the mocks and the
    // test (`secondReads` stays 0) would pass without testing anything.
    poolOptions: { forks: { isolate: true } },
  },
});
