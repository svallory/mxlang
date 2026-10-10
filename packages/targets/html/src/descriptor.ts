/**
 * The `html` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module must stay cheap: it loads `./translate.ts` (the policy
 * tables, which import only `@mxlang/core`) and nothing that compiles. The
 * compile entry is reached through `./compiler.ts` — a descriptor-free leaf —
 * by a relative `require` inside a function body, so Bun inlines it into a
 * bundle and nothing loads `@marko/compiler` until a tool compiles.
 *
 * The descriptor never requires `./index.ts`: the index imports this module to
 * build the package's own lookup, so a require back would close an
 * entry-point cycle that Bun's multi-entry build answers by silently dropping
 * `dist/index.js` with exit 0 (rev-245 BUG 1, pinned by
 * `packages/target-registry/src/bundle-smoke.test.ts`).
 */
import {
  createTargetLookup,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import { DEFAULT_TAG, policy, strictPolicy } from "./translate.ts";

/**
 * The CommonJS `require` this descriptor uses to reach the compile entry,
 * declared rather than imported. A descriptor is loaded by bundlers, by tools
 * whose `tsconfig` declares no `types`, and by probe programs that compile a
 * single emitted module — none of which may have `@types/node` in scope, and
 * the entry must stay behind a *relative* `require` so a bundler inlines it.
 * Compile-time only: nothing is imported at module evaluation.
 */
declare const require: (specifier: string) => unknown;

/**
 * The lookup over this descriptor alone, for `translator` and `load` when the
 * caller names no lookup: the same table `index.ts` builds over this same
 * descriptor object, composed here so the descriptor needs nothing from the
 * index.
 */
let ownLookup: TargetLookup | undefined;
function targets(): TargetLookup {
  ownLookup ??= createTargetLookup([descriptor]);
  return ownLookup;
}

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "html",
  packageName: "@mxlang/target-html",
  defaultTag: DEFAULT_TAG,
  // `translator` is `host-policy.ts`'s deprecated alias (the warning text lives there).
  legacyHostValues: [
    { value: "html" },
    { value: "translator", deprecated: true },
  ],
  declarations: { default: policy, strict: strictPolicy },
  // The mapping pass (`typescript-plugin/src/mx-language.ts`, `createHtmlMappings`)
  // looks tags up in html's translator for every target (disagreement D3), so
  // this is that same translator configuration, reached lazily over this
  // descriptor's own table.
  get translator() {
    return (
      require("./compiler.ts") as typeof import("./compiler.ts")
    ).createHtmlTranslator(targets());
  },
  load() {
    const { compileHtml } =
      require("./compiler.ts") as typeof import("./compiler.ts");
    return {
      compileModule: (source, filename, options) =>
        compileHtml(source, filename, {
          customTags: options.customTags,
          warnings: options.warnings,
          strict: options.strict,
          typeCheck: options.typeCheck,
          defaultTag: options.defaultTag,
          resolveImport: options.resolveImport,
          targets: options.targets ?? targets(),
        }),
    };
  },
};

export default descriptor;
