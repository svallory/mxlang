/**
 * The `data` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./target-base.ts` (and through it `./declarations.ts`) only (it imports
 * `@mxlang/core` and nothing that compiles). The compile module is required by
 * a relative path inside `load`, and it in turn requires the parser lazily, so
 * neither `load()` nor importing the registry loads `@marko/compiler`.
 *
 * The target is hostless: no `host`, no `legacyHostValues`. It has no file
 * kinds and no `mx.tags[].hosts` filter key, so a project selects it with
 * `mx.target: "data"` or by depending on `@mxlang/data`.
 *
 * A lazy `translator` for the registry's `defaultTag` check, and no
 * `mappings`: the mapping mode (with the TS plugin's guard for a target that
 * returns no `map` and no `mappings`) is chosen in data PR 4.
 */
import { createTargetLookup, type TargetDescriptor } from "@mxlang/core";
import { dataTargetBase } from "./target-base.ts";

declare const require: (specifier: string) => unknown;

const descriptor: TargetDescriptor = {
  ...dataTargetBase,
  // Lazy, like `load`: the translator reaches `@marko/compiler`. It exists so
  // the registry can ask the lookup a data compile uses (decision 145: is a
  // `defaultTag` a plain tag here?); the mapping pass does not read it for
  // data, which is not wired into tooling.
  get translator() {
    return (
      require("./translator.ts") as typeof import("./translator.ts")
    ).dataTranslator(createTargetLookup([dataTargetBase]));
  },
  load() {
    const { compileModule } =
      require("./compile.ts") as typeof import("./compile.ts");
    return { compileModule };
  },
};

export default descriptor;
