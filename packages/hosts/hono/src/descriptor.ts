/**
 * The `hono-jsx` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./dialect.ts` (the declarations) only; the
 * compile entry is required by a relative path inside `load`.
 */
import type { TargetDescriptor } from "@mxlang/core";
import { honoDeclarations } from "./dialect.ts";

/**
 * The CommonJS `require` this descriptor uses to reach its own compile entry,
 * declared rather than imported. A descriptor is loaded by bundlers, by tools
 * whose `tsconfig` declares no `types`, and by probe programs that compile a
 * single emitted module — none of which may have `@types/node` in scope, and
 * the entry must stay behind a *relative* `require` so a bundler inlines it.
 * Compile-time only: nothing is imported at module evaluation.
 */
declare const require: (specifier: string) => unknown;

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
