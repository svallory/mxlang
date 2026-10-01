/**
 * Which projects a `tsc -b` run covers, and how to read its command line.
 *
 * `tsc -b` skips a project whose build info says it is up to date, and a
 * skipped project never creates a program, so Volar's language plugin never
 * compiles its `.ng.mx` files and the Angular template pass has nothing to
 * check. tsc's incremental state knows nothing about templates, so the pass
 * cannot be skipped on its say-so: this module finds every project of the
 * build graph, whether or not tsc rebuilt it; each one's `.ng.mx` files come
 * from its own program (`index.ts`).
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { resolveProjectTsconfigs } from "./ng-diagnostics.ts";

type TypeScript = typeof import("typescript");

function loadTypeScript(): TypeScript {
  return createRequire(import.meta.url)("typescript") as TypeScript;
}

export interface BuildMode {
  /** `--clean`: tsc deletes outputs and checks nothing. */
  clean: boolean;
  /** `--dry` / `-d`: tsc only reports what it would do. */
  dry: boolean;
}

/**
 * `argv` as `tsc -b` reads it: build mode only when `-b` / `--build` is the
 * first argument (the same rule `tsc` and {@link resolveProjectTsconfigs}
 * use). `undefined` outside build mode.
 */
export function parseBuildMode(argv: readonly string[]): BuildMode | undefined {
  const first = argv[0]?.replace(/^--?/, "").toLowerCase();
  if (!argv[0]?.startsWith("-") || (first !== "b" && first !== "build")) {
    return undefined;
  }
  const { buildOptions, errors } = loadTypeScript().parseBuildCommand([
    ...argv,
  ]);
  // `--help`, `--version` and a command line tsc rejects build nothing.
  if (buildOptions.help || buildOptions.version || errors.length > 0) {
    return undefined;
  }
  return { clean: !!buildOptions.clean, dry: !!buildOptions.dry };
}

export interface BuildProject {
  tsconfigPath: string;
}

/**
 * Every project `tsc -b argv` builds: the named roots and, transitively, their
 * `references`, each once, dependencies first (tsc's build order). A project that cannot be
 * parsed is skipped here (tsc reports it itself and fails the run). Which
 * `.ng.mx` files a project holds is not decided here: that is the project's
 * own program (see `compileProjectNgMx` in `index.ts`), never a re-implementation
 * of tsc's file selection or module resolution.
 */
export function resolveBuildProjects(
  argv: readonly string[],
  cwd: string,
): BuildProject[] {
  const ts = loadTypeScript();
  const projects: BuildProject[] = [];
  const seen = new Set<string>();
  const visit = (tsconfigPath: string): void => {
    if (seen.has(tsconfigPath)) return;
    seen.add(tsconfigPath);
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error) return;
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(tsconfigPath),
      undefined,
      tsconfigPath,
    );
    // References first: a project follows everything it depends on, which is
    // tsc's own build order and decides who owns a file two programs both hold.
    for (const reference of parsed.projectReferences ?? []) {
      visit(ts.resolveProjectReferencePath(reference));
    }
    projects.push({ tsconfigPath });
  };
  for (const root of resolveProjectTsconfigs(argv, cwd)) visit(root);
  return projects;
}
