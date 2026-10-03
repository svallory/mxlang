/**
 * The `react-jsx` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./dialect.ts` (the declarations) only; the
 * compile entry is required by a relative path inside `load`.
 */
import type { TargetDescriptor } from "@mxlang/core";
import { reactDeclarations } from "./dialect.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "react-jsx",
  packageName: "@mxlang/react",
  declarations: { default: reactDeclarations },
  load() {
    const { compileReactMx } =
      require("./index.ts") as typeof import("./index.ts");
    return {
      compileModule: (source, filename, options) =>
        compileReactMx(source, filename, {
          customTags: options.customTags,
          warnings: options.warnings,
          resolveImport: options.resolveImport,
        }),
    };
  },
  host: { name: "react" },
};

export default descriptor;
