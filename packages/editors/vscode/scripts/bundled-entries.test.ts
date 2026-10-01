import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_ENTRIES } from "../../../tooling/typescript-plugin/build/bundled-config";

const pluginManifest = join(
  import.meta.dirname,
  "../../../tooling/typescript-plugin/package.json",
);

/** `["index", "ng-worker"]` from the npm `build` script's `bun build src/... --outdir`. */
function npmBuildEntries(): string[] {
  const { scripts } = JSON.parse(readFileSync(pluginManifest, "utf8")) as {
    scripts: { build: string };
  };
  const match = /bun build((?:\s+src\/[\w./-]+\.ts)+)\s+--outdir/.exec(
    scripts.build,
  );
  if (!match?.[1])
    throw new Error(`cannot read entries from: ${scripts.build}`);
  return match[1]
    .trim()
    .split(/\s+/)
    .map((file) => file.replace(/^src\//, "").replace(/\.ts$/, ""));
}

describe("the plugin's entry lists", () => {
  it("BUNDLED_ENTRIES (the VSIX build) equals the npm build script's entries", () => {
    // Two builds, one set of entries: a worker added to one and not the other
    // would ship in the tarball but not the VSIX (or the reverse).
    expect([...BUNDLED_ENTRIES].sort()).toEqual(npmBuildEntries().sort());
  });
});
