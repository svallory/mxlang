import type { TargetPolicy, TargetPolicyDiagnostic } from "@mxlang/core";
import { resolveTargetPolicyDetailed } from "@mxlang/target-registry";
import type { MxCompileDiagnostic } from "./language.ts";

/**
 * The TS code of a policy diagnostic. Existing host/manifest problems are
 * warnings; invalid targets and mismatches are errors. Next to `TS80001`
 * (compile error/policy pointer) and `TS80002` (compile warning).
 */
export const HOST_POLICY_DIAGNOSTIC_CODE = 80003;

/** Policy diagnostics that say the selected target could not be loaded. */
export const LOAD_FAILURE_CODES: ReadonlySet<string> = new Set([
  "target-not-found",
  "target-load-failed",
  "target-invalid-descriptor",
  "host-invalid-descriptor",
]);

/**
 * Core's message with its own leading `<package.json> ` removed: wherever a
 * diagnostic is printed, the path is already its location, so it is said once.
 */
export function hostPolicyText(diagnostic: TargetPolicyDiagnostic): string {
  const own = `${diagnostic.file} `;
  return diagnostic.message.startsWith(own)
    ? diagnostic.message.slice(own.length)
    : diagnostic.message;
}

/**
 * The text of a host-policy diagnostic reported somewhere other than the
 * `package.json` itself: `<package.json>:line:col: <message>`, 1-based like
 * every editor and `tsc` shows a position. The language server prints the
 * same text.
 */
export function hostPolicyMessage(diagnostic: TargetPolicyDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column + 1}: ${hostPolicyText(diagnostic)}`;
}

/**
 * What one language plugin instance has learned about host policies. Plain
 * per-instance state (tsserver hosts several projects per process, each with
 * its own plugin), never a process-global listener.
 */
export interface TargetPolicyRecorder {
  /**
   * Resolves `fileName`'s host policy and keeps what that said, replacing
   * what an earlier compile of the same file recorded (a fixed `package.json`
   * stops being reported).
   */
  resolve(fileName: string, source?: string): TargetPolicy;
  /** Store authored text without re-resolving (or repeating alias warnings). */
  source(fileName: string, source: string): void;
  /** One file's diagnostics, or every recorded file's. */
  get(fileName?: string): TargetPolicyDiagnostic[];
  /** TS80001 pointers to policy errors, at the document's start. */
  errors(fileName?: string): MxCompileDiagnostic[];
}

export function createTargetPolicyRecorder(): TargetPolicyRecorder {
  const byFile = new Map<string, TargetPolicyDiagnostic[]>();
  const sources = new Map<string, string>();
  return {
    source(fileName, source) {
      sources.set(fileName, source);
    },
    resolve(fileName, source) {
      const { policy, diagnostics } = resolveTargetPolicyDetailed(fileName);
      byFile.set(fileName, diagnostics);
      if (source !== undefined) sources.set(fileName, source);
      return policy;
    },
    errors(fileName) {
      const entries =
        fileName === undefined
          ? [...byFile]
          : [[fileName, byFile.get(fileName) ?? []] as const];
      return entries.flatMap(([name, diagnostics]) =>
        diagnostics
          // An invalid `defaultTag` does not stop the target loading and the
          // page still compiles with the next rung: the `package.json`
          // diagnostic carries the error, and a per-file pointer saying
          // "target not loaded" would be false (once per file).
          .filter(
            (diagnostic) =>
              diagnostic.severity === "error" &&
              diagnostic.code !== "invalid-default-tag",
          )
          .map((diagnostic) => ({
            fileName: name,
            source: sources.get(name) ?? "",
            offset: 0,
            category: "error" as const,
            message: `target ${diagnostic.code === "target-host-mismatch" ? "not resolved" : "not loaded"}: see ${diagnostic.file}(${diagnostic.line},${diagnostic.column + 1})`,
          })),
      );
    },
    get(fileName) {
      return fileName === undefined
        ? [...byFile.values()].flat()
        : (byFile.get(fileName) ?? []);
    },
  };
}
