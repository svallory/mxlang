// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `.hono.mx` region goldens: every fixture under `fixtures/region/<name>/` is
 * printed through the parser with this host's region entry, the printed module
 * is checked against its golden (`__golden__/output.txt`), and the module is
 * rendered for real with Hono's own JSX renderer (`JSXNode.toString()`) and
 * checked against `expected.html`.
 *
 * A fixture may carry `props.json` (the default export's props) and sibling
 * whole-file `.mx` tags (`counter.mx`, `tags/badge.mx`), which are compiled
 * with `compileHonoMx` beside it so the region's imports resolve to real
 * Hono components.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileHonoMx, compileHonoRegion } from "./index.ts";
import {
  FIXTURES,
  printHonoMx,
  renderPrinted,
  targets,
} from "./region-test-helpers.ts";

const fixtures = readdirSync(FIXTURES).filter((name) =>
  readdirSync(join(FIXTURES, name)).includes("input.hono.mx"),
);

describe(".hono.mx region goldens", () => {
  it("finds the fixture set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixtures)("%s: printed module matches its golden", async (name) => {
    const dir = join(FIXTURES, name);
    const file = join(dir, "input.hono.mx");
    const printed = printHonoMx(readFileSync(file, "utf8"), file);
    await expect(printed).toMatchFileSnapshot(
      join(dir, "__golden__", "output.txt"),
    );
  });

  it.each(fixtures)("%s: renders the expected HTML", async (name) => {
    const dir = join(FIXTURES, name);
    const file = join(dir, "input.hono.mx");
    const printed = printHonoMx(readFileSync(file, "utf8"), file);
    const propsFile = readdirSync(dir).includes("props.json")
      ? JSON.parse(readFileSync(join(dir, "props.json"), "utf8"))
      : {};
    const html = await renderPrinted(printed, dir, propsFile);
    expect(html).toBe(readFileSync(join(dir, "expected.html"), "utf8").trim());
  });
});

/**
 * The same markup as a whole-file `.mx` and inside a `.hono.mx` region
 * renders the same HTML: the region path changes only the module assembly.
 */
describe(".hono.mx region renders what the whole-file .mx renders", () => {
  const markups = [
    '<p class={ a: true, b: false } style={ color: "red" }>x</p>',
    '<label for="f" class=["x", false && "y"]>l</label>',
    "<ul><for|n| of=[3, 1, 2] by=(n) => n><li data-n=n>${n}</li></for></ul>",
    "<if=1 === 2><b>no</b></if><else-if=true><i>yes</i></else-if><else><s>never</s></else>",
    '<input type="checkbox" checked=true disabled=false/>',
    '<textarea value="ab"/>',
    '<${"em"} title="t">dyn</>',
    '<define/Item|label: string|><li>${label}</li></define><ol><Item("one")/><Item("two")/></ol>',
    '<div>$!{"<b>raw</b>"}</div>',
  ];

  it.each(markups)("%s", async (markup) => {
    // Bare at the whole file's top level (where a `<define>` must sit), and
    // under one root element in the region (a region is one element).
    const whole = compileHonoMx(markup, join(FIXTURES, "whole.mx"), {
      targets,
    }).code;
    const regionFile = join(FIXTURES, "parity.hono.mx");
    const region = printHonoMx(
      `export default function Page() {\n  return (\n    <div>${markup}</div>\n  );\n}\n`,
      regionFile,
    );
    const [fromWhole, fromRegion] = [
      await renderPrinted(
        whole.replace("/** @jsxImportSource hono/jsx */", ""),
        FIXTURES,
      ),
      await renderPrinted(region, FIXTURES),
    ];
    expect(fromRegion).toBe(`<div>${fromWhole}</div>`);
    expect(fromRegion).not.toBe("");
  });
});

/**
 * The region result carries the emitter's recorded mappings (generated
 * offsets into `code`, source offsets file-absolute), so the parser bridge
 * maps a define, its direct call and a later read of the same name without
 * searching the emitted text. The private `__mxDef_Row` maps to the authored
 * name it was minted from.
 */
describe("compileHonoRegion: recorded mappings", () => {
  // The region starts at file offset 27 (line 2, column 2).
  const prefix = "export const V = () => (\n  ";
  const region =
    "<ul><define/Row|a: number|><li>${a}</li></define><Row(1)/><${Row}/>${Row.name}</ul>";
  const file = `${prefix}${region});\n`;

  it("maps every recorded name file-absolute into unchanged code", () => {
    const { code, mappings } = compileHonoRegion(region, {
      filename: join(FIXTURES, "rows.hono.mx"),
      baseOffset: 27,
      baseLine: 1,
      baseColumn: 2,
      targets,
    });
    expect(code).toBe(
      '<>{(() => { const __mxDef_Row = (a: number) => (<><li>{__mxTextValue(a)}</li></>); const Row = __mxDefine(__mxDef_Row, "Row"); return (<><ul>{__mxDef_Row(1)}{__mxDynamic(Row, {  })}{__mxTextValue(Row.name)}</ul></>); })()}</>',
    );
    expect(
      mappings.map((m) => [
        m.generatedStart,
        code.slice(m.generatedStart, m.generatedEnd),
        m.sourceStart,
        file.slice(m.sourceStart, m.sourceEnd),
      ]),
    ).toEqual([
      [18, "__mxDef_Row", 39, "Row"],
      [69, "a", 60, "a"],
      [89, "Row", 39, "Row"],
      [142, "__mxDef_Row", 77, "Row"],
      [196, "Row.name", 96, "Row.name"],
    ]);
  });
});
