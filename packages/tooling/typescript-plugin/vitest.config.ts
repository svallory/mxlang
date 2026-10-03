import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mxlang/typescript-plugin",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        // Descriptors synchronously require compile leaves, which use Node's
        // core instance. Transforming the linked dist again splits its editor
        // buffer overrides from the plugin's imports. core-identity.test.ts
        // pins the same native module boundary as the published artifact.
        external: [/packages\/core\/dist\//],
      },
    },
  },
});
