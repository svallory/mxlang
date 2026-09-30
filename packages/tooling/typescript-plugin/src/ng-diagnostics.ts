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
import { type CompiledNgMx, nearestPackageDir } from "./language.ts";

/** How long the file must be quiet before `"idle"` mode checks it. */
export const IDLE_DELAY_MS = 1_000;

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
  /** Ask the editor to re-request diagnostics. */
  refresh?: () => void;
  log?: (message: string) => void;
  graceMs?: number;
}

export interface NgDiagnosticsService {
  /** A `.ng.mx` was (re)compiled: schedule a check per the project's mode. */
  notifyCompiled(entry: CompiledNgMx): void;
  /** The latest Angular diagnostics for `fileName`, if they fit its text. */
  getDiagnostics(
    fileName: string,
  ): { source: string; diagnostics: NgMxDiagnostic[] } | undefined;
  /** Project-level messages owned by `fileName` (shown once per project). */
  getNotices(fileName: string): NgNotice[];
  dispose(): void;
}

interface ProjectState {
  dir: string;
  worker?: CheckerWorker;
  /** Sticky: the project cannot be checked; the notice was shown. */
  unavailable: boolean;
  configAsked: boolean;
  owner?: string;
  notices: NgNotice[];
}

export function createNgDiagnosticsService(
  deps: NgDiagnosticsDeps,
): NgDiagnosticsService {
  const createWorker = deps.createWorker ?? createCheckerWorker;
  const refresh = deps.refresh ?? (() => {});
  const log = deps.log ?? (() => {});
  const projects = new Map<string, ProjectState>();
  const latest = new Map<string, CompiledNgMx>();
  const results = new Map<
    string,
    { entry: CompiledNgMx; diagnostics: NgMxDiagnostic[] }
  >();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers = new Map<string, { close(): void }>();
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

  function addNotice(state: ProjectState, file: string, notice: NgNotice) {
    state.owner ??= file;
    state.notices.push(notice);
    log(`@mxlang/typescript-plugin: ${notice.message}`);
  }

  async function run(entry: CompiledNgMx): Promise<void> {
    if (disposed) return;
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
        addNotice(state, entry.fileName, {
          message: outcome.message,
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
        addNotice(state, entry.fileName, {
          message: `${d.file || tsconfig}: ${d.message} (code ${d.code})`,
          category: d.category === "error" ? "error" : "warning",
        });
        added = true;
      }
      if (added) refresh();
    }
  }

  return {
    notifyCompiled(entry) {
      if (disposed) return;
      const { fileName } = entry;
      latest.set(fileName, entry);
      const pending = timers.get(fileName);
      if (pending !== undefined) clearTimeout(pending);
      timers.delete(fileName);

      const mode = modeOf(project(fileName).dir);
      if (mode === "off") return;
      if (mode === "idle") {
        timers.set(
          fileName,
          // unref: a pending check must not keep a host process alive.
          setTimeout(() => {
            timers.delete(fileName);
            const current = latest.get(fileName);
            if (current) void run(current);
          }, IDLE_DELAY_MS),
        );
        timers.get(fileName)?.unref?.();
        return;
      }
      // "save": a write to the file is the trigger.
      if (deps.watchFile && !watchers.has(fileName)) {
        watchers.set(
          fileName,
          deps.watchFile(fileName, () => {
            const current = latest.get(fileName);
            if (current) void run(current);
          }),
        );
      }
    },

    getDiagnostics(fileName) {
      const result = results.get(fileName);
      if (!result || latest.get(fileName)?.source !== result.entry.source) {
        return undefined;
      }
      return { source: result.entry.source, diagnostics: result.diagnostics };
    },

    getNotices(fileName) {
      const state = project(fileName);
      return state.owner === fileName ? state.notices : [];
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
