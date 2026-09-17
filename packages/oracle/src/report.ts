import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MxRegionCompile } from "@mxlang/parser";
import { parse } from "@mxlang/parser";
import { compileSolidMx } from "@mxlang/solid";
import { compare } from "./compare";
import { discoverFixtures } from "./fixtures";
import { runAngularTable } from "./report-angular";

/**
 * Adapts `compileSolidMx`'s own `(source, options)` signature to the
 * `MxRegionCompile` shape `parse` calls — the parser no longer defaults to
 * this host, so every `.solid.mx` caller supplies it explicitly.
 */
const solidRegionCompile: MxRegionCompile = ({ source, ...rest }) =>
  compileSolidMx(source, rest);

const mxParser = (source: string, filename: string) =>
  parse(source, filename, { mxRegionCompile: solidRegionCompile });

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "..", "..", "fixtures");
const divergencesPath = join(fixturesRoot, "divergences.md");

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const updateGoldens = args.includes("--update");

const fixtures = discoverFixtures(fixturesRoot);
const rows: {
  name: string;
  backend: string;
  variant: string;
  status: string;
}[] = [];
let failed = false;

for (const fixture of fixtures) {
  const results = compare(join(fixturesRoot, fixture), {
    divergencesPath,
    updateGoldens,
    mxParser,
  });
  for (const r of results) {
    rows.push({
      name: r.name,
      backend: r.backend,
      variant: r.variant,
      status: r.status,
    });
    if (r.status === "fail") failed = true;
  }
}

const nameWidth = Math.max(8, ...rows.map((r) => r.name.length));
const backendWidth = Math.max(7, ...rows.map((r) => r.backend.length));
const variantWidth = Math.max(7, ...rows.map((r) => r.variant.length));
const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));

console.log(
  `${"fixture".padEnd(nameWidth)}  ${"backend".padEnd(backendWidth)}  ${"variant".padEnd(variantWidth)}  ${"status".padEnd(statusWidth)}`,
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(nameWidth)}  ${r.backend.padEnd(backendWidth)}  ${r.variant.padEnd(variantWidth)}  ${r.status.padEnd(statusWidth)}`,
  );
}

const counts = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});
console.log("");
console.log(
  Object.entries(counts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", "),
);

const allSkipped = rows.length > 0 && rows.every((r) => r.status === "skipped");
if (allSkipped) {
  console.log("");
  console.log("ALL SKIPPED: no MX parser wired; this is not a pass.");
}

const hasSkipped = rows.some(
  (r) => r.status === "skipped" || r.status === "pending",
);
if (strict && hasSkipped) failed = true;

const angular = runAngularTable(updateGoldens);
if (angular.failed) failed = true;

process.exit(failed ? 1 : 0);
