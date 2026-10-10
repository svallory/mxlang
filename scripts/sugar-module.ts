/**
 * The slice-a1 and a2 proof of `lang-ext-move-sugars-to-mesh` (decisions
 * 183, 196): runs the existing atom, name-sugar and atom-contract suites a
 * second time with every file that declares no `mx.syntax` resolved to the
 * reference module (`packages/core/src/syntax/mesh.ts`, atoms and sugars as
 * layer-2 triggers, their contract checks as its `afterLower`, plus Mesh's
 * `&`), and requires the failures to be
 * exactly the checked-in deltas (`sugar-module/deltas.json`), each naming
 * the ruling that changes it. An unlisted failure, or a listed test that
 * passes, fails the run.
 *
 *   bun run scripts/sugar-module.ts            # every suite below
 *   bun run scripts/sugar-module.ts <file>...  # some of them (deltas of the others are not checked)
 *
 * It needs a build (`bun run build`) and exits 2, naming what is missing,
 * without one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/**
 * The built entries the suites load (`@mxlang/core` and `@mxlang/tsx-bridge`
 * resolve to `dist/`, and the core suites compile through `@mxlang/target-html`'s).
 * Without them every test that reaches one fails with "Cannot find module",
 * which would read as a delta mismatch (Mesh's review of PR 460, F9).
 */
const BUILT = [
  "packages/tsx-bridge/dist/index.js",
  "packages/core/dist/index.js",
  "packages/targets/html/dist/index.js",
];

/** The suites that exercise atoms and the name sugars, built-in today. */
export const SUITES = [
  "packages/core/src/atoms.test.ts",
  "packages/core/src/name-sugar.test.ts",
  "packages/core/src/atom-contracts.test.ts",
  "packages/core/src/atom-candidates.test.ts",
  "packages/targets/data/src/atoms.test.ts",
  "packages/targets/data/src/sugar-default-value.test.ts",
  "packages/targets/data/src/parse.test.ts",
  "packages/targets/data/src/default-tag.test.ts",
  "packages/targets/html/src/atoms.test.ts",
  "packages/targets/html/src/attr-name.test.ts",
  "packages/core/src/custom-tags.test.ts",
  "packages/core/src/attribute-tag-contracts.test.ts",
  "packages/core/src/default-tag.test.ts",
  "packages/core/src/compile.test.ts",
  "packages/core/src/fragment.test.ts",
  "packages/targets/data/src/unknown-tags.test.ts",
  "packages/targets/data/src/attribute-tag-contracts.test.ts",
  // Slice a2: the atom contract checks run from the module's `afterLower`.
  "packages/targets/data/src/contracts.test.ts",
];

interface Delta {
  /** `<file> > <describe> > <test>`, as vitest names it. */
  readonly test: string;
  /** The ruling that changes it: a decision, or a lead ruling of the plan. */
  readonly ruling: string;
  readonly note?: string;
}

const deltas: Delta[] = JSON.parse(
  readFileSync(join(root, "scripts/sugar-module/deltas.json"), "utf8"),
);

const unbuilt = BUILT.filter((entry) => !existsSync(join(root, entry)));
if (unbuilt.length > 0) {
  console.error(
    `sugar-module: not built (${unbuilt.join(", ")} missing); run \`bun run build\` first.`,
  );
  process.exit(2);
}

const files = process.argv.length > 2 ? process.argv.slice(2) : SUITES;
// Under the repo (`node_modules/` is ignored), not the system temp dir: on
// the shared gate `/tmp` is a small memory filesystem (review 460, F9).
const scratch = join(root, "node_modules/.cache/sugar-module");
mkdirSync(scratch, { recursive: true });
const output = join(scratch, `report-${process.pid}.json`);
const preload = join(root, "scripts/sugar-module/preload.mjs");
const run = spawnSync(
  "bun",
  [
    "x",
    "vitest",
    "run",
    ...files,
    "--reporter=dot",
    "--reporter=json",
    `--outputFile=${output}`,
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`,
    },
  },
);
if (run.error) throw run.error;

interface Result {
  testResults: {
    name: string;
    assertionResults: { fullName: string; status: string }[];
    message?: string;
  }[];
}
const report: Result = JSON.parse(readFileSync(output, "utf8"));
rmSync(output, { force: true });

const failed = new Set<string>();
const passed = new Set<string>();
for (const file of report.testResults) {
  const relative = file.name.slice(root.length + 1);
  if (file.assertionResults.length === 0 && file.message) {
    failed.add(
      `${relative} > (file failed to run: ${file.message.split("\n")[0]})`,
    );
  }
  for (const test of file.assertionResults) {
    const id = `${relative} > ${test.fullName}`;
    if (test.status === "failed") failed.add(id);
    if (test.status === "passed") passed.add(id);
  }
}

const inScope = (test: string) =>
  files.some((file) => test.startsWith(`${file} > `));
const listed = new Set(
  deltas.filter((d) => inScope(d.test)).map((d) => d.test),
);
const unlisted = [...failed].filter((test) => !listed.has(test));
const stale = [...listed].filter((test) => passed.has(test));
const missing = [...listed].filter(
  (test) => !passed.has(test) && !failed.has(test),
);

for (const [title, tests] of [
  ["failed through the module, not listed in deltas.json", unlisted],
  ["listed in deltas.json but passing through the module (stale)", stale],
  ["listed in deltas.json but not found", missing],
] as const) {
  if (tests.length === 0) continue;
  console.error(`\n${tests.length} ${title}:`);
  for (const test of tests) console.error(`  ${test}`);
}
const ok = unlisted.length === 0 && stale.length === 0 && missing.length === 0;
console.log(
  `\nsugar-module: ${passed.size} passed, ${failed.size} failed (${listed.size} listed deltas) — ${ok ? "OK" : "MISMATCH"}`,
);
process.exit(ok ? 0 : 1);
