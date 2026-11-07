import { createRequire } from "node:module";
import type { Plugin } from "vitest/config";

const requireFromHere = createRequire(import.meta.url);

/**
 * Pins every `preact` / `preact/*` specifier to the workspace's copy.
 *
 * `preact` declares `preact-render-to-string` as an optional peer, so bun can
 * install two store entries of the same preact version: one linked beside
 * `preact-render-to-string` and one beside the workspace. On a clean install
 * `preact-render-to-string` then loads its own copy, and the copy the tests
 * render with (hooks, options, vnodes) is a different module instance, so
 * hooks fail with `reading '__H'` and the server renderer misses the boundary.
 * Used with `server.deps.inline: ["preact-render-to-string"]` so its imports
 * go through this resolver too.
 */
export function singlePreact(): Plugin {
  return {
    name: "mx-single-preact",
    enforce: "pre",
    resolveId(id) {
      if (id !== "preact" && !id.startsWith("preact/")) return null;
      try {
        return requireFromHere.resolve(id);
      } catch {
        return null;
      }
    },
  };
}
