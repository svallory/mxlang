/**
 * The `angular-template` target descriptor (unstable).
 *
 * Page `.mx` compiles to an Angular template string, not a module, so there
 * is no `load`. The TypeScript plugin skips pages; Vite refuses their import
 * with the build guidance in `pending`. `.ng.mx` is served by the editor's
 * Angular template pipeline (`pipeline: "ng-template"` on the registry's
 * `BuiltinFileKind` view).
 */
import type { TargetDescriptor } from "@mxlang/core";
import { angularDeclarations, DEFAULT_TAG } from "./emitter.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "angular-template",
  packageName: "@mxlang/host-angular",
  defaultTag: DEFAULT_TAG,
  declarations: { default: angularDeclarations },
  // Angular's build writes page templates beside their owning components.
  pending:
    "Pages compile to template strings, not modules. Run `mx-angular build` before `ng build`, or `mx-angular watch` next to `ng serve`.",
  host: {
    name: "angular",
    fileKinds: [
      { segment: "ng", languageIds: ["ngmx"], diagnosticSource: "ngmx" },
    ],
  },
};

export default descriptor;
