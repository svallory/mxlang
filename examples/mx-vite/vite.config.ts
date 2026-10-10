import mx from "@mxlang/vite-plugin";
import { defineConfig } from "vite";

// A minimal SSG: `vite build` bundles `src/build.ts` (an SSR/Node build, not
// a browser one) through MX's `.mx` handling, then the bundle is run with
// Node to actually write `dist/*.html`. This is the plugin's whole-file `.mx`
// path (`compile()`, a string-returning function) — no Solid, no client
// runtime, unlike `examples/counter-app`.
export default defineConfig({
  plugins: [mx()],
  build: {
    ssr: "src/build.ts",
    outDir: "dist-ssr",
    target: "node22",
  },
  // Every compiled `.mx` page imports `escape` from `@mxlang/target-html`.
  // Left un-external, rolldown bundles that import by parsing
  // `@mxlang/target-html`'s own TS source (its `main` is `src/index.ts`,
  // unbuilt) — which pulls in `@marko/compiler`'s transitive TypeScript
  // parameter-property syntax that rolldown's strip-only mode rejects.
  // External keeps it a runtime import, resolved by Bun (which transpiles TS
  // natively) when the bundle runs.
  ssr: {
    external: ["@mxlang/target-html"],
  },
});
