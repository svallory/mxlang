/**
 * The `data` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./declarations.ts` only (it imports
 * `@mxlang/core` and nothing that compiles). The compile module is required by
 * a relative path inside `load`, and it in turn requires the parser lazily, so
 * neither `load()` nor importing the registry loads `@marko/compiler`.
 *
 * The target is hostless: no `host`, no `legacyHostValues`. It has no file
 * kinds and no `mx.tags[].hosts` filter key, so a project selects it with
 * `mx.target: "data"` or by depending on `@mxlang/data`.
 *
 * No `translator` and no `mappings`: the mapping pass is the only reader of
 * the first, and the mapping mode (with the TS plugin's guard for a target
 * that returns no `map` and no `mappings`) is chosen in data PR 4.
 */
import type { TargetDescriptor } from "@mxlang/core";
import { dataDeclarations } from "./declarations.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "data",
  packageName: "@mxlang/data",
  declarations: { default: dataDeclarations },
  load() {
    const { compileModule } =
      require("./compile.ts") as typeof import("./compile.ts");
    return { compileModule };
  },
};

export default descriptor;
