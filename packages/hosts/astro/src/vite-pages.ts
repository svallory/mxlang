/**
 * Wraps MX's compiled page modules in an Astro component factory.
 *
 * `@mxlang/vite-plugin`'s `mx()` (added by the integration, unchanged) already
 * turns `src/pages/foo.mx` into a plain `<path>.mx.ts` module exporting
 * `default(input) => string` plus any hoisted module-level exports (decision
 * 76b's `export const getStaticPaths = ...` support in `@mxlang/core`'s
 * `emitStatement`). That is a component shape, not a page shape: Astro's
 * router calls a page module's default export as `(result, props, slots) =>
 * ...` through `createComponent`, not as MX's own `(input) => string`.
 *
 * This plugin runs after `mx()` in the same `transform` pass (Vite calls
 * plugin hooks of the same name in array order) and, for ids under the
 * project's `src/pages/`, rewrites the already-compiled module: renames the
 * MX render function, imports Astro's runtime helpers, and default-exports a
 * factory built with them. Every other named export (`getStaticPaths`,
 * `prerender`, ...) passes through untouched — `mx()` already emitted them at
 * module scope, and this rewrite only touches the `export default` line.
 */

import type { Plugin } from "vite";

/**
 * The exact tail `@mxlang/html`'s `brandRender` (`translate.ts`) always
 * appends: the `Symbol.for("mx.component")` brand on the render function,
 * then `export default <Name>;` — where `<Name>` is the file's own derived
 * export name (`about.mx` -> `About`), the *same* name in both halves.
 * Matched as this fixed shape rather than a general "any default export"
 * regex, since a page-mode rewrite only applies to it, not to arbitrary code
 * some other plugin might hand this transform. Pages don't need the brand —
 * Astro's router calls a page's default export directly rather than routing
 * it through a renderer's `check()` — so this rewrite drops it along with the
 * `export default` line and keeps only the render function, renamed to
 * `__mxRenderPage` so the wrapper below can call it without colliding with
 * any name some other hoisted export might also use.
 */
// The render function is named after its file (`about.mx` -> `About`), not a
// fixed `render`, so the name has to be *read* rather than pinned — and read
// from the branded tail, which is the only place it is unambiguous.
//
// Matching "the first function taking `input`" instead would bind to whatever
// such function comes first in the module: a hoisted helper the author wrote,
// or an imported tag unit inlined by the bundler, would be renamed to
// `__mxRenderPage` and the real render function left alone. The tail names
// exactly one function, and the same name must appear in both halves of it.
const EXPORT_DEFAULT_RENDER_RE =
  /\n*Object\.defineProperty\(([A-Za-z_$][\w$]*),\s*Symbol\.for\("mx\.component"\),\s*\{\s*value:\s*true\s*\}\);\n*export default \1;\n*$/;

/** The declaration of `name`, as the compiled module writes it. */
function brandedTailRe(name: string): RegExp {
  return new RegExp(
    `\\n?function ${name.replaceAll("$", "\\$")}\\(input(?::\\s*Input)?\\)(?::\\s*string)?\\s*\\{`,
  );
}

/**
 * `export const layout = "../layouts/Base.astro";`, MX's frontmatter
 * equivalent of Markdown's `layout` key — matched as a plain string literal,
 * the only shape decision 76b's brief asks for. Captured and stripped from
 * the hoisted module scope (a `.astro` specifier is metadata for this
 * transform, not a value the compiled module has any use for at runtime) so
 * the wrapper can turn it into a real import instead.
 */
const LAYOUT_EXPORT_RE = /^export const layout = (["'])((?:(?!\1).)*)\1;\n?/m;

/**
 * A bare `export const NAME = ...;` at module scope, for the frontmatter
 * object. Matched over already-compiled JS text, not the AST — tightly
 * coupled to exactly how `@mxlang/core`/`@mxlang/html` format a
 * hoisted `export const` line today (one name, single-line). A future
 * codegen change there (e.g. multi-variable `export const a = 1, b = 2;`)
 * could silently under-extract names with no core-side test to catch it —
 * only `vite-pages.test.ts` would notice. The proper fix, when this needs
 * hardening, is loading the compiled module and reading its real exports
 * (the same shift `packages/oracle/src/translator-render.ts` made away from
 * text-matching `brandRender`'s output), not a better regex.
 */
const EXPORT_CONST_RE = /^export const (\w+) = /gm;

/**
 * Astro's own reserved page-module export names — routing internals, not
 * author-intended content. Excluded from `frontmatter` so a page with both
 * `layout` and `getStaticPaths`/`prerender` does not leak a function or a
 * boolean into the layout's `frontmatter` object alongside genuine content
 * exports like `title`. `layout` itself is already stripped from `code`
 * before `EXPORT_CONST_RE` ever runs, so it needs no entry here.
 */
const RESERVED_FRONTMATTER_NAMES = new Set([
  "getStaticPaths",
  "prerender",
  "partial",
]);

/**
 * Rewrites `mx()`'s compiled output into an Astro page component.
 *
 * `input` is `{ ...props, params, url }`: Astro's own props for the route
 * plus `Astro.params`/`Astro.url` merged in, so a dynamic route's MX page can
 * read `input.params.slug` the same way a `.astro` page reads `Astro.params`.
 *
 * Without `layout`, the rendered HTML is returned as-is — the author writes
 * `<html>` themselves or composes through an ordinary MX `content` prop. With
 * it, the layout mirrors Markdown's own behaviour
 * (`astro/dist/vite-plugin-markdown`): the page's HTML becomes the layout's
 * default slot, and `{ frontmatter, url, params }` its props — `frontmatter`
 * being every other top-level `export const NAME = ...;` the page declares,
 * minus `RESERVED_FRONTMATTER_NAMES` (Astro's own routing exports), so a
 * page's own `export const title = ...` reaches the layout the way
 * Markdown's frontmatter keys do while `getStaticPaths`/`prerender` do not
 * leak into it as a function/boolean alongside genuine content. The layout is
 * invoked with Astro's own `renderComponent` — the same helper a `.astro`
 * template uses to render a nested component — rather than calling the
 * factory directly, so this stays correct if Astro's factory-calling
 * convention ever changes shape.
 */
export function wrapAsPage(code: string): string | null {
  // The tail first: it names the function, and that name is what anchors the
  // declaration match below.
  const brandedName = code.match(EXPORT_DEFAULT_RENDER_RE)?.[1];
  if (!brandedName) return null;
  const brandedTail = brandedTailRe(brandedName);
  if (!brandedTail.test(code)) return null;

  const layoutMatch = code.match(LAYOUT_EXPORT_RE);
  const withoutLayout = layoutMatch ? code.replace(LAYOUT_EXPORT_RE, "") : code;

  // Plain JS below, deliberately: by the time this `enforce: "post"` plugin
  // runs, the bundler has already stripped TypeScript types from `code` —
  // measured against the actual build output, `function About(input) {`
  // with no type annotations at all — so injecting `(input: Input)`/`as
  // Input` here would hand rolldown's plain-JS parser syntax it no longer
  // expects anywhere else in the module.
  const rendered = withoutLayout
    .replace(brandedTail, "\nfunction __mxRenderPage(input) {")
    .replace(EXPORT_DEFAULT_RENDER_RE, "");

  const imports = [
    'import { createComponent, renderComponent, renderTemplate, unescapeHTML } from "astro/runtime/server/index.js";',
  ];

  let body: string;
  if (layoutMatch) {
    const layoutSpecifier = layoutMatch[2] as string;
    imports.push(`import __MxLayout from ${JSON.stringify(layoutSpecifier)};`);

    const frontmatterNames = [...rendered.matchAll(EXPORT_CONST_RE)]
      .map((m) => m[1] as string)
      .filter((name) => !RESERVED_FRONTMATTER_NAMES.has(name));
    const frontmatter =
      frontmatterNames.length === 0
        ? "{}"
        : `{ ${frontmatterNames.join(", ")} }`;

    body =
      "export default createComponent((result, props, slots) => {\n" +
      "  const astro = result.createAstro(props, slots);\n" +
      "  const input = {\n" +
      "    ...props,\n" +
      "    params: astro.params,\n" +
      "    url: astro.url,\n" +
      "  };\n" +
      "  const html = __mxRenderPage(input);\n" +
      `  const frontmatter = ${frontmatter};\n` +
      '  return renderTemplate`${renderComponent(result, "__MxLayout", __MxLayout, {\n' +
      "    frontmatter,\n" +
      "    url: astro.url,\n" +
      "    params: astro.params,\n" +
      "  }, {\n" +
      "    default: () => unescapeHTML(html),\n" +
      "  })}`;\n" +
      "});\n";
  } else {
    body =
      "export default createComponent((result, props, slots) => {\n" +
      "  const astro = result.createAstro(props, slots);\n" +
      "  const input = {\n" +
      "    ...props,\n" +
      "    params: astro.params,\n" +
      "    url: astro.url,\n" +
      "  };\n" +
      "  return renderTemplate`${unescapeHTML(__mxRenderPage(input))}`;\n" +
      "});\n";
  }

  return `${imports.join("\n")}\n${rendered}\n${body}`;
}

/**
 * True when `path` names a file inside `pagesRoot` (both already normalized
 * filesystem paths, no `?query`/`#hash`).
 *
 * An anchored prefix check, not `path.includes(pagesRoot)`: a substring test
 * matches `pagesRoot` anywhere in `path`, including a sibling project's own
 * `src/pages/` if such a path ever reaches this same Vite instance (a
 * monorepo, a symlinked tree) — not only "under this project's `srcDir`" as
 * decision 76b specifies. A literal `"/"`, not `node:path`'s platform `sep`:
 * both inputs here are already guaranteed POSIX-slash-delimited on every
 * OS — a `URL`'s `.pathname` (`srcDir`/`pagesRoot` come from
 * `new URL("pages/", srcDir).pathname`) and Vite/Rolldown module ids are
 * both forward-slash regardless of host platform. Using `sep` (`\` on
 * Windows) would append a backslash to an all-forward-slash `pagesRoot`,
 * making `startsWith` false for every legitimate page on that platform —
 * silently disabling the whole page-wrapping transform rather than failing
 * loudly. `.../pages-extra/x` does not falsely match a `pagesRoot` of
 * `.../pages/` either way, since the boundary character is exact.
 */
export function isUnderPagesDir(path: string, pagesRoot: string): boolean {
  const root = pagesRoot.endsWith("/") ? pagesRoot : `${pagesRoot}/`;
  return path.startsWith(root);
}

/**
 * `enforce: "post"`, so it runs after `@mxlang/vite-plugin`'s own `pre`
 * transform of the same `.mx.ts` id within the same build.
 */
export function mxPages(srcDir: URL): Plugin {
  const pagesRoot = new URL("pages/", srcDir).pathname;

  return {
    name: "mx-astro-pages",
    enforce: "post",

    transform(code: string, id: string) {
      const path = id.split("?")[0] ?? id;
      if (!isUnderPagesDir(path, pagesRoot)) return null;
      if (!/\.mx\.tsx?$/.test(path)) return null;

      const wrapped = wrapAsPage(code);
      if (wrapped === null) {
        // Decision 61: this file plainly lives under `src/pages/` and passed
        // the extension test above, so it is unambiguously a page module —
        // `wrapAsPage` returning `null` here means the branded-tail regexes
        // did not match `@mxlang/html`'s actual emitted shape (a drift
        // in `brandRender`'s output, not "this isn't a page"). Silently
        // falling through would ship the file as a bare component export —
        // the wrong shape for Astro's router — with no signal anywhere that
        // page-mode wrapping never happened. Fail loud instead, naming the
        // file, so a future `brandRender` format change breaks the build
        // here rather than shipping broken pages silently.
        throw new Error(
          `@mxlang/astro: could not wrap ${path} as a page — the compiled ` +
            "module did not match @mxlang/html's expected branded " +
            "export shape. This file is under src/pages and should be a " +
            "page; if @mxlang/html's emit format changed, update " +
            "EXPORT_DEFAULT_RENDER_RE/brandedTailRe in vite-pages.ts to match.",
        );
      }

      return { code: wrapped, map: null };
    },
  };
}
