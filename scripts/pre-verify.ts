#!/usr/bin/env bun
//
// Deletes stale test-run evidence before `verify` starts, so
// scripts/verify-coverage.ts can trust that any evidence file it finds was
// written by *this* invocation, not left over from a previous run.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = `${import.meta.dir}/../`;

const evidenceFiles = [
  join(root, "vitest-results.json"),
  join(root, "packages/editors/tree-sitter-solid/.test-ran"),
  join(root, "packages/editors/tree-sitter-amx/.test-ran"),
  join(root, "packages/editors/tree-sitter-mx/.test-ran"),
];

for (const file of evidenceFiles) {
  if (existsSync(file)) {
    rmSync(file);
    console.log(`[pre-verify] removed stale evidence: ${file}`);
  }
}

// Marks when this verify invocation started, so verify-coverage.ts can
// reject evidence older than this run even if some future evidence file
// pre-exists for a reason this script doesn't know about.
writeFileSync(join(root, ".verify-start"), String(Date.now()));
