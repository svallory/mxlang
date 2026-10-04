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

export interface WatchTemplatePassOptions {
  /** `tsc`'s command line, as `parseBuildMode` reads it. */
  argv: readonly string[];
  cwd: string;
  /** Whether `argv` is a `tsc -b` run, whose projects each need their own pass. */
  build: boolean;
  /**
   * The programs tsc created so far, each holding that program's `.ng.mx`
   * compiles. Filled in place as tsc runs, so this is the array the entry
   * point hands to `runPatchedTsc`.
   */
  programs: readonly NgProgram[];
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
    // Not the summary, or a nested run of ours: tsc's own output, untouched.
    if (!summary || text === undefined || busy) return passThrough();
    busy = true;
    try {
      const errors = options.report(checkWatchTemplates(options));
      pass.ran = true;
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
  const entries = [
    // A file two programs both compile (via `references`) is checked once.
    ...new Map(
      options.programs
        .flatMap((program) => program.getCompiledNgMx())
        .map((entry) => [entry.fileName, entry] as const),
    ).values(),
  ];
  if (entries.length === 0) return EMPTY;
  if (!options.build) {
    // One program, so one tsconfig: the same resolution the non-watch path
    // uses, never a guess at which project owns what.
    return checkNgMxProjects(entries, options.argv, options.cwd);
  }
  const { groups, unchecked } = buildGroups(options, entries);
  const result = checkNgMxGroups(groups);
  // A compile no project of the graph owns would otherwise read as a clean
  // rebuild; say which files went unchecked instead.
  for (const file of unchecked) {
    result.errors.push(
      `${file}: no project of the build graph owns it, so its templates were not checked`,
    );
  }
  return result;
}

interface BuildGroups {
  groups: { tsconfigPath: string; entries: CompiledNgMx[] }[];
  /** Compiles no program of the build graph claims, by file name. */
  unchecked: string[];
}

/**
 * The same file sets the non-watch `-b` path checks, keyed by the program that
 * holds each file: the build graph's projects (`resolveBuildProjects`, which
 * reads each tsconfig's own file list), each program matched back to the
 * project whose list it is, and every compile that program made checked under
 * that project's tsconfig. Two programs of one project (a rebuild creating a
 * new one) check their shared files once, as everywhere else.
 */
function buildGroups(
  options: WatchTemplatePassOptions,
  entries: readonly CompiledNgMx[],
): BuildGroups {
  const projects = resolveBuildProjects(options.argv, options.cwd).filter(
    (project) => project.hasFiles,
  );
  const owner = matchProjects(
    projects,
    options.programs.map((program) => program.rootNames),
  );
  const byProject = new Map<string, CompiledNgMx[]>();
  for (const [index, program] of options.programs.entries()) {
    const project = projects[owner[index] as number];
    if (!project) continue;
    const held = byProject.get(project.tsconfigPath);
    for (const entry of program.getCompiledNgMx()) {
      if (held) {
        if (!held.some((file) => file.fileName === entry.fileName)) {
          held.push(entry);
        }
      } else {
        byProject.set(project.tsconfigPath, [entry]);
      }
    }
  }
  const groups = [...byProject]
    .filter(([, files]) => files.length > 0)
    .map(([tsconfigPath, files]) => ({ tsconfigPath, entries: files }));
  const checked = new Set(
    groups.flatMap((group) => group.entries.map((entry) => entry.fileName)),
  );
  return {
    groups,
    unchecked: entries
      .filter((entry) => !checked.has(entry.fileName))
      .map((entry) => entry.fileName),
  };
}
