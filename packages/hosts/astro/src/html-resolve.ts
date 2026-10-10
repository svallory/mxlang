/**
 * Resolves `@mxlang/target-html` for the modules MX compiles, from this package's own
 * dependency.
 *
 * Every html-compiled `.mx` module imports the bare specifier `@mxlang/target-html`
 * (`escape` and, since decision 155, `createOut`). Vite resolves it from the
 * importing file's directory, i.e. the user's project, where an isolated
 * linker (bun workspaces, pnpm) does not put a package the user never
 * installed. The install line is `bun add -d @mxlang/host-astro` and nothing else,
 * so the integration answers for the package itself: `@mxlang/target-html` is one of
 * `@mxlang/host-astro`'s own `dependencies`.
 *
 * Only importers whose id ends in `.mx`, `.mx.ts` or `.mx.tsx` (an optional
 * `?query` aside) are answered. That includes `.astro.mx`, `.solid.mx` and
 * `.ng.mx`, wherever they live; none of the others imports the specifier.
 * Only `@mxlang/target-html` and its subpaths such as `@mxlang/target-html/runtime` are
 * answered. A compiled `.mx` module therefore always gets *this* package's
 * copy, even when the project has its own: the compiled modules and their
 * runtime then agree, and the sink API (`Out`, `createOut`, `escape`) is
 * structural, so a project importing the package itself alongside is
 * unaffected. Any other importer resolves the package as it did before.
 *
 * This is the bundler half only. TypeScript (`mx-tsc`, the language server)
 * does not use this resolver: the type-check projection of a compiled module
 * imports `@mxlang/host-astro/typecheck` instead (`typecheck.ts`).
 */

import { createRequire } from "node:module";
import type { Plugin } from "vite";

const HTML_SPECIFIER_RE = /^@mxlang\/target-html(\/[^?#]+)?$/;
const MX_IMPORTER_RE = /\.mx(\.tsx?)?(\?.*)?$/;

/** The plugin that resolves `@mxlang/target-html` for compiled MX modules. */
export function mxHtmlResolve(): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "mx-astro-html-resolve",
    enforce: "pre",
    resolveId(id: string, importer: string | undefined) {
      if (!importer || !MX_IMPORTER_RE.test(importer)) return null;
      if (!HTML_SPECIFIER_RE.test(id)) return null;
      try {
        return require.resolve(id);
      } catch {
        // Not resolvable from here (a subpath the package does not export, a
        // broken install): defer to Vite's own resolution instead of failing
        // the build with a stack.
        return null;
      }
    },
  };
}
