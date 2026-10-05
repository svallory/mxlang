/**
 * `bun run build:home` — the gate the docs build runs first.
 *
 * Order matters: the example is compiled and rendered before anything is
 * written, so a language change or a stale marker fails the build with the
 * file and line that moved rather than shipping a landing page that lies.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { loadMx } from "@mxlang/html";
import {
  compileExample,
  examplePath,
  exampleSection,
  indexPath,
  readExample,
  readMarkers,
  spliceIndex,
  validate,
} from "./home-example.ts";

/**
 * Input the example is rendered with. Rendering is part of the gate: an
 * example that compiles but throws on a missing prop is still not real.
 */
const SAMPLE = {
  products: [
    {
      id: "kettle",
      name: "Kettle",
      blurb: "<b>Fast</b> boil",
      price: 39.9,
      tags: ["kitchen", "sale"],
    },
    {
      id: "mug",
      name: "Mug",
      blurb: "Plain ceramic",
      price: 9.5,
      tags: ["kitchen"],
    },
  ],
  currency: "USD",
};

const errors: string[] = [];
const { source, lines } = readExample();
const markers = readMarkers();

for (const problem of validate(lines, markers)) errors.push(problem);

if (!errors.length) {
  const { warnings } = compileExample();
  for (const warning of warnings) {
    errors.push(
      `the example compiles with a warning — ${warning.file ?? "home-example.mx"}:${warning.line}:${warning.column}: ${warning.message}`,
    );
  }
}

if (!errors.length) {
  try {
    const render = await loadMx(examplePath);
    const html = render(SAMPLE);
    for (const expected of [
      'id="store-title"',
      'id="product-kettle"',
      "<dt>Cheapest</dt>",
      "<dt>Currency</dt>",
    ]) {
      if (!html.includes(expected)) {
        errors.push(`the example rendered without \`${expected}\``);
      }
    }
    if (html.includes("undefined") || html.includes("NaN")) {
      errors.push(
        `the example rendered an undefined value: ${html.slice(0, 400)}`,
      );
    }
  } catch (error) {
    errors.push(`the example did not render: ${String(error)}`);
  }
}

if (errors.length) {
  console.error("home page: the example and its markers do not hold up:");
  for (const problem of errors) console.error(`  - ${problem}`);
  process.exit(1);
}

const fragment = await exampleSection(source, markers);
const next = spliceIndex(readFileSync(indexPath, "utf8"), fragment);
writeFileSync(indexPath, next);

console.log(
  `home page: ${markers.length} markers, ${lines.length - 1} lines of example, docs/index.md updated`,
);
