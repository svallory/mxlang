/**
 * The `package.json` files that decide an `.mx` file's host, as inputs of a
 * watch rebuild.
 *
 * A `package.json` picks the host (`mx.host`, `mx.target`, the `@mxlang`
 * dependencies) every `.mx` file under it compiles with. TypeScript knows
 * nothing of that: it only watches the files a program read as sources, a
 * module resolution's failed lookups, and the `package.json` of a file whose
 * module format it looks up (a `node16`/`nodenext` project, or a file under
 * `node_modules`). So an edit to the manifest that chooses the host started no
 * rebuild at all (`Found 0 errors` stayed true until something else changed),
 * and a rebuild that something else started did not compile the `.mx` file
 * again, because its source text had not changed: the diagnostics of the old
 * host stayed, at positions measured in the old manifest.
 *
 * Both halves are closed here, on the compiler host the language plugins are
 * handed, with TypeScript's own mechanisms and no watcher of ours:
 *
 * - **Watching.** `createProgram` asks the host for a source file with an
 *   options object, and reads `packageJsonLocations` from that same object
 *   after the call. Those paths are the file's affecting locations: TypeScript
 *   watches each one with the watch host's `watchFile` (so `TSC_WATCHFILE`,
 *   polling and `--watchFile` apply), and when one changes it invalidates the
 *   file and starts a rebuild. The paths of every manifest that can decide an
 *   `.mx` file's host are added there. A manifest that does not exist yet is
 *   listed too, so creating a nearer one is noticed.
 * - **Recompiling.** A rebuild hands an unchanged file's source back to Volar,
 *   which then compiles nothing. When a manifest's stamp is not the one the
 *   file was last compiled under, the host returns a new source file object
 *   with the same text and a new version instead: Volar compiles it again
 *   (resolving the host anew, replacing the file's policy diagnostics and its
 *   projection) and the program's builder type-checks it again.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type ts from "typescript";

/** Marks a host this module already wrapped: `setup` runs once per language. */
const WRAPPED = Symbol.for("mx-tsc.package-json-inputs");

/**
 * Every `package.json` that can decide the host of `fileName`, nearest first:
 * each directory's up to the second one that exists (the nearest manifest
 * decides; the next one is what a malformed nearest manifest falls back to and
 * names in its message). When fewer exist, the walk reaches the filesystem root.
 */
export function packageJsonInputs(
  fileName: string,
  exists: (path: string) => boolean = isFile,
): string[] {
  const inputs: string[] = [];
  let found = 0;
  for (let dir = dirname(fileName); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json").replaceAll("\\", "/");
    inputs.push(manifest);
    if (exists(manifest) && ++found === 2) break;
    if (dirname(dir) === dir) break;
  }
  return inputs;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** What each input looked like now: a change to any of them changes this. */
function stampOf(inputs: readonly string[]): string {
  return inputs
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

interface CompiledView {
  /** The host's own source file this view stands for. */
  source: ts.SourceFile;
  /** The manifests' stamp when `view` was handed out. */
  stamp: string;
  /** What `getSourceFile` returns while neither the source nor the stamp moves. */
  view: ts.SourceFile;
}

/**
 * Under `tsc -b -w` the solution builder does not watch a source file's
 * `packageJsonLocations`. It watches the `package.json` files in the module
 * resolution cache's package-info cache after a project's program was made
 * (`watchPackageJsonFiles`, in `tsc.js`). A bundler-resolution project never
 * looks its own manifest up, so none of ours would be watched. So the scope is
 * looked up here the way module resolution looks one up (`getPackageScopeForPath`:
 * each directory up to the nearest manifest, then the one above it): this fills
 * that cache with the entries resolution itself would add on first use (the
 * parsed file, or the note that a directory has none), and the builder watches
 * them with its own `watchFile`. Both functions are TypeScript's own, reached
 * through the `typescript` object Volar hands the plugins; when this
 * TypeScript lacks either, the lookup is skipped and the run is as it was.
 */
function recordInResolutionCache(
  typescript: typeof ts,
  host: ts.CompilerHost,
  fileName: string,
): void {
  const internals = typescript as unknown as {
    getPackageScopeForPath?: (
      directory: string,
      state: unknown,
    ) => { packageDirectory: string } | undefined;
    getTemporaryModuleResolutionState?: (
      cache: unknown,
      host: ts.CompilerHost,
      options: ts.CompilerOptions,
    ) => unknown;
  };
  const cache = (
    host as {
      getModuleResolutionCache?: () =>
        | { getPackageJsonInfoCache(): unknown }
        | undefined;
    }
  ).getModuleResolutionCache?.();
  const { getPackageScopeForPath, getTemporaryModuleResolutionState } =
    internals;
  if (!cache || !getPackageScopeForPath || !getTemporaryModuleResolutionState) {
    return;
  }
  const state = getTemporaryModuleResolutionState(
    cache.getPackageJsonInfoCache(),
    host,
    {},
  );
  let directory = dirname(fileName);
  for (let found = 0; found < 2; found++) {
    const scope = getPackageScopeForPath(directory, state);
    if (!scope) return;
    directory = dirname(scope.packageDirectory);
  }
}

/**
 * Makes the manifests that decide an `.mx` file's host inputs of that file in a
 * watch run (see the module comment). `extensions` are the file endings the
 * language plugins compile. Idempotent per host.
 */
export function trackPackageJsonInputs(
  typescript: typeof ts,
  host: ts.CompilerHost | undefined,
  extensions: readonly string[],
  solutionBuild = false,
): void {
  const getSourceFile = host?.getSourceFile;
  if (!host || typeof getSourceFile !== "function") return;
  const marked = host as ts.CompilerHost & { [WRAPPED]?: true };
  if (marked[WRAPPED]) return;
  marked[WRAPPED] = true;

  const views = new Map<string, CompiledView>();
  let revision = 0;

  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) => {
    const source = getSourceFile(fileName, languageVersionOrOptions, ...rest);
    if (
      !source ||
      !extensions.some((extension) => fileName.endsWith(extension))
    ) {
      return source;
    }
    const inputs = packageJsonInputs(fileName);
    if (solutionBuild) recordInResolutionCache(typescript, host, fileName);
    if (typeof languageVersionOrOptions === "object") {
      // `createProgram` reads this back off the object it passed in.
      const options = languageVersionOrOptions as {
        packageJsonLocations?: string[];
      };
      options.packageJsonLocations = [
        ...new Set([...(options.packageJsonLocations ?? []), ...inputs]),
      ];
    }
    const stamp = stampOf(inputs);
    const known = views.get(fileName);
    if (!known || known.source !== source) {
      views.set(fileName, { source, stamp, view: source });
      return source;
    }
    if (known.stamp === stamp) return known.view;
    // A manifest changed since this file was handed out. Same text, new
    // object, new version: Volar compiles it again and the builder re-checks it.
    const fresh = typescript.createSourceFile(
      fileName,
      source.text,
      languageVersionOrOptions,
      false,
    );
    (fresh as unknown as { version: string }).version =
      `${(source as { version?: string }).version ?? ""}+package.json:${++revision}`;
    views.set(fileName, { source, stamp, view: fresh });
    return fresh;
  };
}
