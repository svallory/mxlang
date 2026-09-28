import { readFileSync } from "node:fs";
import { reportScanDiagnostics, scanCached } from "@mxlang/preact";
import type { BunPlugin } from "bun";
import { compileHonoMx } from "./index.ts";

/**
 * Registers an `onLoad` for `.mx` files: `compileHonoMx()`'s output
 * is JSX TSX, so `loader: "tsx"` hands it to Bun's own JSX transform (which
 * honours the emitted `/** @jsxImportSource hono/jsx *\/` pragma per file) —
 * no second transform, no bundler needed. Same shape as
 * `@mxlang/html/bun`'s plugin; `loader: "tsx"` instead of `"ts"` is the only
 * difference, since this host's compiled output contains JSX and that
 * package's does not.
 *
 * `.marko` is deliberately not registered: MX only supports the MX 1.0
 * subset of Marko syntax, so treating a real `.marko` file as MX would
 * silently claim support it does not have. `.solid.mx` is a different file
 * kind (TSX with MX regions, handled by `@mxlang/vite-plugin`) and must not
 * match here, hence the negative lookbehind despite it also ending in
 * `.mx`.
 *
 * Custom tags are discovered per loaded file (spec §4), the same as
 * `@mxlang/html/bun`: which tags a template may call follows from where the
 * template lives, not from plugin configuration.
 */
const MX_FILTER = /(?<!\.solid)\.mx$/;

/** De-dup key per distinct scan diagnostic, so a misconfigured `mx.tags` warns once per problem, not once per loaded file. */
const reportedScanDiagnostics = new Set<string>();

const honoPlugin: BunPlugin = {
  name: "mxlang-hono",
  setup(build) {
    build.onLoad({ filter: MX_FILTER }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const scan = scanCached(path, { host: "hono" });
      reportScanDiagnostics(scan.diagnostics, reportedScanDiagnostics, (d) =>
        console.warn(`@mxlang/hono: ${d.file}: ${d.message}`),
      );
      const { code } = compileHonoMx(source, path, {
        customTags: scan.customTags,
      });
      return { contents: code, loader: "tsx" };
    });
  },
};

Bun.plugin(honoPlugin);

export default honoPlugin;
