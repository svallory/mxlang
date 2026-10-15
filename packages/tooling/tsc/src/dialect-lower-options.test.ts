import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  probeProject,
} from "../../../../test-fixtures/dialects/probe.ts";
import { runInProcess } from "./in-process.ts";

/**
 * `mx-tsc` checks a dialect's files with the dialect's own `structural`,
 * `imports` and `unknownTags` (it passes none of the three): a misspelt tag
 * prints the dialect's code, `MX_UNKNOWN_TAG`, where TypeScript prints
 * `TS<number>`, and a structural construct prints MX's own error.
 */

afterEach(() => cleanupProbeProjects());

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    noEmit: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "esnext",
    jsx: "preserve",
    types: [],
  },
  include: ["**/*.probe"],
});

const MODULE = `module.exports = { default: {
  tagRules: "none",
  table: {},
  contracts: { entity: {}, field: { parents: ["entity"] } },
  structural: "reject",
  imports: "pass",
  unknownTags: "reject",
} };
`;

const SOURCE = `import x from "./x"
entity
  field
  <if=true><field/></if>
widget
`;

it("R10: prints the dialect's strictness, the unknown tag with its code", {
  timeout: 120_000,
}, () => {
  const project = probeProject({
    "tsconfig.json": TSCONFIG,
    "dialect.cjs": MODULE,
    "a.probe": SOURCE,
  });
  const result = runInProcess(["-p", project.dir, "--pretty", "false"]);
  const file = relative(process.cwd(), project.path("a.probe"));
  expect(result.status).toBe(1);
  expect(stripVTControlCharacters(result.stderr + result.stdout)).toBe(
    `${file}(4,3): error MX_STRUCTURAL_CONSTRUCT: Data files are static, so they do not evaluate \`<if>\`\n` +
      `${file}(5,1): error MX_UNKNOWN_TAG: \`<widget>\` is not a known tag in the \`probe\` dialect\n`,
  );
});
