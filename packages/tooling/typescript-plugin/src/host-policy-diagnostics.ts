import type { TargetPolicy, TargetPolicyDiagnostic } from "@mxlang/core";
import { resolveTargetPolicyDetailed } from "@mxlang/target-registry";

/**
 * The TS code of a host-policy diagnostic (an unknown `mx.host`, a malformed
 * `package.json`). Next to `TS80001` (compile error) and `TS80002` (compile
 * warning). Always a warning: nothing that built before may start failing.
 */
export const HOST_POLICY_DIAGNOSTIC_CODE = 80003;

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
  resolve(fileName: string): TargetPolicy;
  /** One file's diagnostics, or every recorded file's. */
  get(fileName?: string): TargetPolicyDiagnostic[];
}

export function createTargetPolicyRecorder(): TargetPolicyRecorder {
  const byFile = new Map<string, TargetPolicyDiagnostic[]>();
  return {
    resolve(fileName) {
      const { policy, diagnostics } = resolveTargetPolicyDetailed(fileName);
      byFile.set(fileName, diagnostics);
      return policy;
    },
    get(fileName) {
      return fileName === undefined
        ? [...byFile.values()].flat()
        : (byFile.get(fileName) ?? []);
    },
  };
}
