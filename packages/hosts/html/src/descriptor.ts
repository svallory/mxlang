/**
 * The `html` target descriptor (decisions 129 and 132; unstable).
 *
 * Importing this module must stay cheap: it loads `./translate.ts` (the policy
 * tables, which import only `@mxlang/core`) and nothing that compiles. The
 * compile entry and the translator are reached through `require("./index.ts")`
 * inside a function body, on a relative path, so Bun inlines them into a
 * bundle and nothing loads `@marko/compiler` until a tool compiles.
 */
import type { TargetDescriptor } from "@mxlang/core";
import { policy, strictPolicy } from "./translate.ts";

const descriptor: TargetDescriptor = {
  descriptorVersion: 0,
  name: "html",
  packageName: "@mxlang/html",
  // `translator` is `host-policy.ts`'s deprecated alias (the warning text lives there).
  legacyHostValues: [
    { value: "html" },
    { value: "translator", deprecated: true },
  ],
  declarations: { default: policy, strict: strictPolicy },
  // The mapping pass (`typescript-plugin/src/mx-language.ts`, `createHtmlMappings`)
  // looks tags up in html's translator for every target (disagreement D3), so
  // this is that same object, reached lazily.
  get translator() {
    return (require("./index.ts") as typeof import("./index.ts")).translator;
  },
  load() {
    const { compile } = require("./index.ts") as typeof import("./index.ts");
    return {
      compileModule: (source, filename, options) =>
        compile(source, filename, {
          customTags: options.customTags,
          warnings: options.warnings,
          strict: options.strict,
          resolveImport: options.resolveImport,
        }),
    };
  },
};

export default descriptor;
