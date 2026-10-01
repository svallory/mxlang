// Runs the plugin's real-tsserver load test against the plugin inside the VSIX:
//
//   bun run scripts/tsserver-load.ts [path/to/mxlang.vsix]   (default: ./mxlang.vsix)
//
// Unpacks the VSIX, points the typescript-plugin's `tsserver-load` test at the
// unpacked `extension/` dir (`MX_VSIX_EXTENSION_DIR`) and runs it. That test
// spawns ONE tsserver with a request timeout and kills it on hang or exit, so
// nothing is left running. This is the proof that tsserver loads the shipped
// plugin; it never starts VS Code and never installs the VSIX.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const vsix = resolve(process.argv[2] ?? "mxlang.vsix");

const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-vsix-tsserver-")));
try {
  execFileSync("unzip", ["-q", vsix, "-d", dir]);
  const result = spawnSync(
    "bunx",
    [
      "vitest",
      "run",
      "--root",
      repoRoot,
      "--project",
      "@mxlang/typescript-plugin",
      "src/tsserver-load.test.ts",
    ],
    {
      cwd: join(repoRoot, "packages/tooling/typescript-plugin"),
      stdio: "inherit",
      env: { ...process.env, MX_VSIX_EXTENSION_DIR: join(dir, "extension") },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
