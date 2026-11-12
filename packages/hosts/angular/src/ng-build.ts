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
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  createNameRewriter,
  mergeAuthoredNames,
  type NameEdit,
} from "./authored-names.ts";
import type { BuildResult } from "./build.ts";

/** A function that prints text with each generated name as authored; see {@link rewriterFor}. */
export type NameRewriter = ReturnType<typeof createNameRewriter>;

/**
 * The rewriter for a build's names. `names` is `BuildResult.authoredNames`:
 * per emitted file, generated name to authored name. Angular's text does not
 * reliably say which file a message is about (esbuild prints the message
 * before its location), so the files' maps are merged, once. A generated name
 * that two files give different authored names is left as printed rather than
 * guessed.
 */
export function rewriterFor(names: BuildResult["authoredNames"]): NameRewriter {
  return createNameRewriter(mergeAuthoredNames(Object.values(names)));
}

/** `text` with every generated name replaced by its authored one; see {@link rewriterFor}. */
export function rewriteGeneratedNames(
  text: string,
  names: BuildResult["authoredNames"],
): string {
  return rewriterFor(names)(text);
}

/** Whether `line` is an underline under a code-frame line: only spaces, `^` and `~`, and at least one mark. */
function isCaretLine(line: string): boolean {
  return /^[ ^~]*[\^~][ ^~]*$/.test(line);
}

/**
 * `caret` with the columns a rewrite removed taken out, so the underline under
 * a shortened source line still sits under the same text: each replacement
 * drops `removed - added` columns from where its replacement ends. Edits are in
 * input order; they are applied last to first so earlier columns stay valid.
 */
function realignCarets(caret: string, edits: NameEdit[]): string {
  let result = caret;
  for (const edit of [...edits].reverse()) {
    const drop = edit.removed - edit.added;
    if (drop <= 0) continue;
    const from = Math.min(edit.index + edit.added, result.length);
    result = result.slice(0, from) + result.slice(from + drop);
  }
  return result;
}

/**
 * Forwards `source` to `sink` a line at a time, rewritten, so a long build
 * prints as it runs and a name split across two reads is still one name. An
 * underline of `^`/`~` under a rewritten line is realigned to it. Resolves when
 * `source` ends, closes or errors.
 */
export function forwardLines(
  source: NodeJS.ReadableStream,
  sink: NodeJS.WritableStream,
  rewrite: NameRewriter,
): Promise<void> {
  return new Promise((done) => {
    let pending = "";
    // A rewritten line waits for the next one, which may be its underline.
    let held: { text: string; edits: NameEdit[] } | undefined;
    const release = () => {
      if (held) sink.write(held.text);
      held = undefined;
    };
    const line = (raw: string) => {
      if (held && isCaretLine(raw.replace(/\r?\n$/, ""))) {
        const ending = /\r?\n$/.exec(raw)?.[0] ?? "";
        sink.write(held.text);
        sink.write(
          realignCarets(raw.slice(0, raw.length - ending.length), held.edits) +
            ending,
        );
        held = undefined;
        return;
      }
      release();
      const edits: NameEdit[] = [];
      const text = rewrite(raw, (edit) => edits.push(edit));
      if (edits.length > 0) held = { text, edits };
      else sink.write(text);
    };
    const finish = () => {
      if (pending) line(pending);
      pending = "";
      release();
      done();
    };
    source.setEncoding("utf8");
    source.on("data", (chunk: string) => {
      pending += chunk;
      for (
        let cut = pending.indexOf("\n");
        cut !== -1;
        cut = pending.indexOf("\n")
      ) {
        line(pending.slice(0, cut + 1));
        pending = pending.slice(cut + 1);
      }
    });
    source.on("end", finish);
    source.on("close", finish);
    source.on("error", finish);
  });
}

/** The command that runs the project's Angular CLI: its `bin/ng.js` under this node, else `ng` on the PATH. */
function ngCommand(projectDir: string): { command: string; prefix: string[] } {
  try {
    const ngJs = createRequire(join(projectDir, "package.json")).resolve(
      "@angular/cli/bin/ng.js",
    );
    return { command: process.execPath, prefix: [ngJs] };
  } catch {
    return { command: "ng", prefix: [] };
  }
}

/** Runs `ng build <ngArgs>` in `projectDir`, streaming its output with generated names rewritten; resolves to its exit code. */
export function runNg(
  projectDir: string,
  ngArgs: string[],
  names: BuildResult["authoredNames"],
): Promise<number> {
  const rewrite = rewriterFor(names);
  const { command, prefix } = ngCommand(projectDir);
  return new Promise((resolveCode) => {
    // No shell: a path or an argument with a space or `&` reaches `ng` as written.
    const child = spawn(command, [...prefix, "build", ...ngArgs], {
      cwd: projectDir,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const drained = Promise.all([
      forwardLines(child.stdout, process.stdout, rewrite),
      forwardLines(child.stderr, process.stderr, rewrite),
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
