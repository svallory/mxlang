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
import { dirname, resolve } from "node:path";
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

/**
 * Whether `argv` asks `tsc` to keep watching (`-w` / `--watch`), with or
 * without `-b`, read by TypeScript's own command-line parsers so every
 * spelling (`--watch`, a response file, `-w` after the projects) agrees with
 * the TypeScript pass by construction. False on a command line `tsc` rejects.
 */
export function isWatchMode(argv: readonly string[], cwd: string): boolean {
  const ts = loadTypeScript();
  const first = argv[0]?.replace(/^--?/, "").toLowerCase();
  if (first === "b" || first === "build") {
    const { buildOptions, errors } = ts.parseBuildCommand([...argv]);
    return errors.length === 0 && !!buildOptions.watch;
  }
  const { options, errors } = ts.parseCommandLine([...argv], (path) =>
    ts.sys.readFile(resolve(cwd, path)),
  );
  return errors.length === 0 && !!options.watch;
}

export interface BuildProject {
  tsconfigPath: string;
  /**
   * Whether the project selects any root file. A solution root (`"files": []`
   * plus `references`) selects none: it has no program worth creating, only
   * the projects it references do.
   */
  hasFiles: boolean;
  /**
   * The root files the project selects, as tsc resolves them for it (absolute,
   * `/`-separated). A program of the build graph is one of these lists (a
   * `.ng.mx` reached only by import is not a root file of any project, yet its
   * program still is), so this is how a program is matched back to the project
   * that created it — see `matchProjects`.
   */
  rootNames: readonly string[];
}

/**
 * Which project each program of a `tsc -b` run belongs to, by the program's
 * own root files: the project whose file list holds the most of them, first in
 * build order on a tie. Two projects of one build share no root file (tsc
 * compiles each file in exactly one program; a `references` edge substitutes a
 * dependency's output `.d.ts`), so the match cannot be ambiguous in practice,
 * and an unmatched program (`-1`) is reported rather than guessed at.
 */
export function matchProjects(
  projects: readonly BuildProject[],
  programs: readonly (readonly string[])[],
): number[] {
  return programs.map((rootNames) => {
    const roots = new Set(rootNames);
    return projects.reduce(
      (best, project, index) => {
        let owned = 0;
        for (const file of project.rootNames) {
          if (roots.has(file)) owned += 1;
        }
        return owned > best.owned ? { index, owned } : best;
      },
      { index: -1, owned: 0 },
    ).index;
  });
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
      undefined,
      // The extension `runTsc` registers, so a project whose files are all
      // `.mx` still counts as having root files (`Deferred`: without a script
      // kind the `include` glob ignores `.mx`).
      [
        {
          extension: ".mx",
          isMixedContent: false,
          scriptKind: ts.ScriptKind.Deferred,
        },
      ],
    );
    // References first: a project follows everything it depends on, which is
    // tsc's own build order and decides who owns a file two programs both hold.
    for (const reference of parsed.projectReferences ?? []) {
      visit(ts.resolveProjectReferencePath(reference));
    }
    projects.push({
      tsconfigPath,
      hasFiles: parsed.fileNames.length > 0,
      rootNames: parsed.fileNames,
    });
  };
  for (const root of resolveProjectTsconfigs(argv, cwd)) visit(root);
  return projects;
}
