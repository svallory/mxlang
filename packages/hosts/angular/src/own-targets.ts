/**
 * This package's own target table (decisions 129 and 132): the one descriptor
 * `@mxlang/host-angular` exports, bound to a `TargetLookup`.
 *
 * Its own module because the import graph is a cycle otherwise:
 * `descriptor.ts` reads `angularDeclarations` from `emitter.ts` at module
 * evaluation, so anything `emitter.ts` imports must not reach
 * `descriptor.ts` — a top-level `createTargetLookup([descriptor])` there
 * would read a half-initialized `angularDeclarations`. `emitter.ts` therefore
 * asks the compile's own lookup (`ctx.targets`, required on `Ctx`) which file
 * kinds exist, and every other file in this package reads the lookup here.
 *
 * A direct entry (`build`, `watch`, `discover`, the CLI) that names no lookup
 * of its own uses this one (design note §5.1, rule (c)); a tool compiling
 * several targets passes the built-in registry's lookup instead.
 */
import { createTargetLookup, type TargetLookup } from "@mxlang/core";
import descriptor from "./descriptor.ts";

/** The lookup over this package's own single descriptor. */
export const angularOwnTargets: TargetLookup = createTargetLookup([descriptor]);
