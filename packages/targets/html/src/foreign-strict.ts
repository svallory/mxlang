import {
  createTargetLookup,
  resolveTargetPolicyDetailed,
  TargetLookupError,
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
 * from the result, and the stand-ins carry no `declarations` (so `defaultTag`,
 * built-in tags and the like are html's, not the real target's): the lookup
 * from {@link withStandIns} must never be used for anything but
 * {@link strictFor}. `@mxlang/targets`' `strict-hosts.test.ts` keeps the table
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
 * `lookup` plus a stand-in ({@link standInTargets}) for each built-in target
 * it lacks, for strictness only, with the registry's reserved names so a
 * descriptor loaded from a package path is accepted or refused exactly as
 * there (`strict-hosts.test.ts` checks the two lists match). The caller's own
 * descriptors are kept (a target it registers but masks from selection is
 * rebuilt unmasked, which strictness does not read), so their strictness still
 * counts. Stand-ins are added one at a time and a stand-in the rebuilt set
 * would refuse (a name, package, host or segment the caller's lookup already
 * uses, or any other set rule) is skipped: a lookup the loader accepted
 * before never makes it throw.
 */
export function withStandIns(lookup: TargetLookup): TargetLookup {
  const own = lookup
    .targetNames()
    .map((name) => lookup.target(name) as TargetDescriptor);
  for (const t of [...own]) {
    for (
      let base = t.builtOn === undefined ? undefined : lookup.target(t.builtOn);
      base !== undefined && !own.includes(base);
      base = base.builtOn === undefined ? undefined : lookup.target(base.builtOn)
    )
      own.push(base);
  }
  const options = {
    defaultTarget: lookup.defaultTarget(),
    // The registry's names, minus any the caller's own set already uses.
    reservedNames: [
      ...new Set([
        ...(lookup.reservedNames?.() ?? []),
        ...["astro-template", "data"].filter(
          (name) => !own.some((t) => t.name === name),
        ),
      ]),
    ],
  };
  const kept: TargetDescriptor[] = [];
  for (const stand of standInTargets) {
    try {
      createTargetLookup([...own, ...kept, stand], options);
      kept.push(stand);
    } catch (error) {
      if (!(error instanceof TargetLookupError)) throw error;
    }
  }
  return createTargetLookup([...own, ...kept], options);
}

/**
 * @internal Whether `path` compiles strict under `targets`: the resolved target
 * descriptor declares `strict: "always"`, or the resolved policy carries
 * `mx.strict: true`. Resolved quietly (no deprecation warning per file).
 * `mx.strict` is ignored only for a target that names a host and declares no
 * strict mode (the JSX hosts and Angular), as the other tools ignore it; a
 * hostless loaded target is compiled through html, which has one.
 */
export function strictFor(path: string, targets: TargetLookup): boolean {
  const { policy } = resolveTargetPolicyDetailed(path, targets, {
    quiet: true,
  });
  const descriptor = policy.descriptor ?? targets.target(policy.target);
  if (descriptor?.strict === "always") return true;
  const noStrictMode =
    descriptor?.host !== undefined && descriptor.declarations?.strict === undefined;
  return policy.strict === true && !noStrictMode;
}
