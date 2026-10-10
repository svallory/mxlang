import mx from "@mxlang/vite-plugin";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// `mx()` first: both plugins are `enforce: "pre"`, so their relative order is
// their order in this array. MX turns each `.mx` file into Preact JSX text,
// and `@preact/preset-vite` compiles that JSX — which is why this example
// needs no JSX configuration of its own.
//
// The host is not configured here: `package.json`'s `"mx": { "host":
// "preact" }` is what routes `.mx` through `@mxlang/host-preact`, and the same
// field is what the language server and `mx-tsc` read, so an editor and a
// build cannot disagree.
export default defineConfig({
  plugins: [mx(), preact()],
});
