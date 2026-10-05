/**
 * The `preact-jsx` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module loads `./emitter.ts` (the declarations) only; the
 * compile entry is required by a relative path inside `load`, from
 * `./compile.ts` — a descriptor-free leaf. The descriptor never requires
 * `./index.ts`: the index imports this module to build the package's own
 * lookup, so a require back would close an entry-point cycle that a bundler
 * answers by silently dropping an entry with exit 0 (rev-245 BUG 1, pinned by
 * `packages/target-registry/src/bundle-smoke.test.ts`).
 */
import {
  createTargetLookup,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import { preactDeclarations } from "./emitter.ts";

/**
 * The CommonJS `require` this descriptor uses to reach its own compile entry,
 * declared rather than imported. A descriptor is loaded by bundlers, by tools
 * whose `tsconfig` declares no `types`, and by probe programs that compile a
 * single emitted module — none of which may have `@types/node` in scope, and
 * the entry must stay behind a *relative* `require` so a bundler inlines it.
 * Compile-time only: nothing is imported at module evaluation.
 */
declare const require: (specifier: string) => unknown;

/**
 * The lookup over this descriptor alone, for `load` when the caller names no
 * lookup: the same table `index.ts` builds over this same descriptor object,
 * composed here so the descriptor needs nothing from the index.
 */
let ownLookup: TargetLookup | undefined;
function targets(): TargetLookup {
  ownLookup ??= createTargetLookup([descriptor]);
  return ownLookup;
}

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "preact-jsx",
  packageName: "@mxlang/preact",
  defaultTag: "div",
  declarations: { default: preactDeclarations },
  load() {
    const { compilePreactMx } =
      require("./compile.ts") as typeof import("./compile.ts");
    return {
      compileModule: (source, filename, options) =>
        compilePreactMx(source, filename, {
          customTags: options.customTags,
          warnings: options.warnings,
          typeCheck: options.typeCheck,
          resolveImport: options.resolveImport,
          targets: options.targets ?? targets(),
        }),
    };
  },
  host: { name: "preact" },
};

export default descriptor;
