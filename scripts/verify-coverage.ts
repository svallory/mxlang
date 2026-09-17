#!/usr/bin/env bun
//
// decision 64: `verify` must prove every non-exception package's tests
// actually ran in *this* invocation, not merely that some test wiring exists
// for it somewhere. Every "ran" verdict below is read from an evidence file
// written by the real test command during this same `bun run verify` call
// (scripts/pre-verify.ts deletes stale evidence first) — there is no branch
// that marks a package as tested without checking that evidence.

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = `${import.meta.dir}/../`;
const vitestJsonPath = join(root, "vitest-results.json");
const grammarMarkerPath = join(
  root,
  "packages/editors/tree-sitter-solidmx/.test-ran",
);
const amxGrammarMarkerPath = join(
  root,
  "packages/editors/tree-sitter-amx/.test-ran",
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
  "examples/todomvc": "e2e only",
  "packages/editors/zed":
    "grammar and Rust extension, both build-verified in CI (zed-compile-check, zed-compile-check)",
  "apps/docs": "docs site: built in verify",
};

// The one package whose real test (packages/editors/tree-sitter-solidmx/scripts/test.sh,
// run via `moon run tree-sitter-solidmx:test`) is not vitest and so can never
// appear in vitest-results.json — it's checked against its own marker file.
const GRAMMAR_MARKER_PACKAGE = "tree-sitter-solidmx";

function readPackageJson(dir: string): Record<string, unknown> | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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

  const content = JSON.parse(
    readFileSync(vitestJsonPath, "utf-8"),
  ) as VitestResult;
  if (!content.testResults) return tested;

  for (const result of content.testResults) {
    const key = packageKeyOfTestPath(result.name, root, knownPaths);
    if (key && result.assertionResults?.length > 0) {
      tested.add(key);
    }
  }

  return tested;
}

async function main() {
  if (!existsSync(verifyStartPath)) {
    console.error(
      "ERROR: .verify-start is missing. Run via `bun run verify` (scripts/pre-verify.ts writes it), not this script directly against a stale worktree.\n",
    );
    process.exit(1);
  }
  const verifyStart = Number(readFileSync(verifyStartPath, "utf-8").trim());

  const packages = await getPackages();

  console.log("\n=== Test Coverage Verification ===\n");
  console.log(formatRow("Package", "Test Wiring", "Ran"));
  console.log("-".repeat(75));

  const knownPaths = packages.map((p) => p.path);
  const testedPackages = getTestedPackagesFromVitest(verifyStart, knownPaths);
  const solidmxGrammarRan = isFreshEvidence(grammarMarkerPath, verifyStart);
  const amxGrammarRan = isFreshEvidence(amxGrammarMarkerPath, verifyStart);

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
      pkg.path.endsWith("/tree-sitter-amx");
    if (isGrammarPackage) {
      const ran = pkg.path.endsWith(`/${GRAMMAR_MARKER_PACKAGE}`)
        ? solidmxGrammarRan
        : amxGrammarRan;
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
    process.exit(1);
  });
}
