import {
  checkDataPackage as registryCheckDataPackage,
  isDataProject as registryIsDataProject,
  lineAndColumn as registryLineAndColumn,
} from "@mxlang/target-registry/data-check";

/**
 * One diagnostic of {@link checkDataPackage}: a `.mx` file's data diagnostic,
 * or a problem in the `package.json` that configures the check.
 */
export interface DataCheckDiagnostic {
  /** The file the position is measured in. */
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  /** Exact UTF-16 offset in `file`, when known; wins over `line`/`column`. */
  offset?: number;
  /** `line`/`column` count lines by LF only; read them that way without an `offset`. */
  lfCoordinates?: true;
  /** Characters covered, when known. */
  length?: number;
  severity: "error" | "warning";
  message: string;
  origin: "data" | "manifest" | "io";
}

export interface DataCheckResult {
  files: string[];
  diagnostics: DataCheckDiagnostic[];
}

/**
 * Whether the project at `dir` takes the data check: its own `package.json`
 * says `mx.target: "data"` (rule-5 inference does not count). The editor
 * tools never ask: `mx-tsc` is the one caller (TODO
 * `data-target-tooling-dispatch` keeps the staged error for the rest).
 */
export function isDataProject(dir: string): boolean {
  return registryIsDataProject(dir);
}

/**
 * `mx-tsc`'s data check: every `.mx` file under `dir` that the policy assigns
 * to `data`, parsed with the package's tag map and `package.json#mx.data`
 * (decision 131, addendum 4).
 */
export function checkDataPackage(dir: string): DataCheckResult {
  return registryCheckDataPackage(dir);
}

/**
 * Line (1-based) and column (0-based) of a UTF-16 `offset` in `text` by
 * TypeScript's own line-break rules (LF, CR, CRLF, U+2028, U+2029), for a
 * printer that must not parse the file to find a line start.
 */
export function lineAndColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  return registryLineAndColumn(text, offset);
}
