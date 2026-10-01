/**
 * Which projects, and which `.ng.mx` files, a `tsc -b` run covers.
 *
 * `tsc -b` skips a project whose build info says it is up to date, and a
 * skipped project never creates a program, so Volar's language plugin never
 * compiles its `.ng.mx` files and the Angular template pass has nothing to
 * check. tsc's incremental state knows nothing about templates, so the pass
 * cannot be skipped on its say-so: this module finds every project of the
 * build graph and the `.ng.mx` files it owns, whether or not tsc rebuilt it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  type CompiledNgMx,
  createNgMxLanguagePlugin,
  type NgMxLanguagePlugin,
} from "@mxlang/typescript-plugin";
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
  const { buildOptions } = loadTypeScript().parseBuildCommand([...argv]);
  return { clean: !!buildOptions.clean, dry: !!buildOptions.dry };
}

export interface BuildProject {
  tsconfigPath: string;
  /** Absolute paths of the `.ng.mx` files the project's `include`/`files` select. */
  ngMxFiles: string[];
}

/**
 * Every project `tsc -b argv` builds: the named roots and, transitively, their
 * `references`, each once, roots first. A project that cannot be parsed is
 * skipped here (tsc reports it itself and fails the run).
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
      resolve(tsconfigPath, ".."),
      undefined,
      tsconfigPath,
      undefined,
      // The same extension `runTsc` registers, so `include` globs match (a
      // `Deferred` kind: without a script kind the glob ignores `.mx`).
      [
        {
          extension: ".mx",
          isMixedContent: false,
          scriptKind: ts.ScriptKind.Deferred,
        },
      ],
    );
    projects.push({
      tsconfigPath,
      ngMxFiles: parsed.fileNames.filter((file) => file.endsWith(".ng.mx")),
    });
    for (const reference of parsed.projectReferences ?? []) {
      visit(ts.resolveProjectReferencePath(reference));
    }
  };
  for (const root of resolveProjectTsconfigs(argv, cwd)) visit(root);
  return projects;
}

export interface BuildTemplateInputs {
  /** Per project, the `.ng.mx` compiles to check; each file under one project only. */
  groups: { tsconfigPath: string; entries: CompiledNgMx[] }[];
  /** Plugins that compiled files tsc did not; their compile diagnostics must be reported. */
  freshPlugins: NgMxLanguagePlugin[];
}

/**
 * The compiles the Angular pass checks under `-b`. A file tsc compiled this
 * run reuses that compile; every other `.ng.mx` of the graph (a project tsc
 * judged up to date) is compiled here, with no TypeScript program at all.
 */
export function collectBuildTemplateInputs(
  projects: readonly BuildProject[],
  compiled: readonly CompiledNgMx[],
): BuildTemplateInputs {
  const ts = loadTypeScript();
  const known = new Map(compiled.map((entry) => [entry.fileName, entry]));
  const claimed = new Set<string>();
  const freshPlugins: NgMxLanguagePlugin[] = [];
  const groups: BuildTemplateInputs["groups"] = [];
  for (const project of projects) {
    const entries: CompiledNgMx[] = [];
    for (const fileName of project.ngMxFiles) {
      if (claimed.has(fileName)) continue;
      claimed.add(fileName);
      let entry = known.get(fileName);
      if (!entry) {
        const plugin = createNgMxLanguagePlugin(ts, { retainCompiled: true });
        freshPlugins.push(plugin);
        plugin.createVirtualCode?.(
          fileName,
          "ng-mx",
          ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8")),
          // biome-ignore lint/suspicious/noExplicitAny: Volar's CodegenContext is unused by this plugin
          undefined as any,
        );
        entry = plugin.getCompiledNgMx().find((e) => e.fileName === fileName);
      }
      if (entry) entries.push(entry);
    }
    groups.push({ tsconfigPath: project.tsconfigPath, entries });
  }
  // Compiled by tsc but selected by no project's `include`/`files` (reached
  // through an import): still checked, under the project whose directory
  // holds it most closely, else the first.
  for (const entry of compiled) {
    if (claimed.has(entry.fileName) || groups.length === 0) continue;
    claimed.add(entry.fileName);
    let best = 0;
    let bestLength = -1;
    groups.forEach((group, index) => {
      const dir = dirname(group.tsconfigPath);
      if (entry.fileName.startsWith(`${dir}/`) && dir.length > bestLength) {
        best = index;
        bestLength = dir.length;
      }
    });
    (groups[best] as BuildTemplateInputs["groups"][number]).entries.push(entry);
  }
  return { groups, freshPlugins };
}
