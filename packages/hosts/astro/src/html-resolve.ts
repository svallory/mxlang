/**
 * Resolves `@mxlang/html` for the modules MX compiles, from this package's own
 * dependency.
 *
 * Every html-compiled `.mx` module imports the bare specifier `@mxlang/html`
 * (`escape` and, since decision 155, `createOut`). Vite resolves it from the
 * importing file's directory, i.e. the user's project, where an isolated
 * linker (bun workspaces, pnpm) does not put a package the user never
 * installed. The install line is `bun add -d @mxlang/astro` and nothing else,
 * so the integration answers for the package itself: `@mxlang/html` is one of
 * `@mxlang/astro`'s own `dependencies`.
 *
 * Only importers that are compiled MX modules (`x.mx`, `x.mx.ts`, `x.mx.tsx`)
 * are answered, and only for `@mxlang/html` and its subpaths such as
 * `@mxlang/html/runtime`; a project's own import of the package resolves as it
 * did before.
 */

import { createRequire } from "node:module";
import type { Plugin } from "vite";

const HTML_SPECIFIER_RE = /^@mxlang\/html(\/[^?#]+)?$/;
const MX_IMPORTER_RE = /\.mx(\.tsx?)?(\?.*)?$/;

/** The plugin that resolves `@mxlang/html` for compiled MX modules. */
export function mxHtmlResolve(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "mx-astro-html-resolve",
    enforce: "pre",
    resolveId(id: string, importer: string | undefined) {
      if (!importer || !MX_IMPORTER_RE.test(importer)) return null;
      if (!HTML_SPECIFIER_RE.test(id)) return null;
      return require.resolve(id);
    },
  };
}
