// Builds the plugin's self-contained bundle into `bundle/` (see
// `bundled-config.ts`): every entry with `@mxlang/*`, volar and babel inlined,
// the externals from the one list, and `cjs-factory` applied to the plugin
// entry so tsserver gets a factory function. The build itself is the shared
// `scripts/bundled-build.ts`.
import path from "node:path";
import { bundledBuild } from "../../../../scripts/bundled-build.ts";
import {
  BUNDLED_ENTRIES,
  BUNDLED_EXTERNALS,
  BUNDLED_OUTDIR,
} from "./bundled-config.ts";
import { applyCjsFactory } from "./cjs-factory.ts";

const outdir = await bundledBuild({
  packageDir: path.resolve(import.meta.dirname, ".."),
  entries: BUNDLED_ENTRIES,
  outdir: BUNDLED_OUTDIR,
  externals: BUNDLED_EXTERNALS,
});
applyCjsFactory(path.join(outdir, "index.cjs"));
