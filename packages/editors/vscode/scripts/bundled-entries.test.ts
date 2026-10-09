import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_ENTRIES as LS_ENTRIES,
  BUNDLED_MAIN as LS_MAIN,
  BUNDLED_OUTDIR as LS_OUTDIR,
} from "../../../tooling/language-server/build/bundled-config";
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

describe("the language server's bundled build", () => {
  it("is outside the npm tarball's `files` and its bundle dir is gitignored", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../tooling/language-server/package.json",
        ),
        "utf8",
      ),
    ) as { files: string[] };
    expect(manifest.files).toEqual(["dist", "README.md", "CHANGELOG.md"]);
    expect(manifest.files).not.toContain(LS_OUTDIR);
    const gitignore = readFileSync(
      join(import.meta.dirname, "../../../../.gitignore"),
      "utf8",
    );
    expect(gitignore).toContain(
      `packages/tooling/language-server/${LS_OUTDIR}/`,
    );
  });

  it("is the file the extension runs (src/extension.ts names dist/<BUNDLED_MAIN>)", () => {
    const extension = readFileSync(
      join(import.meta.dirname, "../src/extension.ts"),
      "utf8",
    );
    expect(extension).toContain(`"${LS_MAIN}"`);
    expect(LS_ENTRIES.map((e) => `${e}.cjs`)).toContain(LS_MAIN);
  });
});
