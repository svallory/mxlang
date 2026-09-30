import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const PACKAGE_DIR = path.resolve(import.meta.dirname, "../..");

/**
 * A scratch directory whose `node_modules/@mxlang/typescript-plugin` is a
 * symlink to this package, so the plugin resolves by its package name the way
 * it does in a consumer's project (the package cannot resolve itself).
 */
export function makePluginInstall(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mx-ts-plugin-"));
  const scope = path.join(root, "node_modules", "@mxlang");
  mkdirSync(scope, { recursive: true });
  symlinkSync(PACKAGE_DIR, path.join(scope, "typescript-plugin"), "dir");
  return root;
}
