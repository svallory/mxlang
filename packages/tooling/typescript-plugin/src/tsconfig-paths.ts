import { isAbsolute } from "node:path";
import type * as ts from "typescript";

/**
 * The same synchronous resolver shape core's compile options take
 * (`TranslatorOptions.resolveImport`): given the specifier as written and the
 * file it was written in, the absolute file it means, or `undefined` to let
 * core's own probing answer.
 */
export type TsPathsImportResolver = (
  specifier: string,
  importer: string,
) => string | undefined;

/**
 * Builds the callee-import resolver for tsconfig `paths` and `baseUrl`.
 *
 * Most Vite projects mirror `config.resolve.alias` in tsconfig `paths`, so
 * reading the compiler options the program already parsed is what lets the
 * TypeScript plugin and `mx-tsc` resolve an aliased `.mx` callee import
 * (`import Card from "~/Card.mx"`) to the same file the bundler sees, instead
 * of falling back with `MX_UNREADABLE_CALLEE_INPUT` while the build works.
 *
 * Resolution itself is `typescript.resolveModuleName` over the program's own
 * compiler options — no second paths matcher: patterns, exact aliases,
 * `baseUrl` and `extends` chains are whatever the parsed tsconfig says. Only
 * two things are added around it:
 *
 * - a module-resolution host that answers the declaration-file candidates tsc
 *   probes for a `.mx` module (`Card.d.mx.ts`, `Card.mx.d.ts`, and `Card.d.ts`
 *   for an extension-omitted alias) from the real `Card.mx` on disk, mapping
 *   the resolved name back to that source file — the same declaration-file
 *   convention tsc's own (Volar-patched) resolution uses for `.mx`;
 * - a second resolution with `paths`/`baseUrl` stripped, so the resolver only
 *   claims a hit that actually needed them. A specifier that resolves the
 *   same way without the mapping (a relative path never reaches here, a
 *   `node_modules` package does) stays core's to resolve, exactly as before.
 *
 * The options are read on every call, so a reloaded project's compiler
 * options are picked up without rebuilding the plugin. Lookups are not cached:
 * files can be created, deleted or moved while the options object stays the
 * same. No program is built or tsconfig parsed by this resolver.
 */
export function createTsconfigPathsResolver(
  typescript: typeof ts,
  getCompilerOptions: () => ts.CompilerOptions | undefined,
): TsPathsImportResolver {
  /** Declaration-file candidates this run mapped to their `.mx` source. */
  const mapped = new Map<string, string>();
  const exists = (file: string) => typescript.sys.fileExists(file);
  const mapsTo = (candidate: string, source: string) => {
    if (exists(source)) {
      mapped.set(candidate, source);
      return true;
    }
    return false;
  };
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists(fileName) {
      if (exists(fileName)) return true;
      // The declaration file tsc probes for an extension-kept `.mx` import:
      // `Card.d.mx.ts` (bundler's arbitrary-extension form) and
      // `Card.mx.d.ts` both mean the source file `Card.mx`.
      if (fileName.endsWith(".d.mx.ts")) {
        return mapsTo(fileName, `${fileName.slice(0, -".d.mx.ts".length)}.mx`);
      }
      if (fileName.endsWith(".mx.d.ts")) {
        return mapsTo(fileName, fileName.slice(0, -".d.ts".length));
      }
      // The one tsc probes for an extension-omitted alias (`~/Card`): the
      // `Card.mx` beside the missing `Card.d.ts` is what the specifier means.
      if (fileName.endsWith(".d.ts")) {
        return mapsTo(fileName, `${fileName.slice(0, -".d.ts".length)}.mx`);
      }
      return false;
    },
    readFile: (fileName) => typescript.sys.readFile(fileName),
    directoryExists: (fileName) =>
      typescript.sys.directoryExists?.(fileName) ?? false,
    realpath: (fileName) => typescript.sys.realpath?.(fileName) ?? fileName,
    getCurrentDirectory: () => typescript.sys.getCurrentDirectory(),
    getDirectories: (fileName) =>
      typescript.sys.getDirectories?.(fileName) ?? [],
  };
  return (specifier, importer) => {
    // Relative and absolute specifiers never consulted the paths table, and
    // core resolves them exactly as tsc does; claiming them here could only
    // disagree with the resolution the rest of the compile uses.
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      isAbsolute(specifier)
    ) {
      return undefined;
    }
    const options = getCompilerOptions();
    // Nothing to honour without a mapping: skip the resolution entirely so a
    // project without `paths`/`baseUrl` pays nothing.
    if (!options || (!options.paths && !options.baseUrl)) return undefined;
    mapped.clear();
    const resolved = typescript.resolveModuleName(
      specifier,
      importer,
      options,
      resolutionHost,
    ).resolvedModule?.resolvedFileName;
    let result: string | undefined;
    if (resolved) {
      const withoutMapping = typescript.resolveModuleName(
        specifier,
        importer,
        { ...options, paths: undefined, baseUrl: undefined },
        resolutionHost,
      ).resolvedModule?.resolvedFileName;
      if (withoutMapping !== resolved)
        result = mapped.get(resolved) ?? resolved;
    }
    return result;
  };
}
