#!/usr/bin/env bun
//
// decision 190 item 4: a PR whose diff touches `packages/*/src` or a
// `packages/*/package.json` must add at least one changelog fragment under
// `changes/`, unless its body carries a `no-changelog: <reason>` line. The
// diff is taken against the merge base with origin/main, not origin/main's
// head, so an open PR that predates a fresh main landing is not judged
// against files it never touched.
//
// CI wires this into the lint-typecheck-build job (see .github/workflows/ci.yml,
// whose checkout uses fetch-depth: 0 so the merge base exists). Locally:
// `bun run changelog:check [--base origin/main] [--body-file <path>]`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const root = `${import.meta.dir}/../`;

// `packages/<pkg>/src/...`, `packages/<group>/<pkg>/src/...`, and the
// package.json at either depth — the two shapes a real package change takes.
export const codeChangeRe =
  /^packages\/[^/]+(?:\/[^/]+)?\/(?:src\/.+|package\.json)$/;

export const noChangelogRe = /^no-changelog:\s*\S.*$/m;

export interface CheckInput {
  /** Files changed on this branch vs the merge base. */
  changed: string[];
  /** Files added on this branch vs the merge base. */
  added: string[];
  /** The PR body (empty for a non-PR context). */
  body: string;
}

export interface CheckResult {
  ok: boolean;
  message?: string;
}

export function evaluate(input: CheckInput): CheckResult {
  const codePaths = input.changed.filter((path) => codeChangeRe.test(path));
  if (codePaths.length === 0) return { ok: true };
  if (noChangelogRe.test(input.body)) return { ok: true };
  const hasFragment = input.added.some(
    (path) => path.startsWith("changes/") && path.endsWith(".md"),
  );
  if (hasFragment) return { ok: true };
  return {
    ok: false,
    message: [
      "this PR changes package code but adds no changelog fragment.",
      "Add `changes/<branch-slug>.md` (front matter `packages: [...]` and `kind:`,",
      "body = the changelog entry), or put a `no-changelog: <reason>` line in the PR body.",
      "Package files changed:",
      ...codePaths.map((path) => `  ${path}`),
    ].join("\n"),
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function prBody(
  override: string | undefined,
  bodyFile: string | undefined,
): string {
  if (bodyFile) return readFileSync(bodyFile, "utf8");
  if (override !== undefined) return override;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { body?: string | null };
    };
    if (event.pull_request) return event.pull_request.body ?? "";
  }
  return "";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let base = "origin/main";
  let body: string | undefined;
  let bodyFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") base = args[++i] as string;
    else if (args[i] === "--body") body = args[++i] as string;
    else if (args[i] === "--body-file") bodyFile = args[++i] as string;
    else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }

  const mergeBase = git(["merge-base", "HEAD", base]).split("\n")[0];
  if (!mergeBase) {
    console.error(`[changelog-check] cannot resolve a merge base with ${base}`);
    process.exit(2);
  }
  const changed = git(["diff", "--name-only", mergeBase, "HEAD"])
    .split("\n")
    .filter(Boolean);
  const added = git([
    "diff",
    "--name-only",
    "--diff-filter=A",
    mergeBase,
    "HEAD",
  ])
    .split("\n")
    .filter(Boolean);
  const result = evaluate({ changed, added, body: prBody(body, bodyFile) });
  if (!result.ok) {
    console.error(`[changelog-check] ${result.message}`);
    process.exit(1);
  }
  console.log("[changelog-check] ok");
}
