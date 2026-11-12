/**
 * `mx-angular ng-build`: `mx-angular build`, then the project's own `ng build`,
 * with each name MX generated for a `<const>` or `<define>` (`__mxConst_a`)
 * printed as the name the author wrote in Angular's diagnostics.
 *
 * Plain `ng build` runs on the files `mx-angular build` wrote, with no MX layer
 * in between, so it prints the generated names. This wraps it rather than
 * changing what is emitted (the DOM and the i18n message ids stay as they are).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mergeAuthoredNames, rewriteAuthoredNames } from "./authored-names.ts";
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
  return rewriteAuthoredNames(text, mergeAuthoredNames(Object.values(names)));
}

/** The project's `ng` binary (`node_modules/.bin/ng`, here or above; `ng.cmd` on Windows), else `ng` on PATH. */
function findNg(projectDir: string): string {
  const file = process.platform === "win32" ? "ng.cmd" : "ng";
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ".bin", file);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return file;
  }
}

/** Forwards `source` to `sink` a line at a time, rewritten, so a long build prints as it runs. */
function forwardLines(
  source: NodeJS.ReadableStream,
  sink: NodeJS.WritableStream,
  names: BuildResult["authoredNames"],
): Promise<void> {
  return new Promise((done) => {
    let pending = "";
    source.setEncoding("utf8");
    source.on("data", (chunk: string) => {
      pending += chunk;
      const cut = pending.lastIndexOf("\n");
      if (cut === -1) return;
      sink.write(rewriteGeneratedNames(pending.slice(0, cut + 1), names));
      pending = pending.slice(cut + 1);
    });
    source.on("end", () => {
      if (pending) sink.write(rewriteGeneratedNames(pending, names));
      done();
    });
  });
}

/** Runs `ng build <ngArgs>` in `projectDir`, streaming its output with generated names rewritten; resolves to its exit code. */
export function runNg(
  projectDir: string,
  ngArgs: string[],
  names: BuildResult["authoredNames"],
): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn(findNg(projectDir), ["build", ...ngArgs], {
      cwd: projectDir,
      // `.cmd` files only run through a shell on Windows.
      shell: process.platform === "win32",
    });
    const drained = Promise.all([
      forwardLines(child.stdout, process.stdout, names),
      forwardLines(child.stderr, process.stderr, names),
    ]);
    child.on("error", (error) => {
      console.error(`could not run ng: ${error.message}`);
      resolveCode(1);
    });
    child.on("close", (code) => {
      void drained.then(() => resolveCode(code ?? 1));
    });
  });
}
