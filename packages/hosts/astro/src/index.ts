/**
 * `@mxlang/astro` — the Astro host for MX.
 *
 * MX (Markup eXtended) is a template language born from Marko, MX 1.0 being a
 * strict subset of Marko's syntax (decision 72). This package renders `.mx`
 * components inside an Astro project as **static markup**: they are compiled
 * by `@mxlang/html` to a runtime-free
 * `(input) => string` function, called during Astro's build, and never shipped
 * to a browser.
 *
 * Two pieces, and no third: an integration that registers a renderer and adds
 * MX's existing Vite plugin, and the renderer's own server entrypoint
 * (`./server.ts`). The compile step is `@mxlang/vite-plugin` unchanged — an
 * Astro project is a Vite project, and that plugin already turns a `.mx` file
 * into a plain module.
 */

import { createRequire } from "node:module";
import type {
  AttrTagAttrs,
  AttrTagConfig,
  AttrTagParams,
  CustomTag,
} from "@mxlang/core";
import mx from "@mxlang/vite-plugin";
import { mxPages } from "./vite-pages.ts";
import { mxTemplates } from "./vite-templates.ts";

/** Attribute-tag slot received by an `@mxlang/astro` component. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = C["as"] extends "renderable"
  ? (...args: AttrTagParams<C>) => string
  : AttrTagAttrs<C> & {
      content?: (...args: AttrTagParams<C>) => string;
    };

/**
 * Astro's integration surface, to the depth this file uses it.
 *
 * Declared locally rather than imported from `astro`: the package is a
 * *peer* of a consumer's own Astro install, and typing against these two
 * callbacks keeps `astro` a devDependency here (for the example and the
 * tests) instead of a hard runtime dependency of every consumer.
 */
interface AstroRenderer {
  name: string;
  serverEntrypoint: string;
  clientEntrypoint?: string;
}

interface AstroIntegration {
  name: string;
  hooks: {
    "astro:config:setup"?: (options: {
      config: { srcDir: URL };
      addRenderer: (renderer: AstroRenderer) => void;
      // Astro documents it as not subject to semver, installs it non-enumerably, and it is variadic.
      addPageExtension?: (...ext: (string | string[])[]) => void;
      updateConfig: (config: Record<string, unknown>) => void;
    }) => void;
  };
}

export interface MxIntegrationOptions {
  /**
   * File extensions compiled as MX. Defaults to `.mx`.
   *
   * `.solid.mx` is deliberately absent: that is a different file kind (TSX
   * with MX regions, lowered to Solid JSX), and it belongs to the Solid host,
   * not this one. `.marko` is not accepted either: MX only supports the MX
   * 1.0 subset of Marko syntax, so treating a real `.marko` file as MX would
   * silently claim support it does not have.
   */
  extensions?: string[];
  /** Custom tags already discovered and loaded for `.mx` and `.amx` files. */
  customTags?: Record<string, CustomTag>;
}

const DEFAULT_EXTENSIONS = [".mx"];

/**
 * The Astro integration.
 *
 * ```js
 * // astro.config.mjs
 * import { defineConfig } from "astro/config";
 * import mx from "@mxlang/astro";
 *
 * export default defineConfig({ integrations: [mx()] });
 * ```
 *
 * `clientEntrypoint` is omitted, which is a first-class shape in Astro's
 * `AstroRenderer` type rather than an omission it tolerates: a component with
 * no state and no runtime has nothing to hydrate.
 *
 * Astro does **not** guard a `client:*` directive on such a component, despite
 * shipping an error message for exactly that case. `NoClientEntrypoint` is
 * defined in `astro/dist/core/errors/errors-data.js` and thrown from nowhere
 * in astro@7.3.2 (verified by grepping the installed package: the only hits
 * are the definition and its `.d.ts`); the render path is a bare
 * `if (renderer.clientEntrypoint)` at `dist/runtime/server/hydration.js:98`
 * with no else branch. Left alone, a `client:load` builds cleanly and emits an
 * `<astro-island client="load">` whose loader falls back to a no-op hydrator —
 * an island that silently does nothing, on a host whose claim is shipping no
 * client JS.
 *
 * So **this host raises the error itself**, in `renderToStaticMarkup` when
 * Astro's `metadata.hydrate` is set: `client:*` on an MX component is an error
 * (decision 70), not something to discover in a bundle.
 * `examples/astro-static/e2e/build-errors.spec.ts` asserts the failing build.
 *
 * `strict: true` on the Vite plugin selects `@mxlang/html`'s
 * `strictPolicy`: `<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client`
 * blocks and `<id>` become compile errors naming the construct instead of
 * rendering their initial value or compiling away as inert. Decision 71 —
 * stateful tags mean whatever the host says, and this host has no reactive
 * target at all, so "this needs a runtime" is a build error rather than
 * markup that silently renders once and never updates.
 */
export default function mxAstro(
  options: MxIntegrationOptions = {},
): AstroIntegration {
  // MX only supports the MX 1.0 subset of Marko syntax, so a caller cannot
  // opt back into `.marko` through `extensions` — that would silently claim
  // support this integration does not have. Rejected eagerly, at
  // integration construction, rather than left to surface later as a
  // confusing build-time mismatch.
  if (options.extensions?.some((ext) => ext.endsWith(".marko"))) {
    throw new Error(
      "@mxlang/astro: '.marko' is not a supported extension — MX only compiles the MX 1.0 subset of Marko syntax under '.mx'.",
    );
  }
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;

  return {
    name: "@mxlang/astro",
    hooks: {
      "astro:config:setup": ({
        config,
        addRenderer,
        addPageExtension,
        updateConfig,
      }) => {
        addRenderer({
          name: "@mxlang/astro",
          serverEntrypoint: "@mxlang/astro/server",
        });

        if (typeof addPageExtension !== "function") {
          let astroVersion = "unknown";
          try {
            const require = createRequire(import.meta.url);
            astroVersion = require("astro/package.json").version;
          } catch (_e) {}
          throw new Error(
            `Astro ${astroVersion} does not provide the 'addPageExtension' hook on the integration setup params. MX needs this non-semver hook to register the '.mx' and '.amx' page extensions.`,
          );
        }

        // `.mx` files under `src/pages` are pages (decision 76b). `.marko`
        // is not a registered extension for this integration at all (see
        // `MxIntegrationOptions.extensions`'s own doc comment), so a
        // `.marko` file anywhere in an Astro project is simply not MX's.
        addPageExtension(".mx");

        // `.amx` files are AstroMX: an Astro component whose template is MX,
        // lowered to Astro template syntax (decision 76c/78). Registered as a
        // page extension too, so components, layouts and pages all share the
        // one spelling — which is why the extension is single-dot: Astro's
        // route collection reads only the last extension segment, so a
        // multi-dot `.astro.mx` could never be a page.
        addPageExtension(".amx");

        updateConfig({
          vite: {
            plugins: [
              // `.astro.mx` first: it owns that extension outright, lowering
              // the MX template to Astro template syntax and handing the file
              // to Astro's own compiler (decision 76c). `mx()` declines the
              // extension itself, so the order is documentation rather than a
              // tie-break.
              mxTemplates(options.customTags),
              mx({
                extensions,
                strict: true,
                customTags: options.customTags,
              }),
              mxPages(config.srcDir),
            ],
          },
        });
      },
    },
  };
}
