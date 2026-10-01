// The one `Bun.build` invocation behind every VSIX-only self-contained build
// (`@mxlang/typescript-plugin`'s and `@mxlang/language-server`'s
// `build/bundled.ts`): each entry as a CommonJS bundle, the listed externals
// left as bare requires, written to an output dir outside the package's
// `files`. What differs per package (entries, externals, post-processing)
// stays in that package's `build/`.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { bakedPathsIn } from "./baked-paths.ts";

/**
 * Bun's CJS output inlines `import.meta.url` (and the ESM shim's `__filename`
 * and `__dirname`) as the BUILD machine's absolute path, so every
 * `createRequire(import.meta.url)` in a bundled package resolved from the
 * build tree: the workspace copy on CI, nothing on a user's machine, and a
 * silent failure either way. A `define` plus a banner make them the bundle's
 * own location at run time. The published CJS builds (`@mxlang/tsc`,
 * `@mxlang/typescript-plugin` `dist/`) pass the same two options as CLI flags
 * (`--define`/`--banner`); `scripts/pack-hygiene.test.ts` asserts they match.
 */
export const RELOCATABLE_BANNER =
  'var __mxImportMetaUrl = require("node:url").pathToFileURL(__filename).href, __mxFilename = __filename, __mxDirname = __dirname;';
export const RELOCATABLE_DEFINE = {
  "import.meta.url": "__mxImportMetaUrl",
  __filename: "__mxFilename",
  __dirname: "__mxDirname",
} as const;

/** Throws when any file in `files` still names the build machine. */
export function assertRelocatable(files: readonly string[]): void {
  const problems = files.flatMap((file) =>
    bakedPathsIn(readFileSync(file, "utf8")).map(
      (what) => `${file} contains ${what}`,
    ),
  );
  if (problems.length > 0) {
    throw new Error(
      `a bundle bakes a build-machine path, so it only works where it was built:\n  ${problems.join("\n  ")}\nBun's CJS output changed or a build skipped RELOCATABLE_*: revisit scripts/bundled-build.ts`,
    );
  }
}

export interface BundledBuildOptions {
  /** The package being built; `src/<entry>.ts` is resolved against it. */
  packageDir: string;
  /** `src/<entry>.ts` bundled to `<outdir>/<entry>.cjs`. */
  entries: readonly string[];
  /** Output dir, relative to `packageDir`. */
  outdir: string;
  /** Packages left as bare requires. */
  externals: readonly string[];
}

/** Cleans `outdir`, builds every entry as CJS, and returns the output dir. */
export async function bundledBuild({
  packageDir,
  entries,
  outdir,
  externals,
}: BundledBuildOptions): Promise<string> {
  const out = path.join(packageDir, outdir);
  rmSync(out, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: entries.map((name) =>
      path.join(packageDir, "src", `${name}.ts`),
    ),
    outdir: out,
    target: "node",
    format: "cjs",
    naming: "[dir]/[name].cjs",
    external: [...externals],
    banner: RELOCATABLE_BANNER,
    define: { ...RELOCATABLE_DEFINE },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error(`the bundled build of ${packageDir} failed`);
  }
  assertRelocatable(
    readdirSync(out)
      .filter((f) => f.endsWith(".cjs"))
      .map((f) => path.join(out, f)),
  );
  return out;
}

if (import.meta.main) {
  // `bun scripts/bundled-build.ts <file.cjs>...`: the guard alone, for builds
  // that are not `bundledBuild` (the published `dist/*.cjs` scripts).
  assertRelocatable(process.argv.slice(2).map((f) => path.resolve(f)));
}
