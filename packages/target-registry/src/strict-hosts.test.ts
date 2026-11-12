import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTargetPolicyDetailed } from "@mxlang/core";
import { afterAll, expect, it } from "vitest";
import {
  standInTargets,
  strictFor,
  strictnessTargets,
} from "../../targets/html/src/foreign-strict.ts";
import { builtinLookup, builtinTargets } from "./index.ts";

/**
 * `@mxlang/target-html`'s Bun loader cannot import this registry, so it
 * resolves strictness through stand-ins for the other built-in targets. The
 * property that matters is that its answer is the registry's, for every way a
 * project can select a target.
 */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function registryStrict(path: string): boolean {
  const { policy } = resolveTargetPolicyDetailed(path, builtinLookup(), {
    quiet: true,
  });
  const descriptor = policy.descriptor ?? builtinLookup().target(policy.target);
  return descriptor?.strict === "always" || policy.strict === true;
}

const hostPackages = builtinTargets.flatMap((t) =>
  t.host ? [t.packageName] : [],
);
const manifests: [string, object][] = [
  ["no config", {}],
  ["mx.strict alone", { mx: { strict: true } }],
  ["mx.host html with strict", { mx: { host: "html", strict: true } }],
  ["mx.target html with host astro", { mx: { target: "html", host: "astro" } }],
  ["an unknown host", { mx: { host: "nonesuch", strict: true } }],
  [
    "two host dependencies",
    {
      dependencies: { "@mxlang/host-astro": "1", "@mxlang/host-preact": "1" },
    },
  ],
  [
    "host solid with an astro dependency",
    {
      mx: { host: "solid" },
      dependencies: { "@mxlang/host-astro": "1" },
    },
  ],
  ...builtinTargets.flatMap((t): [string, object][] => [
    [`mx.target ${t.name}`, { mx: { target: t.name } }],
    [
      `mx.target ${t.name} with strict`,
      { mx: { target: t.name, strict: true } },
    ],
    ...(t.host
      ? ([
          [`mx.host ${t.host.name}`, { mx: { host: t.host.name } }],
          [
            `dependency ${t.packageName}`,
            {
              dependencies: { [t.packageName]: "1" },
            },
          ],
        ] as [string, object][])
      : []),
  ]),
  [
    "every host dependency",
    {
      dependencies: Object.fromEntries(hostPackages.map((p) => [p, "1"])),
    },
  ],
];

it.each(manifests)(
  "strictness equals the registry's for %s",
  (_name, manifest) => {
    const root = mkdtempSync(join(tmpdir(), "mx-strict-diff-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    const path = join(root, "a.mx");
    expect(strictFor(path, strictnessTargets)).toBe(registryStrict(path));
  },
);

it("the stand-ins cover every built-in target but html, with its package, host and strictness", () => {
  const real = builtinTargets
    .filter((t) => t.name !== "html")
    .map((t) => ({
      name: t.name,
      packageName: t.packageName,
      host: t.host?.name,
      strict: t.strict,
    }));
  const stood = standInTargets.map((t) => ({
    name: t.name,
    packageName: t.packageName,
    host: t.host?.name,
    strict: t.strict,
  }));
  expect(stood).toEqual(real);
});
