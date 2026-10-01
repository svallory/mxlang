// Builds the plugin's self-contained bundle into `bundle/` (see
// `bundled-config.ts`): every entry with `@mxlang/*`, volar and babel inlined,
// the externals from the one list, and `cjs-factory` applied to the plugin
// entry so tsserver gets a factory function.
import { rmSync } from "node:fs";
import path from "node:path";
import {
  BUNDLED_ENTRIES,
  BUNDLED_EXTERNALS,
  BUNDLED_OUTDIR,
} from "./bundled-config.ts";
import { applyCjsFactory } from "./cjs-factory.ts";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const outdir = path.join(PACKAGE_DIR, BUNDLED_OUTDIR);

rmSync(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: BUNDLED_ENTRIES.map((name) =>
    path.join(PACKAGE_DIR, "src", `${name}.ts`),
  ),
  outdir,
  target: "node",
  format: "cjs",
  naming: "[dir]/[name].cjs",
  external: [...BUNDLED_EXTERNALS],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  throw new Error("the bundled plugin build failed");
}
applyCjsFactory(path.join(outdir, "index.cjs"));
