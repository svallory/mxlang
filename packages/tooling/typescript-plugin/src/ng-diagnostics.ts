/**
 * Angular template diagnostics for `.ng.mx` in the editor.
 *
 * The checker is slow (seconds) and synchronous, so it never runs in the
 * tsserver thread: each Angular project gets one worker process
 * (`@mxlang/angular-checker`'s `createCheckerWorker`), and this service decides
 * *when* to ask it, and what to do with the answer:
 *
 * - `mx.angular.diagnostics` (package.json): `"idle"` (default) checks 1 s
 *   after the last edit, `"save"` only when the file is saved, `"off"` never.
 *   Never per keystroke.
 * - Results are delivered asynchronously. A result is shown only while the
 *   file still has the text it was computed for; a superseded run's result is
 *   dropped (the worker client also refuses to deliver it).
 * - A project that cannot be checked (no usable compiler-cli, bad tsconfig)
 *   and its compiler-option diagnostics are "notices": one per project, shown
 *   on the first file that hit them, never repeated on the others.
 */

import { dirname, join } from "node:path";
import { readAngularConfig } from "@mxlang/angular";
import {
  type CheckerWorker,
  type CheckerWorkerOptions,
  createCheckerWorker,
  mapNgMxDiagnostics,
  type NgMxDiagnostic,
} from "@mxlang/angular-checker";
import type * as ts from "typescript";
import { type CompiledNgMx, nearestPackageDir } from "./language.ts";

/** How long the file must be quiet before `"idle"` mode checks it. */
export const IDLE_DELAY_MS = 1_000;

/** What to tell the user after they fix an unusable compiler-cli. */
export const RESTART_HINT =
  'After fixing it, restart the TS server (VS Code: "TypeScript: Restart TS Server").';

export interface NgNotice {
  message: string;
  category: "error" | "warning";
}

export interface NgDiagnosticsDeps {
  /** Absolute path to the worker entry (`ng-worker.cjs` next to the plugin). */
  workerPath: string;
  /** The tsconfig the editor's project uses, if it is a configured project. */
  tsconfigPath?: string | undefined;
  createWorker?: (options: CheckerWorkerOptions) => CheckerWorker;
  /** Watch a file for writes (`"save"` mode). */
  watchFile?: (fileName: string, onChange: () => void) => { close(): void };
  /**
   * Whether the editor has `fileName` open. Checks, timers and watchers exist
   * only for open files: the program also compiles every closed `.ng.mx` it
   * holds, and checking those would queue the open file behind them.
   */
  isOpen?: (fileName: string) => boolean;
  /** Ask the editor to re-request diagnostics. */
  refresh?: () => void;
  log?: (message: string) => void;
  graceMs?: number;
}

export interface NgDiagnosticsService {
  /** A `.ng.mx` was (re)compiled: schedule a check per the project's mode. */
  notifyCompiled(entry: CompiledNgMx): void;
  /**
   * The editor is asking for `fileName`'s diagnostics: a file that was
   * compiled before it was opened is scheduled now, and files that have since
   * closed lose their timers and watchers.
   */
  request(fileName: string): void;
  /** The latest Angular diagnostics for `fileName`, if they fit its text. */
  getDiagnostics(
    fileName: string,
  ): { source: string; diagnostics: NgMxDiagnostic[] } | undefined;
  /**
   * The project's notices, for any open `.ng.mx` the editor asks about. They
   * are computed once per project and shown on every open file, so closing
   * one file never takes them away from the others.
   */
  getNotices(fileName: string): NgNotice[];
  dispose(): void;
}

interface ProjectState {
  dir: string;
  worker?: CheckerWorker;
  /** Sticky: the project cannot be checked; the notice was shown. */
  unavailable: boolean;
  configAsked: boolean;
  notices: NgNotice[];
}

export function createNgDiagnosticsService(
  deps: NgDiagnosticsDeps,
): NgDiagnosticsService {
  const createWorker = deps.createWorker ?? createCheckerWorker;
  const refresh = deps.refresh ?? (() => {});
  const isOpen = deps.isOpen ?? (() => true);
  const log = deps.log ?? (() => {});
  const projects = new Map<string, ProjectState>();
  const latest = new Map<string, CompiledNgMx>();
  const results = new Map<
    string,
    { entry: CompiledNgMx; diagnostics: NgMxDiagnostic[] }
  >();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers = new Map<string, { close(): void }>();
  /** The source text each file was last scheduled (or ran) for. */
  const scheduled = new Map<string, string>();
  let disposed = false;

  function modeOf(dir: string): "idle" | "save" | "off" {
    try {
      return readAngularConfig(dir).diagnostics;
    } catch {
      // The language plugin already reports a bad config on the file.
      return "off";
    }
  }

  function project(fileName: string): ProjectState {
    const dir = nearestPackageDir(dirname(fileName)) ?? dirname(fileName);
    let state = projects.get(dir);
    if (!state) {
      state = { dir, unavailable: false, configAsked: false, notices: [] };
      projects.set(dir, state);
    }
    return state;
  }

  function addNotice(state: ProjectState, notice: NgNotice) {
    state.notices.push(notice);
    log(`@mxlang/typescript-plugin: ${notice.message}`);
  }

  async function run(entry: CompiledNgMx): Promise<void> {
    if (disposed) return;
    if (!isOpen(entry.fileName)) return;
    const state = project(entry.fileName);
    if (state.unavailable) return;
    state.worker ??= createWorker({
      projectDir: state.dir,
      workerPath: deps.workerPath,
      ...(deps.tsconfigPath ? { tsconfigPath: deps.tsconfigPath } : {}),
      ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
    });
    const worker = state.worker;
    const outcome = await worker.check(
      `${entry.fileName}.ts`,
      entry.result.code,
    );
    if (disposed) return;

    if (outcome.kind === "unavailable") {
      if (!state.unavailable) {
        state.unavailable = true;
        const where = deps.tsconfigPath ?? join(state.dir, "package.json");
        addNotice(state, {
          message:
            outcome.reason === "compiler-cli"
              ? `${where}: ${outcome.message} ${RESTART_HINT}`
              : // A tsconfig error already leads with the tsconfig path.
                outcome.reason === "config"
                ? outcome.message
                : `${where}: ${outcome.message}`,
          category: "warning",
        });
        refresh();
      }
      return;
    }
    if (outcome.kind === "failed") {
      log(`@mxlang/typescript-plugin: ${entry.fileName}: ${outcome.message}`);
      return;
    }
    if (outcome.kind === "superseded") return;

    if (latest.get(entry.fileName)?.source !== entry.source) return;
    results.set(entry.fileName, {
      entry,
      diagnostics: mapNgMxDiagnostics(entry.result, outcome.diagnostics),
    });
    refresh();

    if (!state.configAsked) {
      state.configAsked = true;
      const config = await worker.configDiagnostics();
      if (disposed || config.kind !== "ok") return;
      const tsconfig = deps.tsconfigPath ?? join(state.dir, "package.json");
      let added = false;
      for (const d of config.diagnostics) {
        // TypeScript's own option errors come from the TypeScript pass.
        if (d.source === "ts") continue;
        addNotice(state, {
          message: `${d.file || tsconfig}: ${d.message} (code ${d.code})`,
          category: d.category === "error" ? "error" : "warning",
        });
        added = true;
      }
      if (added) refresh();
    }
  }

  /** Forget a file that is no longer open. */
  function release(fileName: string): void {
    const timer = timers.get(fileName);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(fileName);
    watchers.get(fileName)?.close();
    watchers.delete(fileName);
    scheduled.delete(fileName);
  }

  function sweep(): void {
    for (const fileName of new Set([...timers.keys(), ...watchers.keys()])) {
      if (!isOpen(fileName)) release(fileName);
    }
  }

  /** Arm the trigger for an open file's latest compile, once per text. */
  function schedule(entry: CompiledNgMx): void {
    const { fileName } = entry;
    if (!isOpen(fileName)) {
      release(fileName);
      return;
    }
    const mode = modeOf(project(fileName).dir);
    if (mode === "off") return;
    if (mode === "idle") {
      const pending = timers.get(fileName);
      if (pending !== undefined) clearTimeout(pending);
      scheduled.set(fileName, entry.source);
      const timer = setTimeout(() => {
        timers.delete(fileName);
        const current = latest.get(fileName);
        if (current && isOpen(fileName)) void run(current);
        else release(fileName);
      }, IDLE_DELAY_MS);
      // unref: a pending check must not keep a host process alive.
      timer.unref?.();
      timers.set(fileName, timer);
      return;
    }
    // "save": a write to the file is the trigger.
    scheduled.set(fileName, entry.source);
    if (deps.watchFile && !watchers.has(fileName)) {
      watchers.set(
        fileName,
        deps.watchFile(fileName, () => {
          const current = latest.get(fileName);
          if (current && isOpen(fileName)) void run(current);
          else release(fileName);
        }),
      );
    }
  }

  return {
    notifyCompiled(entry) {
      if (disposed) return;
      latest.set(entry.fileName, entry);
      schedule(entry);
    },

    request(fileName) {
      if (disposed) return;
      sweep();
      const entry = latest.get(fileName);
      if (entry && scheduled.get(fileName) !== entry.source) schedule(entry);
    },

    getDiagnostics(fileName) {
      const result = results.get(fileName);
      if (!result || latest.get(fileName)?.source !== result.entry.source) {
        return undefined;
      }
      return { source: result.entry.source, diagnostics: result.diagnostics };
    },

    getNotices(fileName) {
      return isOpen(fileName) ? project(fileName).notices : [];
    },

    dispose() {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers.values()) w.close();
      watchers.clear();
      for (const p of projects.values()) p.worker?.dispose();
    },
  };
}

/** The four-way category map `mx-tsc` uses (`tsc/src/index.ts`). */
const DIAGNOSTIC_CATEGORIES = (typescript: typeof ts) =>
  ({
    error: typescript.DiagnosticCategory.Error,
    warning: typescript.DiagnosticCategory.Warning,
    suggestion: typescript.DiagnosticCategory.Suggestion,
    message: typescript.DiagnosticCategory.Message,
  }) as const;

/**
 * The Angular diagnostics (and project notices) for a `.ng.mx`, as TypeScript
 * diagnostics with `source: "angular"`. A degraded position says so, like
 * `mx-tsc` does.
 */
export function angularDiagnostics(
  typescript: typeof ts,
  ng: NgDiagnosticsService,
  fileName: string,
): ts.Diagnostic[] {
  const result = ng.getDiagnostics(fileName);
  const out: ts.Diagnostic[] = [];
  const file = (text: string) =>
    typescript.createSourceFile(
      fileName,
      text,
      typescript.ScriptTarget.Latest,
      false,
      typescript.ScriptKind.TS,
    );
  if (result) {
    const sourceFile = file(result.source);
    for (const d of result.diagnostics) {
      out.push({
        file: sourceFile,
        start: d.start,
        length: d.length,
        category: DIAGNOSTIC_CATEGORIES(typescript)[d.category],
        code: d.code,
        source: "angular",
        messageText:
          d.mapped === "exact"
            ? d.message
            : `${d.message} (approximate location)`,
      });
    }
  }
  for (const notice of ng.getNotices(fileName)) {
    out.push({
      file: file(""),
      start: 0,
      length: 0,
      category:
        notice.category === "error"
          ? typescript.DiagnosticCategory.Error
          : typescript.DiagnosticCategory.Warning,
      code: 80003,
      source: "angular",
      messageText: notice.message,
    });
  }
  return out;
}
