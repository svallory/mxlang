import { readFileSync } from "node:fs";
import type { TargetLookup } from "@mxlang/core";
import { reportScanDiagnostics, scanCached } from "@mxlang/preact";
import type { BunPlugin } from "bun";
import { honoDefaultTag } from "./default-tag.ts";
import { compileHonoMx, honoTargets } from "./index.ts";

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
 * match here, nor does `.astro.mx` (Astro's template kind), hence the
 * negative lookbehind despite both also ending in `.mx`.
 *
 * Custom tags are discovered per loaded file (spec §4), the same as
 * `@mxlang/html/bun`: which tags a template may call follows from where the
 * template lives, not from plugin configuration.
 */
const MX_FILTER = /(?<!\.(?:solid|astro))\.mx$/;

/**
 * Builds the loader over `targets`: the registered targets it scans and
 * compiles under (decisions 129 and 132). It defaults to this package's own
 * descriptor, which is what a plain `import "@mxlang/hono/bun"` wants; a
 * caller compiling for several targets passes the built-in registry's lookup
 * instead (design note §5.1, rule (c)).
 */
export function createHonoBunPlugin(
  targets: TargetLookup = honoTargets,
): BunPlugin {
  /** De-dup key per distinct scan diagnostic, so a misconfigured `mx.tags` warns once per problem, not once per loaded file. */
  const reportedScanDiagnostics = new Set<string>();

  return {
    name: "mxlang-hono",
    setup(build) {
      build.onLoad({ filter: MX_FILTER }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        const scan = scanCached(path, { host: "hono", targets });
        reportScanDiagnostics(
          // Own-only loaders cannot establish that a peer host is unknown.
          scan.diagnostics,
          reportedScanDiagnostics,
          (d) => console.warn(`@mxlang/hono: ${d.file}: ${d.message}`),
        );
        const defaultTag = honoDefaultTag(path, scan.customTags, (d) =>
          console.warn(
            `@mxlang/hono: ${d.file}:${d.line}:${d.column + 1}: ${d.message}`,
          ),
        );
        const { code } = compileHonoMx(source, path, {
          customTags: scan.customTags,
          ...(defaultTag === undefined ? {} : { defaultTag }),
          targets,
        });
        return { contents: code, loader: "tsx" };
      });
    },
  };
}

const honoPlugin: BunPlugin = createHonoBunPlugin();

Bun.plugin(honoPlugin);

export default honoPlugin;
