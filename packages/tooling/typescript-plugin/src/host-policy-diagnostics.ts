import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MX_CONFIG_SEARCH_PLACES,
  type TargetPolicy,
  type TargetPolicyDiagnostic,
} from "@mxlang/core";
import { resolveTargetPolicyDetailed } from "@mxlang/targets";
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
  /**
   * Re-resolves `fileName` when a manifest or config its policy reads changed
   * since it was resolved; true when it did. Called once per diagnostics
   * request by the tsserver entry point, never by `get`/`errors`.
   */
  refresh(fileName: string): boolean;
  /** Store authored text without re-resolving (or repeating alias warnings). */
  source(fileName: string, source: string): void;
  /** One file's diagnostics, or every recorded file's. */
  get(fileName?: string): TargetPolicyDiagnostic[];
  /** TS80001 pointers to policy errors, at the document's start. */
  errors(fileName?: string): MxCompileDiagnostic[];
}

/**
 * What the policy of `fileName` reads from disk, as a string that changes when
 * any of it does: the modification time and size of every config spelling core
 * searches (`MX_CONFIG_SEARCH_PLACES`, `package.json` among them), from the
 * file's directory up to and including the nearest `package.json`. A missing
 * file is its own stamp, so creating one counts.
 */
function manifestStamp(fileName: string): string {
  const parts: string[] = [];
  let dir = dirname(fileName);
  for (;;) {
    let hasManifest = false;
    for (const name of MX_CONFIG_SEARCH_PLACES) {
      const file = join(dir, name);
      try {
        const stat = statSync(file);
        parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
        if (name === "package.json") hasManifest = true;
      } catch {
        parts.push(`${file}:-`);
      }
    }
    const parent = dirname(dir);
    if (hasManifest || parent === dir) return parts.join("|");
    dir = parent;
  }
}

export function createTargetPolicyRecorder(): TargetPolicyRecorder {
  const byFile = new Map<string, TargetPolicyDiagnostic[]>();
  const sources = new Map<string, string>();
  const stamps = new Map<string, string>();
  // The plugin watches no `package.json`: the tsserver entry point asks for a
  // refresh before it reads a file's diagnostics, so a fixed manifest stops
  // being reported without the `.mx` being edited.
  const refresh = (fileName: string): boolean => {
    const stamp = stamps.get(fileName);
    if (stamp === undefined) return false;
    const now = manifestStamp(fileName);
    if (stamp === now) return false;
    const { diagnostics } = resolveTargetPolicyDetailed(fileName);
    byFile.set(fileName, diagnostics);
    stamps.set(fileName, now);
    return true;
  };
  return {
    refresh,
    source(fileName, source) {
      sources.set(fileName, source);
    },
    resolve(fileName, source) {
      const { policy, diagnostics } = resolveTargetPolicyDetailed(fileName);
      byFile.set(fileName, diagnostics);
      stamps.set(fileName, manifestStamp(fileName));
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
