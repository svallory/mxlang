import { createRequire } from "node:module";
import { join } from "node:path";
import type { LanguagePlugin, VirtualCode } from "@volar/language-core";

interface UriLike {
  path: string;
  fsPath: string;
}

type AstroLanguagePlugin = LanguagePlugin<UriLike, VirtualCode>;
export type AstroLanguagePluginLoader = () => AstroLanguagePlugin;

/**
 * Loads Astro's language plugin only for an explicitly enabled Astro project,
 * then adapts its URI-keyed API to the file-name keys tsserver uses.
 */
export function createAstroLanguagePlugin(
  load?: AstroLanguagePluginLoader,
  projectDir?: string,
): LanguagePlugin<string> {
  let astro: AstroLanguagePlugin;
  try {
    astro = (load ?? (() => loadAstroLanguagePlugin(projectDir)))();
  } catch (cause) {
    throw new Error(
      "@mxlang/typescript-plugin: `astro: true` requires the optional peer dependency `@astrojs/language-server@2.16.16`; install it beside the plugin.",
      { cause },
    );
  }

  const adapted: LanguagePlugin<string> = {
    getLanguageId(fileName) {
      return astro.getLanguageId?.(toUri(fileName));
    },
    createVirtualCode(fileName, languageId, snapshot, context) {
      return astro.createVirtualCode?.(
        toUri(fileName),
        languageId,
        snapshot,
        context as never,
      );
    },
    typescript: astro.typescript
      ? {
          ...astro.typescript,
          // Volar's runTsc path cannot host Astro's auxiliary .mjs/.mts
          // scripts; the main TSX service script is the one typecheck needs.
          getExtraServiceScripts: undefined,
        }
      : undefined,
  };
  if (astro.updateVirtualCode) {
    adapted.updateVirtualCode = (fileName, code, snapshot, context) =>
      astro.updateVirtualCode?.(
        toUri(fileName),
        code,
        snapshot,
        context as never,
      );
  }
  if (astro.disposeVirtualCode) {
    adapted.disposeVirtualCode = (fileName, code) =>
      astro.disposeVirtualCode?.(toUri(fileName), code);
  }
  adapted.isAssociatedFileOnly = (fileName, languageId) =>
    fileName.replace(/\\/g, "/").includes("/node_modules/") ||
    (astro.isAssociatedFileOnly?.(toUri(fileName), languageId) ?? false);
  return adapted;
}

/**
 * The peer is resolved from the project first: an installed VSIX ships the
 * plugin from the extension's own directory, where the project's
 * `@astrojs/language-server` is not reachable. The plugin's own location is
 * the fallback (a source checkout, `mx-tsc` run beside its peer).
 */
export function loadAstroLanguagePlugin(
  projectDir?: string,
): AstroLanguagePlugin {
  const entry = "@astrojs/language-server/dist/core/index.js";
  let module: { getAstroLanguagePlugin(): AstroLanguagePlugin } | undefined;
  if (projectDir !== undefined) {
    try {
      module = createRequire(join(projectDir, "package.json"))(entry);
    } catch {
      module = undefined;
    }
  }
  const resolved =
    module ??
    (createRequire(import.meta.url)(entry) as {
      getAstroLanguagePlugin(): AstroLanguagePlugin;
    });
  return resolved.getAstroLanguagePlugin();
}

function toUri(fileName: string): UriLike {
  const normalized = fileName.replace(/\\/g, "/");
  return { path: normalized, fsPath: fileName };
}
