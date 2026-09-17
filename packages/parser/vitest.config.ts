import { defineConfig } from "vitest/config";

// `region-compile.bun.test.ts` pins behaviour that only exists under Bun
// (JavaScriptCore puts `line`/`column` on every `Error`; V8 does not), so it
// runs under `bun run test:bun` instead of this vitest project — under
// Node it would pass against the very bug it exists to catch.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "src/mx/region-compile.bun.test.ts"],
  },
});
