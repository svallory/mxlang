import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";
import { inject } from "vitest";

export interface StrictTscPool {
  directory: string;
  limit: number;
}

declare module "vitest" {
  interface ProvidedContext {
    strictTscPool: StrictTscPool;
  }
}

/** Atomic directories share the bound across Vitest's isolated fork workers. */
async function acquire(signal: AbortSignal): Promise<() => Promise<void>> {
  const pool = inject("strictTscPool");
  if (!pool) throw new Error("The Preact strict-tsc global setup is required.");
  for (;;) {
    signal.throwIfAborted();
    for (let i = 0; i < pool.limit; i++) {
      const slot = join(pool.directory, String(i));
      try {
        await mkdir(slot);
        return () => rm(slot, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await delay(10, undefined, { signal });
  }
}

// Per isolated test file, not a cross-file/worker cache. Only dependency .d.ts
// syntax trees are reusable; every generated/mutable source is read afresh.
// Bound retained text to 16 MiB (AST overhead is measured separately by RSS).
function dependencyPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return ts.sys.useCaseSensitiveFileNames
    ? normalized
    : normalized.toLowerCase();
}
const dependencyDirectory = join(
  import.meta.dirname,
  "../../../../../node_modules",
);
const dependencyRoots = [
  dependencyDirectory,
  realpathSync(dependencyDirectory),
].map((directory) => `${dependencyPath(directory)}/`);
const declarations = new Map<string, ts.SourceFile>();
const maxCachedTextBytes = 16 * 1024 * 1024;
let cachedTextBytes = 0;
const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getCanonicalFileName: (file) =>
    ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(),
  getNewLine: () => ts.sys.newLine,
};

/**
 * Check the same generated noEmit project as `tsc -p`, with a fresh program,
 * compiler options, module resolution and diagnostics for every case. Reuse
 * only immutable dependency declaration parsing, never fixture trees/results.
 * At most two checks run across files/workers (one with one Vitest worker).
 */
export async function strictTsc(
  project: string,
  signal: AbortSignal,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const release = await acquire(signal);
  try {
    signal.throwIfAborted();
    const fatal: ts.Diagnostic[] = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(
      project,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (error) => fatal.push(error),
      },
    );
    if (!parsed) throw new Error(ts.formatDiagnostics(fatal, diagnosticHost));
    if (!parsed.options.noEmit) {
      throw new Error("The strict-tsc test harness requires a noEmit project.");
    }
    const host = ts.createCompilerHost(parsed.options);
    const readSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, fresh) => {
      const reusable =
        !fresh &&
        dependencyRoots.some((root) => dependencyPath(file).startsWith(root)) &&
        /\.d\.[cm]?ts$/.test(file);
      const key = `${file}\0${JSON.stringify([
        languageVersion,
        parsed.options.module,
        parsed.options.moduleDetection,
        parsed.options.jsx,
      ])}`;
      if (reusable) {
        const cached = declarations.get(key);
        if (cached) return cached;
      }
      const source = readSourceFile(file, languageVersion, onError, fresh);
      if (
        reusable &&
        source &&
        cachedTextBytes + source.text.length * 2 <= maxCachedTextBytes
      ) {
        declarations.set(key, source);
        cachedTextBytes += source.text.length * 2;
      }
      return source;
    };
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      host,
      projectReferences: parsed.projectReferences,
      configFileParsingDiagnostics: parsed.errors,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    signal.throwIfAborted();
    const result = {
      status: diagnostics.some(
        (error) => error.category === ts.DiagnosticCategory.Error,
      )
        ? ts.ExitStatus.DiagnosticsPresent_OutputsGenerated
        : ts.ExitStatus.Success,
      stdout: ts.formatDiagnostics(diagnostics, diagnosticHost),
      stderr: "",
    };
    return result;
  } finally {
    await release();
  }
}
