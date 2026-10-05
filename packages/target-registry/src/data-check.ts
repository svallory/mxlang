/**
 * `checkDataPackage`: what `mx-tsc` runs on a package that says
 * `mx.target: "data"` (decision 131, addendum 4).
 *
 * The registry wrapper's staged "not wired yet" error stays the answer for
 * the editor tools and Vite (TODO `data-target-tooling-dispatch`); this
 * module is the one caller that asks for the real policy
 * (`resolveTargetPolicyDetailed(file, { dataWired: true })`). It lives in a
 * module of its own, not in `index.ts`, because it imports `@mxlang/data`'s
 * parse entry and the registry's own import must stay light.
 */

import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  clearScanCache,
  isTranslateError,
  type TargetPolicyDiagnostic,
  WILDCARD_NEAR_EXPLICIT,
} from "@mxlang/core";
import { type ParseDataOptions, parseData } from "@mxlang/data";
import { resolveTargetPolicyDetailed, scanCached } from "./index.ts";
import { lineAndColumn, locateJsonPath } from "./json-locate.ts";

export { lineAndColumn };

export interface DataCheckDiagnostic {
  /** The file (or directory) the position is measured in. */
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  /**
   * UTF-16 offset of the position in `file`, when the producer knows it
   * exactly. A printer that has the text uses it instead of `line`/`column`,
   * so the two can never disagree about what a line break is.
   */
  offset?: number;
  /**
   * `line`/`column` were counted by LF only (core's policy and scan
   * diagnostics). A printer that has no `offset` must read them that way; every
   * other diagnostic's coordinates are printed as given.
   */
  lfCoordinates?: true;
  /** Characters the diagnostic covers, when known (a `package.json` value). */
  length?: number;
  severity: "error" | "warning";
  message: string;
  /**
   * `data`: from `parseData`, or a discovery failure positioned in a file.
   * `manifest`: a `package.json` or policy problem.
   * `io`: the file system refused (no text to position in: print the path).
   */
  origin: "data" | "manifest" | "io";
}

export interface DataCheckResult {
  /** The `.mx` files checked, in the order they were checked (full-path order). */
  files: string[];
  /** Policy and manifest diagnostics first, then each file's in file order. */
  diagnostics: DataCheckDiagnostic[];
}

type Structural = NonNullable<ParseDataOptions["structural"]>;
type UnknownTags = NonNullable<ParseDataOptions["unknownTags"]>;

const STRUCTURAL: readonly Structural[] = ["pass", "reject"];
const UNKNOWN_TAGS: readonly UnknownTags[] = ["allow", "reject"];

interface Manifest {
  file: string;
  text: string;
  data: unknown;
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { mx?: { data?: unknown } } | null;
    return { file, text, data: parsed?.mx?.data };
  } catch {
    return { file, text, data: undefined };
  }
}

/**
 * Whether `mx-tsc` run on `dir` takes the data path: the directory's own
 * `package.json` says `mx.target: "data"`. Rule-5 inference from an
 * `@mxlang/data` dependency does not (such a package, or a monorepo root with
 * one, keeps its ordinary `tsc` run and the staged error for its data files),
 * and neither does a `package.json` found only in an ancestor.
 */
export function isDataProject(dir: string): boolean {
  const manifest = readManifest(dir);
  if (!manifest) return false;
  try {
    const parsed = JSON.parse(manifest.text) as { mx?: { target?: unknown } };
    return parsed?.mx?.target === "data";
  } catch {
    return false;
  }
}

interface DataOptions {
  structural: Structural;
  unknownTags: UnknownTags;
}

type Report = (diagnostic: DataCheckDiagnostic) => void;

/** Where `mx.data[.key]` sits in a manifest, falling back to the manifest's start. */
function locateData(manifest: Manifest, key?: string) {
  return (
    locateJsonPath(
      manifest.text,
      key === undefined ? ["mx", "data"] : ["mx", "data", key],
    ) ?? { offset: 0, line: 1, column: 0, length: 1 }
  );
}

/**
 * The `mx.data` options of a package. An invalid value is one error and the
 * strict default for that key, so a typo cannot loosen the check.
 */
function dataOptions(manifest: Manifest, report: Report): DataOptions {
  const options: DataOptions = { structural: "reject", unknownTags: "reject" };
  if (manifest.data === undefined) return options;
  const fail = (key: string | undefined, message: string): void =>
    report({
      file: manifest.file,
      ...locateData(manifest, key),
      severity: "error",
      message,
      origin: "manifest",
    });
  if (
    typeof manifest.data !== "object" ||
    manifest.data === null ||
    Array.isArray(manifest.data)
  ) {
    fail(
      undefined,
      'mx.data must be an object: { "structural"?: "pass" | "reject", "unknownTags"?: "allow" | "reject", "defaultTag"?: string }',
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
    // `defaultTag` is read and checked with the policy (decision 145).
    if (key === "structural" || key === "unknownTags" || key === "defaultTag")
      continue;
    report({
      file: manifest.file,
      ...locateData(manifest, key),
      severity: "warning",
      message: `unknown mx.data key ${JSON.stringify(key)}; known keys: structural, unknownTags, defaultTag`,
      origin: "manifest",
    });
  }
  return options;
}

/** Core's message with its own leading `<package.json> ` removed: the path is the location. */
function policyText(diagnostic: TargetPolicyDiagnostic): string {
  const own = `${diagnostic.file} `;
  return diagnostic.message.startsWith(own)
    ? diagnostic.message.slice(own.length)
    : diagnostic.message;
}

/** A package the walk is in: its manifest, its options, and its policy. */
interface Package {
  manifest: Manifest | undefined;
  options: DataOptions;
  /** `mx.data.defaultTag`, after the registry's check (decision 145). */
  defaultTag?: string;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "unknown error";
}

/**
 * Checks every `.mx` file under `dir` that the policy assigns to `data`, in
 * full-path order, with the package's own tag map (`tags/` sidecars and
 * `mx.contracts`, from the same scan the other tools use) and the
 * `structural`/`unknownTags` options of `package.json#mx.data`, both
 * `"reject"` unless set.
 *
 * Nothing in here throws for a problem in the project: the resolution's
 * policy diagnostics, an invalid `mx.data`, a discovery failure (a missing or
 * invalid `mx.contracts` module), an unreadable directory and a broken or
 * looping `.mx` link are all diagnostics, so a failed discovery is never an
 * empty map with a green result. A nested package that resolves to another
 * target is not walked.
 */
export function checkDataPackage(dir: string): DataCheckResult {
  // One run per process, but a test (or a watcher) may edit a manifest between
  // runs: never trust a scan from before this call.
  clearScanCache();
  const manifestDiagnostics: DataCheckDiagnostic[] = [];
  const fileDiagnostics: DataCheckDiagnostic[] = [];
  const seen = new Set<string>();
  const once =
    (into: DataCheckDiagnostic[]): Report =>
    (d) => {
      const key = `${d.file}\0${d.line}\0${d.column}\0${d.severity}\0${d.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      into.push(d);
    };
  const reportManifest = once(manifestDiagnostics);
  const reportFile = once(fileDiagnostics);

  /** Enters a package directory: its policy diagnostics and options, or `undefined` to skip it. */
  const enter = (pkgDir: string, entry: boolean): Package | undefined => {
    const manifest = readManifest(pkgDir);
    if (!manifest) return undefined;
    const { policy, diagnostics } = resolveTargetPolicyDetailed(manifest.file, {
      dataWired: true,
    });
    if (!entry && policy.target !== "data") return undefined;
    for (const d of diagnostics) {
      reportManifest({
        file: d.file,
        line: d.line,
        column: d.column,
        ...(d.length !== undefined ? { length: d.length } : {}),
        severity: d.severity ?? "warning",
        message: policyText(d),
        origin: "manifest",
        lfCoordinates: true,
      });
    }
    return {
      manifest,
      options: dataOptions(manifest, reportManifest),
      ...(policy.defaultTag === undefined
        ? {}
        : { defaultTag: policy.defaultTag }),
    };
  };

  const entry = enter(dir, true) ?? {
    manifest: undefined,
    options: { structural: "reject", unknownTags: "reject" } as DataOptions,
  };

  // Walk, pruning another target's package before descending into it.
  const found: { file: string; pkg: Package }[] = [];
  const pending: { dir: string; pkg: Package }[] = [{ dir, pkg: entry }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch (error) {
      reportFile({
        file: next.dir,
        line: 1,
        column: 0,
        severity: "error",
        message: `cannot read directory: ${errorCode(error)}`,
        origin: "io",
      });
      continue;
    }
    for (const dirent of entries) {
      const path = join(next.dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === "node_modules" || dirent.name.startsWith("."))
          continue;
        if (existsSync(join(path, "package.json"))) {
          const pkg = enter(path, false);
          if (pkg) pending.push({ dir: path, pkg });
        } else pending.push({ dir: path, pkg: next.pkg });
      } else if (dirent.name.endsWith(".mx")) {
        try {
          if (!statSync(path).isFile()) continue;
        } catch (error) {
          reportFile({
            file: path,
            line: 1,
            column: 0,
            severity: "error",
            message: `cannot read file: ${errorCode(error)}`,
            origin: "io",
          });
          continue;
        }
        found.push({ file: path, pkg: next.pkg });
      }
    }
  }
  found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const files: string[] = [];
  for (const { file, pkg } of found) {
    files.push(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      reportFile({
        file,
        line: 1,
        column: 0,
        severity: "error",
        message: `cannot read file: ${errorCode(error)}`,
        origin: "io",
      });
      continue;
    }
    let scan: ReturnType<typeof scanCached>;
    try {
      scan = scanCached(file, { host: null });
    } catch (error) {
      if (!isTranslateError(error)) throw error;
      // Positioned source feedback about the package's own configuration (a
      // missing contracts module, a bad declaration): print it where it points
      // and go on with the files that do not depend on it. Never an empty map.
      const at = error.file ?? pkg.manifest?.file ?? file;
      // The scan words some of these with the file they point at in front.
      const prefix = `${at}: `;
      reportManifest({
        file: at,
        line: error.line,
        column: error.column,
        severity: "error",
        message: error.message.startsWith(prefix)
          ? error.message.slice(prefix.length)
          : error.message,
        origin: "data",
        // Core positions every manifest key it reports (the `mx.contracts`
        // key, a policy key) by LF only. An error in any other file (a
        // sidecar, a contracts module, a Babel `loc`) is not.
        ...(basename(at) === "package.json"
          ? { lfCoordinates: true as const }
          : {}),
      });
      continue;
    }
    for (const d of scan.diagnostics) {
      reportManifest({
        file: d.file,
        line: d.line,
        column: d.column,
        severity: "warning",
        message: d.message,
        origin: "manifest",
        lfCoordinates: true,
      });
    }
    const result = parseData(source, file, {
      customTags: scan.customTags,
      structural: pkg.options.structural,
      unknownTags: pkg.options.unknownTags,
      ...(pkg.defaultTag === undefined ? {} : { defaultTag: pkg.defaultTag }),
    });
    for (const d of result.diagnostics) {
      reportFile({
        file: d.file ?? file,
        line: d.line,
        column: d.column,
        // The tooling check is strict: a child the author very likely meant as
        // an explicit one (decision 147's guard) fails it rather than warns.
        severity: d.code === WILDCARD_NEAR_EXPLICIT ? "error" : d.severity,
        message: d.message,
        origin: "data",
        // `-1` is "another file's text": the coordinates are the only answer.
        ...(d.offset >= 0 ? { offset: d.offset } : {}),
      });
    }
  }
  return { files, diagnostics: [...manifestDiagnostics, ...fileDiagnostics] };
}
