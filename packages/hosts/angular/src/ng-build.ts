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

/**
 * Whether `line` underlines a code-frame line: spaces, `^` and `~` with at
 * least one mark, behind the `╵` gutter mark esbuild (Angular's application
 * builder) prints, or with none (tsc's frame).
 */
function isCaretLine(line: string): boolean {
  return /^ *╵?[ ^~]*[\^~][ ^~]*$/.test(line);
}

/**
 * `caret` with its columns kept under the same text after a rewrite changed the
 * source line's length: a shortened name drops the columns it no longer needs
 * (so its underline shrinks with it), a lengthened one gets as many back (the
 * underline's mark where the name was underlined, spaces where it was not).
 * Edits are in input order; they are applied last to first so earlier columns
 * stay valid.
 */
function realignCarets(caret: string, edits: NameEdit[]): string {
  let result = caret;
  for (const edit of [...edits].reverse()) {
    const drop = edit.removed - edit.added;
    if (drop > 0) {
      const from = Math.min(edit.index + edit.added, result.length);
      result = result.slice(0, from) + result.slice(from + drop);
    } else if (drop < 0) {
      const at = Math.min(edit.index + edit.removed, result.length);
      const under = result[edit.index];
      const fill = under === "^" || under === "~" ? under : " ";
      result = result.slice(0, at) + fill.repeat(-drop) + result.slice(at);
    }
  }
  return result;
}

/**
 * Forwards `source` to `sink` a line at a time, rewritten, so a long build
 * prints as it runs and a name split across two reads is still one name. An
 * underline of `^`/`~` under a rewritten line is realigned to it, in esbuild's
 * frame (`  3 │ @let …` over `    ╵ ~~~`) and tsc's; a line printed with colour
 * escapes (`FORCE_COLOR`) is not realigned. A rewritten line waits for its
 * underline only until the stream is idle, so a diagnostic that ends a
 * rebuild's output is printed without waiting for the next one. Resolves when
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
      if (
        held &&
        !held.text.includes("\x1b") &&
        isCaretLine(raw.replace(/\r?\n$/, ""))
      ) {
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
      // The underline, if there is one, came in the same read; a line still
      // held once the loop is idle has none coming soon.
      if (held) setImmediate(release);
    });
    source.on("end", finish);
    source.on("close", finish);
    source.on("error", finish);
  });
}

/** The command that runs the project's Angular CLI: its `bin/ng.js` under this node, else `ng` on the PATH. */
function ngCommand(projectDir: string): {
  command: string;
  prefix: string[];
  local: boolean;
} {
  try {
    const ngJs = createRequire(join(projectDir, "package.json")).resolve(
      "@angular/cli/bin/ng.js",
    );
    return { command: process.execPath, prefix: [ngJs], local: true };
  } catch {
    return { command: "ng", prefix: [], local: false };
  }
}

/** Runs `ng build <ngArgs>` in `projectDir`, streaming its output with generated names rewritten; resolves to its exit code. */
export function runNg(
  projectDir: string,
  ngArgs: string[],
  names: BuildResult["authoredNames"],
): Promise<number> {
  const rewrite = rewriterFor(names);
  const { command, prefix, local } = ngCommand(projectDir);
  if (!local && process.platform === "win32") {
    // A PATH `ng` is `ng.cmd` there, which cannot run without a shell.
    console.error(
      `could not run ng: @angular/cli was not found in ${projectDir}; install it in the project`,
    );
    return Promise.resolve(1);
  }
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
