// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `.preact.mx` region goldens (decision 154): every fixture under
 * `fixtures/region/<name>/` is printed through the parser with this host's
 * region entry, the printed module is checked against its golden
 * (`__golden__/output.txt`), and the module is rendered for real with
 * `preact-render-to-string` and checked against `expected.html`.
 *
 * A fixture may carry `props.json` (the default export's props) and sibling
 * whole-file `.mx` tags (`counter.mx`, `tags/badge.mx`), which are compiled
 * with `compilePreactMx` beside it so the region's imports resolve to real
 * Preact components.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";
import {
  FIXTURES,
  printPreactMx,
  renderPrinted,
  targets,
} from "./region-test-helpers.ts";

const fixtures = readdirSync(FIXTURES).filter((name) =>
  readdirSync(join(FIXTURES, name)).includes("input.preact.mx"),
);

describe(".preact.mx region goldens", () => {
  it("finds the fixture set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixtures)("%s: printed module matches its golden", async (name) => {
    const dir = join(FIXTURES, name);
    const file = join(dir, "input.preact.mx");
    const printed = printPreactMx(readFileSync(file, "utf8"), file);
    await expect(printed).toMatchFileSnapshot(
      join(dir, "__golden__", "output.txt"),
    );
  });

  it.each(fixtures)("%s: renders the expected HTML", async (name) => {
    const dir = join(FIXTURES, name);
    const file = join(dir, "input.preact.mx");
    const printed = printPreactMx(readFileSync(file, "utf8"), file);
    const propsFile = readdirSync(dir).includes("props.json")
      ? JSON.parse(readFileSync(join(dir, "props.json"), "utf8"))
      : {};
    const html = await renderPrinted(printed, dir, propsFile);
    expect(html).toBe(readFileSync(join(dir, "expected.html"), "utf8").trim());
  });
});

/**
 * The same markup as a whole-file `.mx` and inside a `.preact.mx` region
 * renders the same HTML: the region path changes only the module assembly.
 */
describe(".preact.mx region renders what the whole-file .mx renders", () => {
  const markups = [
    '<p class={ a: true, b: false } style={ color: "red" }>x</p>',
    '<label for="f" class=["x", false && "y"]>l</label>',
    "<ul><for|n| of=[3, 1, 2] by=(n) => n><li data-n=n>${n}</li></for></ul>",
    "<if=1 === 2><b>no</b></if><else-if=true><i>yes</i></else-if><else><s>never</s></else>",
    '<input type="checkbox" checked=true disabled=false/>',
    '<textarea value="ab"/>',
    '<${"em"} title="t">dyn</>',
    '<define/Item|label: string|><li>${label}</li></define><ol><Item("one")/><Item("two")/></ol>',
    '<div innerHTML="no">${"<b>escaped</b>"}</div>',
  ];

  it.each(markups)("%s", async (markup) => {
    // Bare at the whole file's top level (where a `<define>` must sit), and
    // under one root element in the region (a region is one element).
    const whole = compilePreactMx(markup, join(FIXTURES, "whole.mx"), {
      targets,
    }).code;
    const regionFile = join(FIXTURES, "parity.preact.mx");
    const region = printPreactMx(
      `export default function Page() {\n  return (\n    <div>${markup}</div>\n  );\n}\n`,
      regionFile,
    );
    const [fromWhole, fromRegion] = [
      await renderPrinted(
        whole.replace("/** @jsxImportSource preact */", ""),
        FIXTURES,
      ),
      await renderPrinted(region, FIXTURES),
    ];
    expect(fromRegion).toBe(`<div>${fromWhole}</div>`);
    expect(fromRegion).not.toBe("");
  });
});
