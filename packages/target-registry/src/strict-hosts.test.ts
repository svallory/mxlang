import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
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
 * project can select a target. (The loader's module is imported by relative
 * path: its stand-ins are exported for this test alone.)
 */
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
];

/** One project directory per row under a single root, written once. */
let root = "";
const projectOf = (index: number): string => join(root, String(index));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mx-strict-diff-"));
  manifests.forEach(([, manifest], index) => {
    const dir = projectOf(index);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    const pkg = join(dir, "node_modules", "@fake", "data-target");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@fake/data-target", main: "index.cjs" }),
    );
    writeFileSync(
      join(pkg, "index.cjs"),
      `module.exports = {
  descriptorVersion: 0,
  name: "data",
  packageName: "@fake/data-target",
  defaultTag: "div",
  strict: "always",
  load: () => ({ compileModule: () => ({ code: "", dependencies: [] }) }),
};
`,
    );
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

it.each(manifests.map(([name], index) => [index, name] as const))(
  "strictness equals the registry's for #%i: %s",
  (index) => {
    const path = join(projectOf(index), "a.mx");
    expect(strictFor(path, strictnessTargets)).toBe(
      strictFor(path, builtinLookup()),
    );
  },
);

it("the stand-ins cover every built-in target but html, with its package, host and strictness", () => {
  const view = (t: (typeof builtinTargets)[number]) => ({
    name: t.name,
    packageName: t.packageName,
    host: t.host?.name,
    strict: t.strict,
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
