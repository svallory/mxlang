/**
 * The `astro-html` target descriptor (decisions 129 and 132; unstable).
 *
 * `host.fileKinds` carries the Astro template, `.astro.mx` (decision 134: it is
 * a file kind of the `astro` host, not a target). It has no region compile and
 * no callee reader: `lowerAstroMx` and `convertToTSX` run in the TypeScript
 * plugin's `amx-language.ts`, selected through the registry-private
 * `pipeline: "astro-template"` key.
 *
 * Page `.mx` under the Astro host compiles through `@mxlang/html`'s `compile`
 * under html's strict policy, then the TypeScript plugin rewrites the module's
 * default export (`typeSurface`). Importing this module loads only html's
 * descriptor (policy tables); the compile entry is required inside `load`.
 */
import {
  createTargetLookup,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import htmlDescriptor from "@mxlang/html/descriptor";
import { createAstroTypeSurface } from "./type-surface.ts";

/**
 * The CommonJS `require` this descriptor uses to reach its own compile entry,
 * declared rather than imported. A descriptor is loaded by bundlers, by tools
 * whose `tsconfig` declares no `types`, and by probe programs that compile a
 * single emitted module — none of which may have `@types/node` in scope, and
 * the entry must stay behind a *relative* `require` so a bundler inlines it.
 * Compile-time only: nothing is imported at module evaluation.
 */
declare const require: (specifier: string) => unknown;

/** Lazy self lookup; callers may supply the full target set instead. */
let ownLookup: TargetLookup | undefined;
function targets(): TargetLookup {
  ownLookup ??= createTargetLookup([descriptor]);
  return ownLookup;
}

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "astro-html",
  packageName: "@mxlang/astro",
  defaultTag: htmlDescriptor.defaultTag,
  // `typescript-plugin/src/mx-language.ts` (`hostPolicy.host === "astro" || …`)
  // and `language-server/src/diagnose.ts` (`resolveStrict`) force strict for astro.
  strict: "always",
  // The mapping pass lowers astro under html's tables (`strict ? strictPolicy : policy`).
  declarations: htmlDescriptor.declarations,
  load() {
    // Bare-name require: html's compile entry is cross-package, so a relative
    // path is not possible. Probe-verified to inline into the VSIX bundle
    // under `scripts/bundled-build.ts` on Bun 1.3.14 (rev-230 §3); the real
    // gate is `check-vsix` in registration PR 5.
    const { compile } =
      require("@mxlang/html") as typeof import("@mxlang/html");
    return {
      compileModule: (source, filename, options) =>
        compile(source, filename, {
          customTags: options.customTags,
          warnings: options.warnings,
          strict: options.strict,
          defaultTag: options.defaultTag,
          resolveImport: options.resolveImport,
          targets: options.targets ?? targets(),
        }),
    };
  },
  typeSurface: createAstroTypeSurface,
  host: {
    name: "astro",
    fileKinds: [
      {
        segment: "astro",
        // VS Code contributes language `astromx` for `.astro.mx`
        // (`editors/vscode/package.json`); `AMX_LANGUAGE_ID` in
        // `typescript-plugin/src/amx-language.ts`.
        languageIds: ["astromx"],
        // The label `typescript-plugin/src/index.ts` puts on TS80001/2.
        diagnosticSource: "astromx",
      },
    ],
  },
};

export default descriptor;
