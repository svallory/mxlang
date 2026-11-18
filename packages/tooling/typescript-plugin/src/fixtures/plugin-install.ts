import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";

export const PACKAGE_DIR = path.resolve(import.meta.dirname, "../..");

/**
 * A scratch directory whose `node_modules/@mxlang/typescript-plugin` is a
 * symlink to this package, so the plugin resolves by its package name the way
 * it does in a consumer's project (the package cannot resolve itself).
 */
export function makePluginInstall(): string {
  // `PID` in the name: every real-tsserver test then runs under a path that
  // tsserver's PID substitution in its log path would break if it saw it.
  const root = mkdtempSync(path.join(tmpdir(), "mx-ts-plugin-PID-"));
  const scope = path.join(root, "node_modules", "@mxlang");
  mkdirSync(scope, { recursive: true });
  symlinkSync(PACKAGE_DIR, path.join(scope, "typescript-plugin"), "dir");
  return root;
}

/**
 * Fails, rather than skips, a test that reads this package's built `dist/<file>`
 * when no build has run: the first statement of every such test.
 */
export function requireDist(file: string): void {
  expect(
    existsSync(path.join(PACKAGE_DIR, "dist", file)),
    `packages/tooling/typescript-plugin/dist/${file} is missing: run \`bun run build\` first (moon run typescript-plugin:test builds it)`,
  ).toBe(true);
}
