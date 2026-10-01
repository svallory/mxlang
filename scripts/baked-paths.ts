// The one definition of "this code bakes the machine it was built on": a
// `file:///` literal or the build root. Bun's CJS output inlines
// `import.meta.url`, `__filename` and `__dirname` as the build machine's
// absolute paths (see `scripts/bundled-build.ts`); used by the build guard,
// `check-vsix` (shipped bundles) and `pack-hygiene` (packed tarballs).
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "..");

/** What in `code` names the build machine; empty when it is relocatable. */
export function bakedPathsIn(code: string, root: string = repoRoot): string[] {
  const found: string[] = [];
  if (code.includes("file:///")) {
    found.push('a "file:///" literal: a baked build-machine path');
  }
  if (code.includes(root)) found.push(`the build root ${root}`);
  return found;
}
