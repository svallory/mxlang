// Builds the language server's self-contained bundle into `bundle/` (see
// `bundled-config.ts`): `@mxlang/*` and `vscode-languageserver` inlined, the
// externals from the one list. The build itself is the shared
// `scripts/bundled-build.ts`.
import path from "node:path";
import { bundledBuild } from "../../../../scripts/bundled-build.ts";
import {
  BUNDLED_ENTRIES,
  BUNDLED_EXTERNALS,
  BUNDLED_OUTDIR,
} from "./bundled-config.ts";

await bundledBuild({
  packageDir: path.resolve(import.meta.dirname, ".."),
  entries: BUNDLED_ENTRIES,
  outdir: BUNDLED_OUTDIR,
  externals: BUNDLED_EXTERNALS,
});
