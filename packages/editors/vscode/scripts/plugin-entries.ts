// The plugin's bundle entries, read from the plugin's own `build` script, so the
// stage and the check agree with what the plugin build declares rather than with
// whatever a stale `dist/` happens to hold.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `["index", "ng-worker"]` for `bun build src/index.ts src/ng-worker.ts ...`. */
export function pluginEntries(pluginDir: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(pluginDir, "package.json"), "utf8"),
  ) as { scripts?: { build?: string } };
  const build = manifest.scripts?.build ?? "";
  const match = /bun build((?:\s+src\/[\w./-]+\.ts)+)\s+--outdir/.exec(build);
  if (!match?.[1]) {
    throw new Error(
      `cannot read the bundle entries from ${pluginDir}/package.json scripts.build (expected "bun build src/<entry>.ts ... --outdir"): ${build}`,
    );
  }
  const names = match[1]
    .trim()
    .split(/\s+/)
    .map((file) => file.replace(/^src\//, "").replace(/\.ts$/, ""));
  if (!names.includes("index")) {
    throw new Error("the plugin build declares no src/index.ts entry");
  }
  return names;
}
