/**
 * The `angular-template` target descriptor (decisions 129 and 132; unstable).
 *
 * Page `.mx` is not wired for this target yet: no `load`, and `pending` is the
 * text the TypeScript plugin and the Vite plugin print today
 * (`the angular host is not wired into @mxlang/typescript-plugin yet (phase 2)`,
 * `typescript-plugin/src/mx-language.ts`; the Vite plugin's `index.ts` has the
 * same sentence). `.ng.mx` is served by the editor's Angular template pipeline
 * (`pipeline: "ng-template"` on the registry's `BuiltinFileKind` view).
 */
import type { TargetDescriptor } from "@mxlang/core";
import { angularDeclarations, DEFAULT_TAG } from "./emitter.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "angular-template",
  packageName: "@mxlang/angular",
  defaultTag: DEFAULT_TAG,
  declarations: { default: angularDeclarations },
  // No compileModule or compileRegion yet: there is no HostOptions boundary
  // to forward a caller's targets through. Keep the page path unwired.
  pending: "phase 2",
  host: {
    name: "angular",
    fileKinds: [
      { segment: "ng", languageIds: ["ngmx"], diagnosticSource: "ngmx" },
    ],
  },
};

export default descriptor;
