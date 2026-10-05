#!/usr/bin/env bun
//
// decision 64: `verify` must prove every non-exception package's tests
// actually ran in *this* invocation, not merely that some test wiring exists
// for it somewhere. Every "ran" verdict below is read from an evidence file
// written by the real test command during this same `bun run verify` call
// (scripts/pre-verify.ts deletes stale evidence first) — there is no branch
// that marks a package as tested without checking that evidence.
// CI: --collect <file> <job> <vitest|grammar> snapshots that same fresh
// evidence before artifact transport (which loses mtimes). --merge <dir>
// <job,job,...> checks the union, bound to this GitHub run/attempt/SHA.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = `${import.meta.dir}/../`;
const vitestJsonPath = join(root, "vitest-results.json");
const grammarMarkerPath = join(
  root,
  "packages/editors/tree-sitter-solid/.test-ran",
);
const amxGrammarMarkerPath = join(
  root,
  "packages/editors/tree-sitter-amx/.test-ran",
);
const mxGrammarMarkerPath = join(
  root,
  "packages/editors/tree-sitter-mx/.test-ran",
);
const verifyStartPath = join(root, ".verify-start");

interface Package {
  path: string;
  reason?: string;
}

// Resolves a vitest test file's absolute path to the workspace package it
// belongs to, by finding the longest known package path that is a prefix of
// the test file's own relative path — no hardcoded group list (hosts/
// tooling/editors/...), so a package nested at any depth under packages/*/*
// or examples/* resolves correctly as soon as getPackages() discovers it.
// Returns null if no known package path is a prefix.
export function packageKeyOfTestPath(
  absPath: string,
  repoRoot: string,
  knownPaths: readonly string[],
): string | null {
  const rel = relative(repoRoot, absPath);

  let best: string | null = null;
  for (const pkgPath of knownPaths) {
    if (
      (rel === pkgPath || rel.startsWith(`${pkgPath}/`)) &&
      (best === null || pkgPath.length > best.length)
    ) {
      best = pkgPath;
    }
  }
  return best;
}

// Exception keys that no longer name a discovered workspace package — a
// guard against the exception list rotting silently as packages are
// renamed or removed (A2).
export function findStaleExceptions(
  knownPaths: ReadonlySet<string>,
  exceptions: Record<string, string>,
): string[] {
  return Object.keys(exceptions).filter((key) => !knownPaths.has(key));
}

const NO_TEST_EXCEPTIONS: Record<string, string> = {
  "examples/angular-app":
    "ng build/ng test only, verified manually — no e2e suite wired yet",
  "examples/astro-static": "e2e only",
  "examples/counter-app": "e2e only",
  "examples/hono-app": "e2e only",
  "examples/mx-site": "e2e only",
  "examples/mx-vite": "e2e only",
  "examples/preact-app": "e2e only",
  "examples/react-app": "e2e only",
  "examples/react-region-app": "e2e only",
  "examples/todomvc": "e2e only",
  "packages/editors/zed":
    "grammar and Rust extension, both build-verified in CI (zed-compile-check, zed-compile-check)",
  "apps/docs": "docs site: built in verify",
};

// The one package whose real test (packages/editors/tree-sitter-solid/scripts/test.sh,
// run via `moon run tree-sitter-solid:test`) is not vitest and so can never
// appear in vitest-results.json — it's checked against its own marker file.
const GRAMMAR_MARKER_PACKAGE = "tree-sitter-solid";

function readPackageJson(dir: string): Record<string, unknown> | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`Cannot read package config: ${path}`, { cause });
  }
}

async function getPackages(): Promise<Package[]> {
  const packages: Package[] = [];
  const rootPkg = readPackageJson(root);
  const workspaces = rootPkg?.workspaces;
  if (!Array.isArray(workspaces)) {
    console.error("No workspaces found in root package.json");
    process.exit(1);
  }

  const workspaceDirs = new Set<string>();

  for (const pattern of workspaces) {
    const base = pattern.startsWith("packages/")
      ? "packages"
      : pattern.startsWith("examples/")
        ? "examples"
        : pattern.startsWith("apps/")
          ? "apps"
          : null;
    if (!base) continue;
    const dir = join(root, base);
    if (!existsSync(dir)) continue;

    const findWorkspaces = async (
      currentDir: string,
      relBase: string,
      depth: number,
    ) => {
      if (depth > 2) return;
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = join(currentDir, entry.name);
        const relPath = join(relBase, entry.name);
        if (existsSync(join(fullPath, "package.json"))) {
          workspaceDirs.add(relPath);
        } else {
          await findWorkspaces(fullPath, relPath, depth + 1);
        }
      }
    };
    await findWorkspaces(dir, base, 1);
  }

  for (const relPath of Array.from(workspaceDirs).sort()) {
    packages.push({
      path: relPath,
      reason: NO_TEST_EXCEPTIONS[relPath],
    });
  }

  const knownPaths = new Set(packages.map((p) => p.path));
  const staleExceptions = findStaleExceptions(knownPaths, NO_TEST_EXCEPTIONS);
  if (staleExceptions.length > 0) {
    console.error(
      `ERROR: NO_TEST_EXCEPTIONS has stale entries for packages that no longer exist: ${staleExceptions.join(", ")}\n`,
    );
    process.exit(1);
  }

  return packages;
}

function formatRow(name: string, wiring: string, status: string): string {
  return name.padEnd(38) + wiring.padEnd(35) + status;
}

interface VitestResult {
  testResults: Array<{
    name: string;
    assertionResults: Array<{ status: string }>;
  }>;
}

// Any evidence file must be newer than the moment this verify invocation
// started (written by scripts/pre-verify.ts), or it's a leftover from a
// previous run that pre-verify somehow failed to clear — reject it rather
// than trust it.
function isFreshEvidence(path: string, verifyStart: number): boolean {
  if (!existsSync(path)) return false;
  return statSync(path).mtimeMs >= verifyStart;
}

function getTestedPackagesFromVitest(
  verifyStart: number,
  knownPaths: readonly string[],
): Set<string> {
  const tested = new Set<string>();

  if (!isFreshEvidence(vitestJsonPath, verifyStart)) {
    return tested;
  }

  let content: VitestResult;
  try {
    content = JSON.parse(readFileSync(vitestJsonPath, "utf-8")) as VitestResult;
  } catch (cause) {
    throw new Error(`Cannot read Vitest evidence: ${vitestJsonPath}`, {
      cause,
    });
  }
  if (!content.testResults) return tested;

  for (const result of content.testResults) {
    const key = packageKeyOfTestPath(result.name, root, knownPaths);
    if (
      key &&
      result.assertionResults?.some(
        (assertion) =>
          assertion.status === "passed" || assertion.status === "failed",
      )
    ) {
      tested.add(key);
    }
  }

  return tested;
}

interface CoverageEvidence {
  version: 1;
  invocation: string;
  job: string;
  verifyStart: number;
  collectedAt: number;
  testedPackages: string[];
}

function readCoverageEvidence(path: string): CoverageEvidence {
  try {
    // Schema/provenance/package keys are validated by mergeCoverageEvidence.
    return JSON.parse(readFileSync(path, "utf-8")) as CoverageEvidence;
  } catch (cause) {
    throw new Error(`Cannot read coverage evidence: ${path}`, { cause });
  }
}

function invocationKey(): string {
  const parts = [
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
    process.env.GITHUB_SHA,
  ];
  if (parts.some((part) => !part)) {
    throw new Error(
      "CI evidence requires GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_SHA",
    );
  }
  return parts.join(":");
}

function readVerifyStart(): number {
  if (!existsSync(verifyStartPath)) {
    throw new Error(
      ".verify-start is missing. Run scripts/pre-verify.ts before tests.",
    );
  }
  const start = Number(readFileSync(verifyStartPath, "utf-8").trim());
  if (!Number.isFinite(start) || start <= 0 || start > Date.now()) {
    throw new Error("Invalid .verify-start timestamp");
  }
  return start;
}

// No download-time mtime checks: freshness is established on the producer,
// against its pre-verify timestamp, before serializing workspace-relative keys.
// A new checkout may live at a different absolute path from that producer.
export function mergeCoverageEvidence(
  manifests: readonly CoverageEvidence[],
  invocation: string,
  expectedJobs: readonly string[],
  knownPaths: readonly string[],
): Set<string> {
  if (
    !expectedJobs.length ||
    new Set(expectedJobs).size !== expectedJobs.length
  ) {
    throw new Error("Expected evidence jobs must be nonempty and unique");
  }
  const seen = new Set<string>();
  const tested = new Set<string>();
  for (const manifest of manifests) {
    if (
      manifest.version !== 1 ||
      manifest.invocation !== invocation ||
      !expectedJobs.includes(manifest.job) ||
      seen.has(manifest.job) ||
      !Number.isFinite(manifest.verifyStart) ||
      manifest.verifyStart <= 0 ||
      !Number.isFinite(manifest.collectedAt) ||
      manifest.collectedAt < manifest.verifyStart ||
      !Array.isArray(manifest.testedPackages)
    ) {
      throw new Error("Invalid, stale or duplicate CI coverage evidence");
    }
    seen.add(manifest.job);
    for (const key of manifest.testedPackages) {
      if (!knownPaths.includes(key)) {
        throw new Error(`Evidence names an unknown package: ${key}`);
      }
      tested.add(key);
    }
  }
  for (const job of expectedJobs) {
    if (!seen.has(job))
      throw new Error(`Missing coverage evidence for job: ${job}`);
  }
  return tested;
}

async function main() {
  const packages = await getPackages();
  const knownPaths = packages.map((p) => p.path);
  const [mode, path, jobOrJobs, kind, ...extra] = process.argv.slice(2);
  let testedPackages: Set<string>;

  if (mode === "--merge" && path && jobOrJobs && !kind && !extra.length) {
    const entries = await readdir(path);
    const manifests = entries
      .filter((file) => file.endsWith(".json"))
      .map((file) => readCoverageEvidence(join(path, file)));
    testedPackages = mergeCoverageEvidence(
      manifests,
      invocationKey(),
      jobOrJobs.split(","),
      knownPaths,
    );
    console.log(`Merged evidence from: ${jobOrJobs}`);
  } else {
    if (
      mode &&
      !(
        mode === "--collect" &&
        path &&
        jobOrJobs &&
        (kind === "vitest" || kind === "grammar") &&
        !extra.length
      )
    ) {
      throw new Error(
        "Usage: verify-coverage.ts [--collect <file> <job> <vitest|grammar> | --merge <dir> <job,job,...>]",
      );
    }
    const verifyStart = readVerifyStart();
    testedPackages = new Set<string>();
    if (!mode || kind === "vitest") {
      if (mode && !isFreshEvidence(vitestJsonPath, verifyStart)) {
        throw new Error("Missing or stale Vitest evidence");
      }
      testedPackages = getTestedPackagesFromVitest(verifyStart, knownPaths);
    }
    if (!mode || kind === "grammar") {
      for (const [key, marker] of [
        ["packages/editors/tree-sitter-solid", grammarMarkerPath],
        ["packages/editors/tree-sitter-amx", amxGrammarMarkerPath],
        ["packages/editors/tree-sitter-mx", mxGrammarMarkerPath],
      ]) {
        if (isFreshEvidence(marker, verifyStart)) testedPackages.add(key);
        else if (mode)
          throw new Error(`Missing or stale grammar evidence: ${key}`);
      }
    }
    if (mode === "--collect") {
      const manifest: CoverageEvidence = {
        version: 1,
        invocation: invocationKey(),
        job: jobOrJobs,
        verifyStart,
        collectedAt: Date.now(),
        testedPackages: [...testedPackages].sort(),
      };
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(
        `Collected fresh ${kind} evidence: ${manifest.testedPackages.length} packages (${jobOrJobs})`,
      );
      return;
    }
  }

  console.log("\n=== Test Coverage Verification ===\n");
  console.log(formatRow("Package", "Test Wiring", "Ran"));
  console.log("-".repeat(75));

  let hasFailure = false;
  let ranCount = 0;
  const exceptions: Package[] = [];

  for (const pkg of packages) {
    if (pkg.reason) {
      exceptions.push(pkg);
      console.log(formatRow(pkg.path, `(exception: ${pkg.reason})`, "OK"));
      continue;
    }

    const isGrammarPackage =
      pkg.path.endsWith(`/${GRAMMAR_MARKER_PACKAGE}`) ||
      pkg.path.endsWith("/tree-sitter-amx") ||
      pkg.path.endsWith("/tree-sitter-mx");
    if (isGrammarPackage) {
      const ran = testedPackages.has(pkg.path);
      if (ran) {
        ranCount++;
        console.log(
          formatRow(pkg.path, "moon test task (scripts/test.sh)", "ran"),
        );
      } else {
        hasFailure = true;
        console.log(
          formatRow(
            pkg.path,
            "moon test task (scripts/test.sh)",
            "ERROR: did not run",
          ),
        );
      }
      continue;
    }

    if (testedPackages.has(pkg.path)) {
      ranCount++;
      console.log(formatRow(pkg.path, "vitest project", "ran"));
    } else {
      hasFailure = true;
      console.log(
        formatRow(pkg.path, "vitest project", "ERROR: no evidence it ran"),
      );
    }
  }

  console.log(`\n${"=".repeat(75)}`);
  console.log(
    `Total: ${packages.length} packages (${ranCount} ran, ${exceptions.length} exceptions)\n`,
  );

  if (exceptions.length > 0) {
    console.log("Exceptions (no test required):");
    for (const exc of exceptions) {
      console.log(`  • ${exc.path}: ${exc.reason}`);
    }
    console.log();
  }

  if (hasFailure) {
    console.error(
      "ERROR: one or more packages have no test wiring, or no fresh evidence their tests ran in this invocation.\n",
    );
    process.exit(1);
  }

  console.log(
    "✓ All packages have test wiring and fresh evidence their tests ran.\n",
  );
  process.exit(0);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Error:", e);
    console.error(
      "Locally, run `bun run verify` to regenerate evidence. In CI, rerun all verify jobs in the same attempt; do not reuse artifacts from an earlier attempt.",
    );
    process.exit(1);
  });
}
