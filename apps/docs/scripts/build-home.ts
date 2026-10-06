/**
 * `bun run build:home` — the gate the docs build runs first.
 * `bun run build:home --check` — the gate that runs last, after `docmd build`.
 *
 * Order matters: the example is compiled and rendered before anything is
 * written, so a language change or a stale marker fails the build with the
 * file and line that moved rather than shipping a landing page that lies.
 *
 * The two modes exist because they can see different things. The build mode
 * owns `docs/index.md` and regenerates it. The check mode never writes: it
 * fails when the committed block is not what the generator produces, and it
 * resolves each marker's `#fragment` against the **built** site, because
 * docmd's heading slugs are prefixed with the page title and cannot be
 * predicted from the markdown. It runs after `docmd build` so the site it
 * reads is the one this commit produced.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadMx } from "@mxlang/html";
import {
  anchorExists,
  compileExample,
  examplePath,
  exampleSection,
  indexPath,
  readCards,
  readExample,
  readMarkers,
  siteRoot,
  spliceIndex,
  validate,
  validateCards,
  validateNodes,
} from "./home-example.ts";

const check = process.argv.includes("--check");

/**
 * Inputs the example is rendered with. Rendering is part of the gate: an
 * example that compiles but throws on a missing prop is still not real, and
 * each case below is a branch the example actually has.
 */
const SAMPLES = [
  {
    name: "two products",
    input: {
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
    },
    expects: [
      'id="store-title"',
      'id="product-kettle"',
      // The structured values, exactly as the browser will read them: an
      // object key is emitted verbatim, so a camelCase CSS property would
      // ship as invalid CSS and nothing else here would notice.
      'style="padding-left:0rem"',
      'style="padding-left:1rem"',
      // The name sugar and the atom, as the attributes they stand for.
      '<input name="q" type="search" placeholder="Filter" required class="search">',
      "<li data-first style",
      '<span class="badge">New</span>',
      '<b class="sale">$39.90</b>',
      "<dt>Cheapest</dt><dd>$9.50</dd>",
      "<dt>Selected</dt><dd>kettle</dd>",
      '<footer class="printed"><p>Concise mode',
    ],
  },
  {
    name: "empty list",
    input: {
      products: [],
      currency: "USD",
      emptyHtml: "<em>Nothing in stock</em>",
    },
    expects: ['<p class="empty"><em>Nothing in stock</em></p>', "<dd>—</dd>"],
  },
  {
    name: "filtered",
    input: {
      products: [
        {
          id: "mug",
          name: "Mug",
          blurb: "Plain ceramic",
          price: 9.5,
          tags: [],
        },
      ],
      currency: "USD",
      filter: "mug",
    },
    expects: ['<p class="hint">Filtered by mug.</p>'],
  },
  {
    name: "unfiltered",
    input: {
      products: [
        {
          id: "mug",
          name: "Mug",
          blurb: "Plain ceramic",
          price: 9.5,
          tags: [],
        },
      ],
      currency: "USD",
    },
    expects: ['<p class="hint">Showing all 1 products.</p>'],
  },
];

const errors: string[] = [];
const { source, lines } = readExample();
const markers = readMarkers();
const cards = readCards();

for (const problem of [
  ...validate(lines, markers),
  ...validateNodes(source, markers),
  ...validateCards(markers, cards),
]) {
  errors.push(problem);
}

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
    for (const sample of SAMPLES) {
      const html = render(sample.input);
      for (const expected of sample.expects) {
        if (!html.includes(expected)) {
          errors.push(
            `the example rendered without \`${expected}\` (${sample.name})`,
          );
        }
      }
      if (html.includes("undefined") || html.includes("NaN")) {
        errors.push(
          `the example rendered an undefined value (${sample.name}): ${html.slice(0, 400)}`,
        );
      }
    }
  } catch (error) {
    errors.push(`the example did not render: ${String(error)}`);
  }
}

const fragment = exampleSection(source, markers, cards);
const onDisk = readFileSync(indexPath, "utf8");
const next = spliceIndex(onDisk, fragment);

if (check) {
  if (!existsSync(siteRoot)) {
    errors.push(
      "no built site to resolve marker anchors against — run `docmd build` first, or drop `--check`",
    );
  } else {
    for (const marker of markers) {
      if (!anchorExists(marker.href)) {
        errors.push(
          `marker \`${marker.id}\` links an anchor that is not in the built page: ${marker.href}`,
        );
      }
    }
  }
  if (onDisk !== next) {
    errors.push(
      "docs/index.md is not what the generator produces — run `bun run build:home` and commit the result",
    );
  }
}

if (errors.length) {
  console.error("home page: the example and its markers do not hold up:");
  for (const problem of errors) console.error(`  - ${problem}`);
  process.exit(1);
}

if (check) {
  console.log(
    `home page: ${cards.length} cards, ${markers.length} markers, ${lines.length - 1} lines of example, anchors resolve, docs/index.md is current`,
  );
} else {
  writeFileSync(indexPath, next);
  console.log(
    `home page: ${cards.length} cards, ${markers.length} markers, ${lines.length - 1} lines of example, docs/index.md updated`,
  );
}
