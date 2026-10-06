/**
 * Prints the differential's counts and every difference, for a reviewer to
 * re-run independently:
 *
 *   bun run --cwd packages/parse-differential report
 *
 * Needs `bun install` and `bun run build` first (`@mxlang/core` resolves to
 * its `dist/`).
 */
import { PROBES } from "../../parser/src/template/grammar-spec.cases.ts";
import { compare, fixtureInputs, INPUT_GLOB } from "./differential.ts";
import { projectMarko } from "./marko.ts";

const differences: string[] = [];
const show = (label: string, outcome: ReturnType<typeof compare>) => {
  differences.push(`--- ${label}`);
  if (outcome.note) differences.push(`  note: ${outcome.note}`);
  for (const line of outcome.text) differences.push(`  text: ${line}`);
  const length = Math.max(outcome.mx.length, outcome.marko.length);
  for (let i = 0; i < length; i++) {
    if (outcome.mx[i] === outcome.marko[i]) continue;
    differences.push(`  mx:    ${outcome.mx[i] ?? "(none)"}`);
    differences.push(`  today: ${outcome.marko[i] ?? "(none)"}`);
  }
};

const fixtures = fixtureInputs();
let fixturesEqual = 0;
for (const { path, source } of fixtures) {
  const outcome = compare(source);
  if (outcome.equal) fixturesEqual++;
  else show(path, outcome);
}

let accepted = 0;
let acceptedEqual = 0;
let rejected = 0;
let rejectedEqual = 0;
let crashed = 0;
for (const probe of PROBES) {
  const today = projectMarko(probe.input);
  const outcome = compare(probe.input);
  if (today.crash !== undefined) crashed++;
  else if (today.document.error !== null) {
    rejected++;
    if (outcome.equal) rejectedEqual++;
  } else {
    accepted++;
    if (outcome.equal) acceptedEqual++;
  }
  if (!outcome.equal)
    show(`${probe.id} ${JSON.stringify(probe.input)}`, outcome);
}

console.log(
  `fixtures (${INPUT_GLOB}): ${fixtures.length}, equal ${fixturesEqual}`,
);
console.log(
  `corpus: ${PROBES.length} probes; today accepts ${accepted} (equal ${acceptedEqual}), rejects ${rejected} (equal on message and range ${rejectedEqual}), crashes ${crashed}`,
);
console.log(differences.join("\n"));
