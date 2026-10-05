/**
 * The `solid-jsx` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./emitter.ts` (the declarations) only. The
 * whole-file compile, the region compile and the callee reader reach their
 * heavy modules by a relative `require` inside the function body.
 */
import {
  createTargetLookup,
  type TargetCompileResult,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import { solidDeclarations } from "./emitter.ts";

/**
 * The CommonJS `require` this descriptor uses to reach its own compile entry,
 * declared rather than imported. A descriptor is loaded by bundlers, by tools
 * whose `tsconfig` declares no `types`, and by probe programs that compile a
 * single emitted module — none of which may have `@types/node` in scope, and
 * the entry must stay behind a *relative* `require` so a bundler inlines it.
 * Compile-time only: nothing is imported at module evaluation.
 */
declare const require: (specifier: string) => unknown;

/** Lazy self lookup; the compile leaf never imports this descriptor back. */
let ownLookup: TargetLookup | undefined;
function targets(): TargetLookup {
  ownLookup ??= createTargetLookup([descriptor]);
  return ownLookup;
}

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "solid-jsx",
  packageName: "@mxlang/solid",
  defaultTag: "div",
  declarations: { default: solidDeclarations },
  // `typescript-plugin/src/mx-language.ts`: Solid merges the decoded map with
  // the recorded mappings; every other target re-lowers.
  mappings: "merge-recorded",
  load() {
    const { compileSolidUnit } =
      require("./compile.ts") as typeof import("./compile.ts");
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
          targets: options.targets ?? targets(),
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
          (
            require("./compile.ts") as typeof import("./compile.ts")
          ).compileSolidMx(source, {
            ...input,
            targets: input.targets ?? targets(),
          }),
        readCalleeInput: (request) =>
          (
            require("./callee-reader.ts") as typeof import("./callee-reader.ts")
          ).readSolidCalleeInput(request),
      },
    ],
  },
};

export default descriptor;
