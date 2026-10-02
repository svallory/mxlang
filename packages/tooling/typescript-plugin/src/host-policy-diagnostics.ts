import {
  type HostPolicy,
  type HostPolicyDiagnostic,
  resolveHostPolicyDetailed,
} from "@mxlang/core";

/**
 * The TS code of a host-policy diagnostic (an unknown `mx.host`, a malformed
 * `package.json`). Next to `TS80001` (compile error) and `TS80002` (compile
 * warning). Always a warning: nothing that built before may start failing.
 */
export const HOST_POLICY_DIAGNOSTIC_CODE = 80003;

/**
 * The text of a host-policy diagnostic reported somewhere other than the
 * `package.json` itself: core's message plus the position it carries, 1-based
 * like every editor and `tsc` shows one.
 */
export function hostPolicyMessage(diagnostic: HostPolicyDiagnostic): string {
  return `${diagnostic.message} (${diagnostic.file}:${diagnostic.line}:${diagnostic.column + 1})`;
}

/**
 * What one language plugin instance has learned about host policies. Plain
 * per-instance state (tsserver hosts several projects per process, each with
 * its own plugin), never a process-global listener.
 */
export interface HostPolicyRecorder {
  /**
   * Resolves `fileName`'s host policy and keeps what that said, replacing
   * what an earlier compile of the same file recorded (a fixed `package.json`
   * stops being reported).
   */
  resolve(fileName: string): HostPolicy;
  /** One file's diagnostics, or every recorded file's. */
  get(fileName?: string): HostPolicyDiagnostic[];
}

export function createHostPolicyRecorder(): HostPolicyRecorder {
  const byFile = new Map<string, HostPolicyDiagnostic[]>();
  return {
    resolve(fileName) {
      const { policy, diagnostics } = resolveHostPolicyDetailed(fileName);
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
