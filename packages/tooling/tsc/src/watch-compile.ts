/**
 * The MX compile diagnostics of a watch run, as they stand after a rebuild.
 *
 * A language plugin keeps its diagnostics per file, replacing a file's entry
 * every time it compiles that file. But Volar creates a fresh set of plugins
 * whenever the program's root files or options change (a file added to the
 * project), and a file the rebuild did not re-read (its source is unchanged) is
 * never compiled by the new set: its diagnostics stay in the older one. So the
 * answer for one file is the newest plugin set that compiled it, and the older
 * sets only answer for the files no newer set touched. Reading every plugin
 * ever created would keep an error alive after the edit that fixed it.
 */

import { existsSync } from "node:fs";
import type {
  MxCompileDiagnostic,
  MxDiagnosticLanguagePlugin,
  TargetPolicyDiagnostic,
} from "@mxlang/typescript-plugin";

/** The plugins one `createProgram` of a watch run made, and the files they compiled. */
export interface PluginGeneration {
  readonly plugins: readonly MxDiagnosticLanguagePlugin[];
  /** Every file one of the plugins was asked to compile, empty answers included. */
  readonly touched: ReadonlySet<string>;
}

/**
 * Records which files `plugins` compile, so a file that compiled clean
 * supersedes the error an older plugin set still holds for it. The plugins are
 * wrapped in place; what they compile and return is untouched.
 */
export function trackGeneration(
  plugins: readonly MxDiagnosticLanguagePlugin[],
): PluginGeneration {
  const touched = new Set<string>();
  for (const plugin of plugins) {
    const create = plugin.createVirtualCode?.bind(plugin);
    if (!create) continue;
    plugin.createVirtualCode = (fileName, ...rest) => {
      touched.add(fileName);
      return create(fileName, ...rest);
    };
  }
  return { plugins, touched };
}

/**
 * The compile diagnostics that hold now: for each file, those of the newest
 * generation that compiled it. A file that no longer exists has none. A
 * generation that supplies nothing any newer one has not already settled is
 * dropped from `generations`, so a long-lived watcher holds no dead plugin set.
 */
export function currentCompileDiagnostics(
  generations: PluginGeneration[],
): MxCompileDiagnostic[] {
  const settled = new Set<string>();
  const current: MxCompileDiagnostic[] = [];
  for (let at = generations.length - 1; at >= 0; at--) {
    const generation = generations[at] as PluginGeneration;
    let contributed = false;
    const settle = (
      fileName: string,
      diagnostics: readonly MxCompileDiagnostic[],
    ) => {
      if (settled.has(fileName)) return;
      settled.add(fileName);
      contributed = true;
      current.push(...diagnostics);
    };
    for (const fileName of generation.touched) {
      settle(
        fileName,
        generation.plugins.flatMap((plugin) =>
          plugin.getCompileDiagnostics(fileName),
        ),
      );
    }
    // An entry a compile stored under another file (a template's, set by the
    // file that calls it) belongs to the generation that stored it.
    const stored = new Map<string, MxCompileDiagnostic[]>();
    for (const plugin of generation.plugins) {
      for (const diagnostic of plugin.getCompileDiagnostics()) {
        const list = stored.get(diagnostic.fileName) ?? [];
        list.push(diagnostic);
        stored.set(diagnostic.fileName, list);
      }
    }
    for (const [fileName, diagnostics] of stored) {
      settle(fileName, diagnostics);
    }
    // A generation that settled nothing is dropped, except the newest: it is
    // the live plugin set, and its next compile (a rebuild that only removed a
    // root file compiles nothing) must still be read.
    if (!contributed && at !== generations.length - 1) {
      generations.splice(at, 1);
    }
  }
  return current
    .filter((diagnostic) => existsSync(diagnostic.fileName))
    .sort((a, b) =>
      a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
    );
}

/**
 * The host-policy diagnostics that hold now, by the same rule as
 * {@link currentCompileDiagnostics}: for each `.mx` file, those of the newest
 * generation that compiled it (a plugin re-resolves the policy at every
 * compile, so a fixed `package.json` stops being reported once its files are
 * compiled again). A file that no longer exists has none, and a policy two
 * files share is reported once. Read-only: pruning is the compile pass's.
 */
export function currentPolicyDiagnostics(
  generations: readonly PluginGeneration[],
): TargetPolicyDiagnostic[] {
  const settled = new Set<string>();
  const current = new Map<string, TargetPolicyDiagnostic>();
  for (let at = generations.length - 1; at >= 0; at--) {
    const generation = generations[at] as PluginGeneration;
    for (const fileName of generation.touched) {
      if (settled.has(fileName)) continue;
      settled.add(fileName);
      if (!existsSync(fileName)) continue;
      for (const plugin of generation.plugins) {
        for (const d of plugin.getTargetPolicyDiagnostics?.(fileName) ?? []) {
          current.set(`${d.file}\0${d.message}`, d);
        }
      }
    }
  }
  return [...current.values()];
}
