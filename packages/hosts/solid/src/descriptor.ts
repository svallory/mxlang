/**
 * The `solid-jsx` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./emitter.ts` (the declarations) only. The
 * whole-file compile, the region compile and the callee reader reach their
 * heavy modules by a relative `require` inside the function body.
 */
import type { TargetCompileResult, TargetDescriptor } from "@mxlang/core";
import { solidDeclarations } from "./emitter.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "solid-jsx",
  packageName: "@mxlang/solid",
  declarations: { default: solidDeclarations },
  // `typescript-plugin/src/mx-language.ts`: Solid merges the decoded map with
  // the recorded mappings; every other target re-lowers.
  mappings: "merge-recorded",
  load() {
    const { compileSolidUnit } =
      require("./index.ts") as typeof import("./index.ts");
    return {
      // `vite-plugin/src/index.ts` and the editors call `compileSolidUnit`
      // with these three fields and no `resolveImport`.
      // Solid's placeholder `map` has an optional `file`, core's `RawSourceMap`
      // a required one; no tool reads `map.file`, so the result is cast rather
      // than rewritten (its bytes must stay what the tools get today).
      compileModule: (source, filename, options) =>
        compileSolidUnit(source, {
          filename,
          customTags: options.customTags,
          warnings: options.warnings,
        }) as TargetCompileResult,
    };
  },
  host: {
    name: "solid",
    fileKinds: [
      {
        segment: "solid",
        // `language-server/src/diagnose.ts` `SOLID_MX_LANGUAGE_IDS`.
        languageIds: ["solidmx", "SolidMX"],
        diagnosticSource: "solidmx",
        compileRegion: (source, input) =>
          (require("./index.ts") as typeof import("./index.ts")).compileSolidMx(
            source,
            input,
          ),
        readCalleeInput: (request) =>
          (
            require("./callee-reader.ts") as typeof import("./callee-reader.ts")
          ).readSolidCalleeInput(request),
      },
    ],
  },
};

export default descriptor;
