// Preloaded into every vitest worker by `scripts/sugar-module.ts` (through
// NODE_OPTIONS): makes every file with no `mx.syntax` resolve to the
// reference atoms-and-sugars module, so the existing suites run through it
// (lang-ext-move-sugars-to-mesh, slice a1). Read by core's
// `resolveSyntaxOf` from this process global, in every copy of core.
import { pathToFileURL } from "node:url";

const fixture = new URL(
  "../../packages/core/src/syntax/mesh.ts",
  import.meta.url,
);
const module = await import(pathToFileURL(fixture.pathname).href);
globalThis[Symbol.for("@mxlang/core:fallbackSyntaxForTesting")] =
  module.default;
