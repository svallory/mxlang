/**
 * The `hono-jsx` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./dialect.ts` (the declarations) only; the
 * compile entry is required by a relative path inside `load`.
 */
import type { TargetDescriptor } from "@mxlang/core";
import { honoDeclarations } from "./dialect.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "hono-jsx",
  packageName: "@mxlang/hono",
  declarations: { default: honoDeclarations },
  load() {
    const { compileHonoMx } =
      require("./index.ts") as typeof import("./index.ts");
    return {
      compileModule: (source, filename, options) =>
        compileHonoMx(source, filename, {
          customTags: options.customTags,
          warnings: options.warnings,
          resolveImport: options.resolveImport,
        }),
    };
  },
  host: { name: "hono" },
};

export default descriptor;
