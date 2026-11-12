/**
 * `mx-angular ng-build`: `mx-angular build`, then the project's own `ng build`,
 * with each name MX generated for a `<const>` or `<define>` (`__mxConst_a`)
 * printed as the name the author wrote in Angular's diagnostics.
 *
 * Plain `ng build` runs on the files `mx-angular build` wrote, with no MX layer
 * in between, so it prints the generated names. This wraps it rather than
 * changing what is emitted (the DOM and the i18n message ids stay as they are).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildResult } from "./build.ts";

/**
 * `text` with every generated name replaced by its authored one.
 *
 * `names` is `BuildResult.authoredNames`: per emitted file, generated name to
 * authored name. Angular's text does not reliably say which file a message is
 * about (esbuild prints the message before its location), so the files' maps
 * are merged. A generated name that two files give different authored names is
 * left as printed rather than guessed.
 */
export function rewriteGeneratedNames(
  text: string,
  names: BuildResult["authoredNames"],
): string {
  const merged = new Map<string, string | null>();
  for (const file of Object.values(names)) {
    for (const [generated, authored] of Object.entries(file)) {
      const known = merged.get(generated);
      merged.set(
        generated,
        known === undefined || known === authored ? authored : null,
      );
    }
  }
  let result = text;
  for (const [generated, authored] of merged) {
    if (authored === null) continue;
    result = result.replace(
      new RegExp(
        `(?<![\\w$])${generated.replace(/\$/g, "\\$")}(?![\\w$])`,
        "g",
      ),
      () => authored,
    );
  }
  return result;
}

/** The project's `ng` binary (`node_modules/.bin/ng`, here or above), else `ng` on PATH. */
export function findNg(projectDir: string): string {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ".bin", "ng");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return "ng";
  }
}

/** Runs `ng build <ngArgs>` in `projectDir`, printing its output with generated names rewritten; returns its exit code. */
export function runNg(
  projectDir: string,
  ngArgs: string[],
  names: BuildResult["authoredNames"],
): number {
  const run = spawnSync(findNg(projectDir), ["build", ...ngArgs], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) {
    console.error(`could not run ng: ${run.error.message}`);
    return 1;
  }
  process.stdout.write(rewriteGeneratedNames(run.stdout ?? "", names));
  process.stderr.write(rewriteGeneratedNames(run.stderr ?? "", names));
  return run.status ?? 1;
}
