import {
  createTargetLookup,
  resolveTargetPolicyDetailed,
  type TargetDescriptor,
  type TargetLookup,
} from "@mxlang/core";
import html from "./descriptor.ts";

/**
 * Stand-ins for the other built-in targets. This package cannot import the
 * registry (`@mxlang/targets` depends on it), so the Bun loader's default
 * strictness lookup registers one descriptor per built-in target with the
 * same name, package, host (with its file kinds, as far as registration reads them) and strictness: every selection path the registry
 * honours (`mx.host`, `mx.target`, a dependency on a host package, one or
 * several of them) then resolves the same way here. Only strictness is read
 * from the result. `@mxlang/targets`' `strict-hosts.test.ts` keeps the table
 * equal to the real descriptors and compares the two lookups' answers.
 * Bun-free: tests import it.
 */
const STAND_INS: readonly (readonly [
  name: string,
  packageName: string,
  host: string,
  fileKind: { segment: string; languageIds: readonly string[]; source: string },
  strict?: "always",
])[] = [
  [
    "astro-html",
    "@mxlang/host-astro",
    "astro",
    { segment: "astro", languageIds: ["astromx"], source: "astromx" },
    "always",
  ],
  [
    "solid-jsx",
    "@mxlang/host-solid",
    "solid",
    { segment: "solid", languageIds: ["solidmx", "solid"], source: "solidmx" },
  ],
  [
    "preact-jsx",
    "@mxlang/host-preact",
    "preact",
    { segment: "preact", languageIds: ["preactmx"], source: "preactmx" },
  ],
  [
    "react-jsx",
    "@mxlang/host-react",
    "react",
    { segment: "react", languageIds: ["reactmx"], source: "reactmx" },
  ],
  [
    "hono-jsx",
    "@mxlang/host-hono",
    "hono",
    { segment: "hono", languageIds: ["honomx"], source: "honomx" },
  ],
  [
    "angular-template",
    "@mxlang/host-angular",
    "angular",
    { segment: "ng", languageIds: ["ngmx"], source: "ngmx" },
  ],
];

/** @internal Exported only for `@mxlang/targets`' cross-package test, `strict-hosts.test.ts`. */
export const standInTargets: readonly TargetDescriptor[] = STAND_INS.map(
  ([name, packageName, host, kind, strict]) => ({
    descriptorVersion: 0,
    name,
    packageName,
    defaultTag: html.defaultTag,
    ...(strict ? { strict } : {}),
    host: {
      name: host,
      fileKinds: [
        {
          segment: kind.segment,
          languageIds: kind.languageIds,
          diagnosticSource: kind.source,
        },
      ],
    },
  }),
);

/**
 * `htmlOnly` (a lookup that registers the html target alone) plus
 * {@link standInTargets}, for strictness only, with the registry's reserved
 * names so a descriptor loaded from a package path is accepted or refused
 * exactly as there (`strict-hosts.test.ts` checks the two lists match). The
 * caller's own html descriptor is kept, so its strictness still counts.
 */
export function withStandIns(htmlOnly: TargetLookup): TargetLookup {
  const own = htmlOnly.target("html") ?? html;
  return createTargetLookup([own, ...standInTargets], {
    defaultTarget: own.name,
    reservedNames: ["astro-template", "data"],
  });
}

/**
 * @internal Whether `path` compiles strict under `targets`: the resolved target
 * descriptor declares `strict: "always"`, or the resolved policy carries
 * `mx.strict: true`. Resolved quietly (no deprecation warning per file).
 */
export function strictFor(path: string, targets: TargetLookup): boolean {
  const { policy } = resolveTargetPolicyDetailed(path, targets, {
    quiet: true,
  });
  const descriptor = policy.descriptor ?? targets.target(policy.target);
  return descriptor?.strict === "always" || policy.strict === true;
}
