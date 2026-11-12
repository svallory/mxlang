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
/** Stands for a strict mode's policy table; only its presence is read. */
const STRICT_MODE = {
  default: {},
  strict: {},
} as unknown as TargetDescriptor["declarations"];

const STAND_INS: readonly (readonly [
  name: string,
  packageName: string,
  host: string,
  fileKind: { segment: string; languageIds: readonly string[]; source: string },
  strict?: "always",
  declaresStrict?: boolean,
])[] = [
  [
    "astro-html",
    "@mxlang/host-astro",
    "astro",
    { segment: "astro", languageIds: ["astromx"], source: "astromx" },
    "always",
    true,
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
  ([name, packageName, host, kind, strict, declaresStrict]) => ({
    descriptorVersion: 0,
    name,
    packageName,
    defaultTag: html.defaultTag,
    ...(strict ? { strict } : {}),
    // `declarations.strict` is read for its presence only: whether the target
    // has a strict mode at all (astro, as html; the JSX hosts and Angular do not).
    ...(declaresStrict ? { declarations: STRICT_MODE } : {}),
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
 * `lookup` plus a stand-in ({@link standInTargets}) for each built-in target
 * it lacks, for strictness only, with the registry's reserved names so a
 * descriptor loaded from a package path is accepted or refused exactly as
 * there (`strict-hosts.test.ts` checks the two lists match). The caller's own
 * descriptors are kept, so their strictness still counts, and a stand-in whose
 * name, package or host the lookup already has is skipped.
 */
export function withStandIns(lookup: TargetLookup): TargetLookup {
  const own = lookup
    .targetNames()
    .map((name) => lookup.target(name) as TargetDescriptor);
  const missing = standInTargets.filter(
    (stand) =>
      !own.some(
        (t) =>
          t.name === stand.name ||
          t.packageName === stand.packageName ||
          (t.host !== undefined && t.host.name === stand.host?.name),
      ),
  );
  const reserved = new Set([
    ...(lookup.reservedNames?.() ?? []),
    "astro-template",
    "data",
  ]);
  return createTargetLookup([...own, ...missing], {
    defaultTarget: lookup.defaultTarget(),
    reservedNames: [...reserved],
  });
}

/**
 * @internal Whether `path` compiles strict under `targets`: the resolved target
 * descriptor declares `strict: "always"`, or the resolved policy carries
 * `mx.strict: true` and the target declares a strict mode. Resolved quietly (no deprecation warning per file).
 */
export function strictFor(path: string, targets: TargetLookup): boolean {
  const { policy } = resolveTargetPolicyDetailed(path, targets, {
    quiet: true,
  });
  const descriptor = policy.descriptor ?? targets.target(policy.target);
  // `mx.strict` counts only for a target that has a strict mode: the JSX hosts
  // and Angular have none and ignore it, as the other tools do.
  return (
    descriptor?.strict === "always" ||
    (policy.strict === true && descriptor?.declarations?.strict !== undefined)
  );
}
