/**
 * The Angular template pass, re-run for every watch rebuild.
 *
 * `tsc -w` returns from `executeCommandLine` after its first build and then
 * rebuilds on its own, so nothing of `mx-tsc` runs again after the pass the
 * entry point makes once: a `.ng.mx` broken while the watcher runs was never
 * checked again, and the rebuild that noticed it reported "Found 0 errors".
 * That is the silent pass this module closes.
 *
 * The rebuild loop is TypeScript's, and it is synchronous, so the pass (which
 * is synchronous too) has to run inside it. The one place it reaches a caller
 * on every rebuild, at the exact moment its diagnostics for that rebuild are
 * complete, is the watch summary it writes:
 *
 *     10:42:50 PM - Found 0 errors. Watching for file changes.
 *
 * That line is intercepted, the template pass is run over the compiles of the
 * programs of this run, its diagnostics are printed before the summary, and
 * the summary's count is rewritten with the errors the pass found — so one
 * rebuild reads as one rebuild, with the templates in it. The same interception
 * covers the first build, which today reports its template errors after a
 * summary that says otherwise.
 *
 * That summary is TypeScript's English text, so a localized `tsc` (`--locale
 * de`) does not match it. The seam the rebuild offers is not reachable from
 * here: the watch compiler host that carries `afterProgramCreate` is not the
 * `CompilerHost` the language plugins are handed (`_tsc.js` builds the former
 * with `createCompilerHostFromProgramHost`, a separate object), and reaching it
 * would mean rewriting `_tsc.js` on disk. So a rebuild whose summary is not
 * recognized is reported instead of skipped: {@link rebuildActivity} marks that
 * a rebuild read files, and a write after that with no recognized summary says
 * so out loud, once per rebuild. Never silently.
 */

import type { CompiledNgMx } from "@mxlang/typescript-plugin";
import { matchProjects, resolveBuildProjects } from "./build-templates.ts";
import {
  checkNgMxGroups,
  checkNgMxProjects,
  type NgDiagnosticsResult,
  type NgProgram,
} from "./ng-diagnostics.ts";

/**
 * tsc's own watch summary, whole: the timestamp it prefixes (`10:42:50 PM - ` or
 * `[10:42:50 PM] `) and the newlines it ends with are part of it. Anchored on
 * both ends so it cannot fire on a *diagnostic* whose message happens to quote
 * the line (a test asserting on this output compiles under `mx-tsc` too), and
 * matched against what tsc writes in one piece, not a partial write.
 */
const WATCH_SUMMARY =
  /(?:^|\r?\n| - |\] )(Found (\d+) errors?\. Watching for file changes\.)\r?\n+$/;

/** Printed once per rebuild whose summary this pass did not recognize. */
export const MISSED_REBUILD =
  "error mxlang: the Angular template pass missed this rebuild: tsc's watch " +
  "summary was not recognized (a localized `tsc --locale` writes it in " +
  "another language), so these templates were not checked now.\n";

export interface WatchTemplatePassOptions {
  /** `tsc`'s command line, as `parseBuildMode` reads it. */
  argv: readonly string[];
  cwd: string;
  /** Whether `argv` is a `tsc -b` run, whose projects each need their own pass. */
  build: boolean;
  /**
   * The programs tsc created so far, each holding that program's `.ng.mx`
   * compiles. Filled in place as tsc runs, and pruned by every pass to the
   * newest program of each project, so a watcher of any age holds no more than
   * one program per project (see {@link prunePrograms}).
   */
  programs: NgProgram[];
  /**
   * Prints one pass's result (`reportNgDiagnostics`) and returns how many
   * errors it printed, so the summary can count them. Runs inside tsc's own
   * write, before the summary line goes out.
   */
  report: (result: NgDiagnosticsResult) => number;
}

export interface WatchTemplatePass {
  /**
   * Whether any rebuild summary has been intercepted, so the pass has run at
   * least once. A watch run that never printed one falls back to the entry
   * point's own single pass, so templates are never silently unchecked.
   */
  readonly ran: boolean;
}

const EMPTY: NgDiagnosticsResult = { reports: [], errors: [], warnings: [] };

/**
 * Rebuilds this process is in the middle of, seen from the compiler host: a
 * watch rebuild re-reads the files it changed through `getSourceFile`
 * (`getSourceFileByPath` is removed in watch mode, so that is the path every
 * rebuild takes — see `virtualFilesInWatchRebuilds`).
 *
 * Marked here, acted on in the interceptor: a write that follows such a rebuild
 * and is not a summary it recognizes means this pass did not run for it, which
 * is said out loud rather than passed over.
 */
let rebuilding = false;
let reportedMiss = false;

export function rebuildActivity(
  host: { getSourceFile?: unknown } | undefined,
): void {
  const getSourceFile = host?.getSourceFile;
  if (typeof getSourceFile !== "function" || !host) return;
  host.getSourceFile = (...args: unknown[]) => {
    rebuilding = true;
    reportedMiss = false;
    return (getSourceFile as (...a: unknown[]) => unknown)(...args);
  };
}

/**
 * `text` with the watch summary's error count raised by `added`, or
 * `undefined` when `text` is not a summary. Only the count changes: tsc's own
 * timestamp prefix and newlines stand, and tsc's singular form for exactly one
 * error is kept.
 */
export function recountWatchSummary(
  text: string,
  added: number,
): string | undefined {
  const summary = WATCH_SUMMARY.exec(text);
  if (!summary) return undefined;
  // SAFETY: the only `exec` that returns a match matched both groups, so they
  // are never undefined here; the checks keep that a type-checkable fact.
  const whole = summary[0];
  const message = summary[1];
  const count = summary[2];
  if (whole === undefined || message === undefined || count === undefined) {
    return undefined;
  }
  const total = Number(count) + added;
  const recounted = message.replace(
    /Found \d+ errors?\./,
    `Found ${total} ${total === 1 ? "error" : "errors"}.`,
  );
  const at = summary.index;
  // `whole` is the whole match: the status line's own prefix (the newlines
  // before it, ` - ` or `] `) and its trailing newlines. Only the message
  // between them changes.
  const from = whole.indexOf(message);
  return `${text.slice(0, at + from)}${recounted}${whole.slice(from + message.length)}${text.slice(at + whole.length)}`;
}

/**
 * Runs the Angular template pass once per watch rebuild, from
 * {@link WATCH_SUMMARY}, over the `.ng.mx` compiles of every program this run
 * created. Returns the handle the entry point uses to tell whether the pass
 * ever ran.
 *
 * The interceptor goes on `process.stdout.write`, because that is where `tsc`
 * ends up: the system object `tsc` writes through is its own (`_tsc.js`,
 * `write(s) { process.stdout.write(s); }`), not the `typescript` module's `sys`
 * a caller can reach. Only the summary line is acted on; every other write,
 * including `mx-tsc`'s own, passes through untouched, and the pass's own
 * output is written past it (it runs with the interceptor marked busy).
 */
export function installWatchTemplatePass(
  options: WatchTemplatePassOptions,
): WatchTemplatePass {
  const stdout = process.stdout;
  const originalWrite = stdout.write.bind(stdout);
  const pass: { ran: boolean } = { ran: false };
  let busy = false;
  stdout.write = ((chunk, ...writeArgs) => {
    const write = originalWrite as (...args: unknown[]) => boolean;
    const text = typeof chunk === "string" ? chunk : undefined;
    const summary = text === undefined ? null : WATCH_SUMMARY.exec(text);
    const passThrough = () => write(chunk, ...writeArgs);
    // Any other write after a rebuild read files, with no summary this pass
    // recognized (a localized `tsc --locale`): say the templates went
    // unchecked, once per rebuild, instead of passing over it in silence.
    if (!summary || text === undefined || busy) {
      if (!busy && rebuilding && !reportedMiss) {
        reportedMiss = true;
        process.stderr.write(MISSED_REBUILD);
      }
      return passThrough();
    }
    busy = true;
    try {
      const errors = options.report(checkWatchTemplates(options));
      pass.ran = true;
      rebuilding = false;
      const recounted =
        errors === 0 ? undefined : recountWatchSummary(text, errors);
      return recounted === undefined
        ? passThrough()
        : write(recounted, ...writeArgs);
    } catch (cause) {
      // tsc's own summary is the one thing a crashed pass must not swallow:
      // report the crash and write what tsc would have written.
      process.stderr.write(
        `error mxlang: the Angular template pass failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return passThrough();
    } finally {
      busy = false;
    }
  }) as typeof process.stdout.write;
  return pass;
}

/**
 * The pass over the compiles of every program of this run, each project's files
 * under that project's own tsconfig.
 */
export function checkWatchTemplates(
  options: WatchTemplatePassOptions,
): NgDiagnosticsResult {
  if (!options.build) {
    const program = options.programs.at(-1);
    const entries = [
      ...new Map(
        (program?.getCompiledNgMx() ?? []).map(
          (entry) => [entry.fileName, entry] as const,
        ),
      ).values(),
    ];
    if (entries.length === 0) return EMPTY;
    prunePrograms(options, [program as NgProgram]);
    // One program, so one tsconfig: the same resolution the non-watch path
    // uses, never a guess at which project owns what.
    return checkNgMxProjects(entries, options.argv, options.cwd);
  }
  const projects = resolveBuildProjects(options.argv, options.cwd).filter(
    (project) => project.hasFiles,
  );
  const owner = matchProjects(
    projects,
    options.programs.map((program) => program.rootNames),
  );
  // Newest program of each project wins, so a file is checked as the last
  // program compiled it; `-1` collects the programs no project owns.
  const newest = new Map<number, NgProgram>();
  owner.forEach((index, at) => {
    newest.set(index, options.programs[at] as NgProgram);
  });
  prunePrograms(options, newest.values());

  const byProject = new Map<string, Map<string, CompiledNgMx>>();
  const unchecked: string[] = [];
  for (const [index, program] of newest) {
    const project = projects[index];
    const compiled = program.getCompiledNgMx();
    if (!project) {
      unchecked.push(...compiled.map((entry) => entry.fileName));
      continue;
    }
    // Looked up per entry, so a project's file list keeps every one of them.
    let files = byProject.get(project.tsconfigPath);
    if (!files) {
      files = new Map();
      byProject.set(project.tsconfigPath, files);
    }
    for (const entry of compiled) files.set(entry.fileName, entry);
  }
  const result = checkNgMxGroups(
    [...byProject].map(([tsconfigPath, files]) => ({
      tsconfigPath,
      entries: [...files.values()],
    })),
  );
  // A compile no project of the graph owns would otherwise read as a clean
  // rebuild; say which files went unchecked instead.
  for (const file of unchecked) {
    result.errors.push(
      `${file}: no project of the build graph owns it, so its templates were not checked`,
    );
  }
  return result;
}

/**
 * Keeps only the programs this run still needs: the newest of each project, and
 * nothing else. Without it a watcher appends a program per rebuild forever, and
 * the older ones hold compiles of files since deleted or renamed.
 */
function prunePrograms(
  options: WatchTemplatePassOptions,
  keep: Iterable<NgProgram>,
): void {
  const kept = new Set(keep);
  options.programs.length = 0;
  options.programs.push(...[...kept].filter((p) => p !== undefined));
}
