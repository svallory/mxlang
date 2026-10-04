import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledBuild } from "../../../../scripts/bundled-build.ts";

// ESM bundling hoists an external compiler import out of a lazy leaf (data's
// compiler), evaluating @marko/compiler during config loading. A CJS closure
// keeps requires inside their lazy initializers; a small ESM facade retains
// the plugin's original default and named exports under native Node.
const dist = await bundledBuild({
  packageDir: fileURLToPath(new URL("../", import.meta.url)),
  entries: ["index"],
  outdir: "dist",
  externals: ["@marko/compiler", "@mxlang/core", "@mxlang/parser"],
});
writeFileSync(
  join(dist, "index.js"),
  [
    'import runtime from "./index.cjs";',
    "export default runtime.default;",
    "export const MX_SUFFIX = runtime.MX_SUFFIX;",
    "export const codeFrame = runtime.codeFrame;",
    "export const readTemplateSource = runtime.readTemplateSource;",
    "",
  ].join("\n"),
);
