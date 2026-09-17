import { readFileSync } from "node:fs";
import { getCustomTags } from "@mxlang/core";
import type { BunPlugin } from "bun";
import { compile } from "./index.ts";

/**
 * Registers an `onLoad` for `.mx` files: `compile()`'s output is plain
 * TypeScript (an `import`, an optional `export interface Input`, and a
 * default-exported function), so `loader: "ts"` hands it straight to Bun's
 * own stripper — no JSX, no second transform needed.
 *
 * Usable both as a preload (`bunfig.toml`'s `preload = ["@mxlang/html/bun"]`
 * runs a preloaded module for its side effects — it does not itself call
 * `Bun.plugin` on a default export — so this module registers itself at
 * import time) and at runtime (`import markoPlugin from "@mxlang/html/bun";
 * Bun.plugin(markoPlugin)`, which registers the same plugin object again;
 * `Bun.plugin` is idempotent for an already-registered plugin object).
 *
 * `.mx` is the only extension this loader accepts. `.marko` is deliberately
 * not registered: MX only supports the MX 1.0 subset of Marko syntax, so
 * treating a real `.marko` file as MX would silently claim support it does
 * not have. `.solid.mx` is a different file kind (TSX with MX regions,
 * handled by `@mxlang/vite-plugin`) and must not match here — the negative
 * lookbehind excludes it despite ending in `.mx`.
 *
 * Custom tags are discovered per loaded file (spec §4) rather than configured
 * on the plugin: which tags a template may call is a property of where that
 * template lives, so a loader that asked the caller to list them would put the
 * answer in the wrong place. The scan is cached, so the repeated `onLoad`
 * calls a build makes over one directory cost one filesystem walk.
 */
const MX_FILTER = /(?<!\.solid)\.mx$/;

const markoPlugin: BunPlugin = {
  name: "mxlang-translator",
  setup(build) {
    build.onLoad({ filter: MX_FILTER }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const { code } = compile(source, path, {
        customTags: getCustomTags(path, { host: "html" }),
      });
      return { contents: code, loader: "ts" };
    });
  },
};

Bun.plugin(markoPlugin);

export default markoPlugin;
