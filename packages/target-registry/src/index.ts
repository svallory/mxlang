/**
 * The built-in target table (decisions 129 and 132; unstable).
 *
 * A closed list of the target descriptors the repo's own hosts export, plus a
 * lookup built over it. Nothing consumes this package yet; the tooling
 * switches to it from the closed host lists in a later change.
 *
 * Every import below is a light `./descriptor` subpath: loading this module
 * pulls in policy tables and emitters' declaration objects, never
 * `@marko/compiler` or a compile entry (those are reached by each descriptor's
 * `load()`). The imports are static so a bundler inlines them.
 */

import angular from "@mxlang/angular/descriptor";
import astro from "@mxlang/astro/descriptor";
import {
  createTargetLookup,
  type HostFileKind,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import data from "@mxlang/data/descriptor";
import hono from "@mxlang/hono/descriptor";
import html from "@mxlang/html/descriptor";
import preact from "@mxlang/preact/descriptor";
import react from "@mxlang/react/descriptor";
import solid from "@mxlang/solid/descriptor";

/**
 * A host file kind plus the key of the editor pipeline that serves it. The key
 * is tool glue for the built-ins, so it lives here and never in core
 * (`pipeline: "region"` is TypeScript with MX regions, `"ng-template"` is the
 * Angular template pipeline, `"astro-template"` is the `.astro.mx` pipeline,
 * a file kind of the `astro` host per decision 134).
 */
export interface BuiltinFileKind extends HostFileKind {
  readonly pipeline: "region" | "ng-template" | "astro-template";
}

/** The built-in targets, in registration order (the order `mx.host` values are listed in; hostless `data` last, with no `mx.host` value). */
export const builtinTargets: readonly TargetDescriptor[] = [
  html,
  astro,
  solid,
  preact,
  react,
  hono,
  angular,
  data,
];

/**
 * `astro-template` is reserved for the Astro template output (`.astro.mx`, decision 134) (design note §8 Q5), so a
 * third-party target cannot take it before the Astro host does.
 */
export const builtinTargetLookup: TargetLookup = createTargetLookup(
  builtinTargets,
  { reservedNames: ["astro-template"] },
);

const PIPELINES: Readonly<Record<string, BuiltinFileKind["pipeline"]>> = {
  solid: "region",
  ng: "ng-template",
  astro: "astro-template",
};

/** Every built-in host file kind with its pipeline key. */
export const builtinFileKinds: readonly BuiltinFileKind[] = builtinTargets
  .flatMap((target) => target.host?.fileKinds ?? [])
  .map((kind) => {
    const pipeline = PIPELINES[kind.segment];
    if (!pipeline) {
      throw new Error(
        `@mxlang/target-registry: built-in file kind "${kind.segment}" has no editor pipeline`,
      );
    }
    return { ...kind, pipeline };
  });

export type {
  HostFileKind,
  TargetDescriptor,
  TargetLookup,
} from "@mxlang/core";
