/**
 * `checkDataPackage`: what `mx-tsc` runs on a package whose policy is the
 * `data` target (decision 131, addendum 4).
 *
 * The registry wrapper's staged "not wired yet" error stays the answer for
 * the editor tools and Vite (TODO `data-target-tooling-dispatch`); this
 * module is the one caller that asks for the real policy
 * (`resolveTargetPolicyDetailed(file, { dataWired: true })`). It lives in a
 * module of its own, not in `index.ts`, because it imports `@mxlang/data`'s
 * parse entry and the registry's own import must stay light.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import {
  type DataDiagnostic,
  type ParseDataOptions,
  parseData,
} from "@mxlang/data";
import { resolveTargetPolicyDetailed, scanCached } from "./index.ts";

export interface DataCheckDiagnostic {
  /** The file the position is measured in: a `.mx` file or a `package.json`. */
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  /** Characters the diagnostic covers, when known (a `package.json` value). */
  length?: number;
  severity: "error" | "warning";
  message: string;
  /** `data`: from `parseData`. `manifest`: a `package.json` or scan problem. */
  origin: "data" | "manifest";
}

export interface DataCheckResult {
  /** The `.mx` files checked, in the order they were checked. */
  files: string[];
  /** Manifest diagnostics first, then each file's in file order. */
  diagnostics: DataCheckDiagnostic[];
}

type Structural = NonNullable<ParseDataOptions["structural"]>;
type UnknownTags = NonNullable<ParseDataOptions["unknownTags"]>;

const STRUCTURAL: readonly Structural[] = ["pass", "reject"];
const UNKNOWN_TAGS: readonly UnknownTags[] = ["allow", "reject"];

/** Whether `dir` (a package or a project directory) resolves to the data target. */
export function isDataProject(dir: string): boolean {
  return (
    resolveTargetPolicyDetailed(join(dir, "package.json"), { dataWired: true })
      .policy.target === "data"
  );
}

/** Every `.mx` file under `dir`, sorted by path, skipping `node_modules` and dot directories. */
function mxFilesUnder(dir: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        visit(path);
      } else if (entry.name.endsWith(".mx") && statSync(path).isFile()) {
        found.push(path);
      }
    }
  };
  visit(dir);
  return found;
}

interface Manifest {
  file: string;
  text: string;
  data: unknown;
}

/** The nearest `package.json` at or above `dir`, parsed leniently. */
function nearestManifest(dir: string): Manifest | undefined {
  let current = dir;
  for (;;) {
    const file = join(current, "package.json");
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      try {
        const parsed = JSON.parse(text) as { mx?: { data?: unknown } };
        return { file, text, data: parsed?.mx?.data };
      } catch {
        return { file, text, data: undefined };
      }
    }
    if (basename(current) === "node_modules") return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Where `mx.data.<key>`'s value starts in a manifest's text; line 1 when it cannot be found. */
function locateDataValue(
  text: string,
  key: string | undefined,
): { line: number; column: number; length: number } {
  const steps = key === undefined ? ["mx", "data"] : ["mx", "data", key];
  let at = 0;
  let value = 0;
  for (const step of steps) {
    const member = new RegExp(`"${step}"\\s*:\\s*`, "g");
    member.lastIndex = at;
    const match = member.exec(text);
    if (!match) return { line: 1, column: 0, length: 1 };
    at = match.index + match[0].length;
    value = at;
  }
  const rest = text.slice(value);
  const length = /^"(?:\\.|[^"\\])*"|^[^\s,}\]]+/.exec(rest)?.[0].length ?? 1;
  const before = text.slice(0, value).split("\n");
  return {
    line: before.length,
    column: (before.at(-1) ?? "").length,
    length,
  };
}

interface DataOptions {
  structural: Structural;
  unknownTags: UnknownTags;
}

/**
 * The `mx.data` options of a package. An invalid value is one error and the
 * strict default for that key, so a typo cannot loosen the check.
 */
function dataOptions(
  manifest: Manifest | undefined,
  report: (diagnostic: DataCheckDiagnostic) => void,
): DataOptions {
  const options: DataOptions = { structural: "reject", unknownTags: "reject" };
  if (!manifest || manifest.data === undefined) return options;
  const fail = (key: string | undefined, message: string): void => {
    report({
      file: manifest.file,
      ...locateDataValue(manifest.text, key),
      severity: "error",
      message,
      origin: "manifest",
    });
  };
  if (
    typeof manifest.data !== "object" ||
    manifest.data === null ||
    Array.isArray(manifest.data)
  ) {
    fail(
      undefined,
      'mx.data must be an object: { "structural"?: "pass" | "reject", "unknownTags"?: "allow" | "reject" }',
    );
    return options;
  }
  const given = manifest.data as Record<string, unknown>;
  const spec = [
    ["structural", STRUCTURAL],
    ["unknownTags", UNKNOWN_TAGS],
  ] as const;
  for (const [key, allowed] of spec) {
    const value = given[key];
    if (value === undefined) continue;
    if (
      typeof value === "string" &&
      (allowed as readonly string[]).includes(value)
    ) {
      (options as unknown as Record<string, string>)[key] = value;
    } else {
      fail(
        key,
        `mx.data.${key} must be ${allowed.map((v) => `"${v}"`).join(" or ")}, got ${JSON.stringify(value)}; using "reject"`,
      );
    }
  }
  for (const key of Object.keys(given)) {
    if (key === "structural" || key === "unknownTags") continue;
    report({
      file: manifest.file,
      ...locateDataValue(manifest.text, key),
      severity: "warning",
      message: `unknown mx.data key "${key}"; known keys: structural, unknownTags`,
      origin: "manifest",
    });
  }
  return options;
}

/**
 * Parses every `.mx` file under `dir` that the policy assigns to `data`, in
 * path order, with the package's own tag map (`tags/` sidecars and
 * `mx.contracts`, from the same scan the other tools use) and the
 * `structural`/`unknownTags` options of `package.json#mx.data`, both
 * `"reject"` unless set. Files a nested package gives to another target are
 * not this check's.
 */
export function checkDataPackage(dir: string): DataCheckResult {
  // One run per process, but a test (or a watcher) may edit a manifest between
  // runs: never trust a scan from before this call.
  clearScanCache();
  const manifestDiagnostics: DataCheckDiagnostic[] = [];
  const seen = new Set<string>();
  const reportManifest = (diagnostic: DataCheckDiagnostic): void => {
    const key = `${diagnostic.file}\0${diagnostic.line}\0${diagnostic.column}\0${diagnostic.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    manifestDiagnostics.push(diagnostic);
  };
  const files: string[] = [];
  const fileDiagnostics: DataCheckDiagnostic[] = [];
  const optionsByManifest = new Map<string, DataOptions>();

  for (const file of mxFilesUnder(dir)) {
    const { policy } = resolveTargetPolicyDetailed(file, { dataWired: true });
    if (policy.target !== "data") continue;
    files.push(file);

    const manifest = nearestManifest(dirname(file));
    const cacheKey = manifest?.file ?? "";
    let options = optionsByManifest.get(cacheKey);
    if (!options) {
      options = dataOptions(manifest, reportManifest);
      optionsByManifest.set(cacheKey, options);
    }

    const scan = scanCached(file, { host: null });
    for (const d of scan.diagnostics) {
      reportManifest({
        file: d.file,
        line: d.line,
        column: d.column,
        severity: "warning",
        message: d.message,
        origin: "manifest",
      });
    }
    const result = parseData(readFileSync(file, "utf8"), file, {
      customTags: scan.customTags,
      structural: options.structural,
      unknownTags: options.unknownTags,
    });
    for (const d of result.diagnostics as DataDiagnostic[]) {
      fileDiagnostics.push({
        file: d.file ?? file,
        line: d.line,
        column: d.column,
        severity: d.severity,
        message: d.message,
        origin: "data",
      });
    }
  }
  return { files, diagnostics: [...manifestDiagnostics, ...fileDiagnostics] };
}
