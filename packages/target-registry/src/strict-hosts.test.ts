import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTargetLookup } from "@mxlang/core";
import {
  standInTargets,
  strictFor,
  withStandIns,
} from "../../targets/html/src/foreign-strict.ts";
import { builtinLookup, builtinTargets, htmlTarget } from "./index.ts";

const strictnessTargets = withStandIns(createTargetLookup([htmlTarget]));

/**
 * `@mxlang/target-html`'s Bun loader cannot import this registry, so it
 * resolves strictness through stand-ins for the other built-in targets. The
 * property that matters is that its answer is the registry's, for every way a
 * project can select a target. (The loader's module is imported by relative
 * path: its stand-ins are exported for this test alone.)
 */
const hostPackages = builtinTargets.flatMap((t) =>
  t.host ? [t.packageName] : [],
);
/** A package-path target, strict always, that takes a segment the registry's angular host owns. */
const NG_TARGETS = ["ng-a", "ng-b"] as const;
const manifests: [string, object, registryFirst?: boolean][] = [
  ["no config", {}],
  ["mx.strict alone", { mx: { strict: true } }],
  ["mx.host solid with strict", { mx: { host: "solid", strict: true } }],
  [
    "mx.target preact-jsx with strict",
    { mx: { target: "preact-jsx", strict: true } },
  ],
  ["mx.host html with strict", { mx: { host: "html", strict: true } }],
  ["mx.target html with host astro", { mx: { target: "html", host: "astro" } }],
  ["an unknown host", { mx: { host: "nonesuch", strict: true } }],
  [
    "two host dependencies",
    { dependencies: { "@mxlang/host-astro": "1", "@mxlang/host-preact": "1" } },
  ],
  [
    "host solid with an astro dependency",
    { mx: { host: "solid" }, dependencies: { "@mxlang/host-astro": "1" } },
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
            { dependencies: { [t.packageName]: "1" } },
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
  // A target loaded from a package path whose descriptor takes a reserved name.
  ["a package-path target named data", { mx: { target: "@fake/data-target" } }],
  // Refused by the registry (angular owns segment ng), so non-strict in both,
  // whichever lookup resolves the descriptor first.
  ["a package-path ng host, stand-ins first", { mx: { target: "@fake/ng-a" } }],
  [
    "a package-path ng host, registry first",
    { mx: { target: "@fake/ng-b" } },
    true,
  ],
];

/** One project directory per row under a single root, written once. */
let root = "";
const projectOf = (index: number): string => join(root, String(index));

/** Writes one fake target package once, under the shared root. */
function writePackage(name: string, descriptor: object): void {
  const pkg = join(root, "node_modules", "@fake", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: `@fake/${name}`, main: "index.cjs" }),
  );
  writeFileSync(
    join(pkg, "index.cjs"),
    `module.exports = {
  ...${JSON.stringify(descriptor)},
  descriptorVersion: 0,
  defaultTag: "div",
  strict: "always",
  load: () => ({ compileModule: () => ({ code: "", dependencies: [] }) }),
};
`,
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mx-strict-diff-"));
  // Node resolution walks up from each project directory to this root.
  writePackage("data-target", {
    name: "data",
    packageName: "@fake/data-target",
  });
  for (const name of NG_TARGETS)
    writePackage(name, {
      name,
      packageName: `@fake/${name}`,
      host: {
        name: "ng",
        fileKinds: [{ segment: "ng", diagnosticSource: "x" }],
      },
    });
  manifests.forEach(([, manifest], index) => {
    const dir = projectOf(index);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

it.each(
  manifests.map(
    ([name, , registryFirst], index) => [index, name, registryFirst] as const,
  ),
)(
  "strictness equals the registry's for #%i: %s",
  (index, _name, registryFirst) => {
    const path = join(projectOf(index), "a.mx");
    const [first, second] = registryFirst
      ? [builtinLookup(), strictnessTargets]
      : [strictnessTargets, builtinLookup()];
    const a = strictFor(path, first);
    expect(strictFor(path, second)).toBe(a);
  },
);

it("a package-path host taking the segment of a built-in host is non-strict, as the registry refuses it", () => {
  for (const [index, [name]] of manifests.entries())
    if (name.startsWith("a package-path ng host"))
      expect(strictFor(join(projectOf(index), "a.mx"), builtinLookup())).toBe(
        false,
      );
});

it("the stand-ins cover every built-in target but html, with its package, host and strictness", () => {
  const view = (t: (typeof builtinTargets)[number]) => ({
    name: t.name,
    packageName: t.packageName,
    host: t.host?.name,
    strict: t.strict,
    kinds: t.host?.fileKinds?.map((k) => [
      k.segment,
      k.languageIds,
      k.diagnosticSource,
    ]),
    configKey: t.configKey,
  });
  expect(standInTargets.map(view)).toEqual(
    builtinTargets.filter((t) => t.name !== "html").map(view),
  );
});

it("the stand-in lookup reserves the registry's names", () => {
  expect(strictnessTargets.reservedNames?.()).toEqual(
    builtinLookup().reservedNames?.(),
  );
});
