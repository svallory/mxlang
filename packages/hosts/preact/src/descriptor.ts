/**
 * The `preact-jsx` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./emitter.ts` (the declarations) only; the
 * compile entry is required by a relative path inside `load`.
 */
import type { TargetDescriptor } from "@mxlang/core";
import { preactDeclarations } from "./emitter.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "preact-jsx",
  packageName: "@mxlang/preact",
  declarations: { default: preactDeclarations },
  load() {
    const { compilePreactMx } =
      require("./index.ts") as typeof import("./index.ts");
    return {
      compileModule: (source, filename, options) =>
        compilePreactMx(source, filename, {
          customTags: options.customTags,
          warnings: options.warnings,
          resolveImport: options.resolveImport,
        }),
    };
  },
  host: { name: "preact" },
};

export default descriptor;
