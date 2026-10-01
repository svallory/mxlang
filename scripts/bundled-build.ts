// The one `Bun.build` invocation behind every VSIX-only self-contained build
// (`@mxlang/typescript-plugin`'s and `@mxlang/language-server`'s
// `build/bundled.ts`): each entry as a CommonJS bundle, the listed externals
// left as bare requires, written to an output dir outside the package's
// `files`. What differs per package (entries, externals, post-processing)
// stays in that package's `build/`.
import { rmSync } from "node:fs";
import path from "node:path";

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
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error(`the bundled build of ${packageDir} failed`);
  }
  return out;
}
