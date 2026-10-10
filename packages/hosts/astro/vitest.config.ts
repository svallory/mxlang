import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test in `server.test.ts` compiles a template through
    // `@mxlang/target-html` -> `@marko/compiler` and dynamic-imports the result.
    // That first compile is a genuinely heavy cold import (~1.5s for the whole
    // file in isolation), and under a full `bun run verify` — 20 vitest
    // projects in parallel, ~77s of transform — individual cases have been
    // measured at 5.1-5.5s, over vitest's 5000ms default.
    //
    // The budget is raised for this project only, with the reason stated,
    // rather than globally: a slow *compiler* is the cost being absorbed here,
    // and a global raise would hide a genuinely hung test somewhere else.
    testTimeout: 30_000,
  },
});
