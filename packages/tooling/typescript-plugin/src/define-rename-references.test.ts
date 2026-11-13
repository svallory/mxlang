// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type ts from "typescript";
import { describe, expect, it } from "vitest";
import { createPluginService } from "./fixtures/plugin-service.ts";

/**
 * Rename and find-references between a `<define>`'s name, a direct call
 * `<Row(1)/>` and a `<${Row}/>` read. The JSX hosts project a direct call as
 * `(__mxDef_Row as typeof Row)(1)`: the private `__mxDef_Row` maps to no
 * source, so every site must be reached through the public `Row`, and no
 * answer may land inside the private name.
 *
 * Whole-file `.mx` under `mx.host: "preact"` (the fixture directory's
 * `package.json`), and the same three sites inside a `.preact.mx` region,
 * whose host forwards the emitter's recorded mappings to the bridge.
 */

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "preact-policy",
);
const PAGE = join(dir, "rows.mx");
const REGION = join(dir, "rows.preact.mx");
const CONSUMER = join(dir, "consumer.ts");
// `Row` at 8 (the define), 47 (the direct call) and 59 (the `${Row}` read).
const SOURCE =
  "<define/Row|a: number|><li>${a}</li></define>\n<Row(1)/>\n<${Row}/>\n";
const ALL_SITES = [
  [PAGE, 8, 3],
  [PAGE, 47, 3],
  [PAGE, 59, 3],
];

// `Row` at 32 (the define), 70 (the direct call) and 81 (the `${Row}` read).
const REGION_SOURCE =
  "export const view = <ul><define/Row|a: number|><li>${a}</li></define><Row(1)/><${Row}/></ul>;\n";
const REGION_SITES = [
  [REGION, 32, 3],
  [REGION, 70, 3],
  [REGION, 81, 3],
];

const spans = (locations: readonly ts.DocumentSpan[] | undefined) =>
  (locations ?? [])
    .map((location) => [
      location.fileName,
      location.textSpan.start,
      location.textSpan.length,
    ])
    .sort((left, right) => Number(left[1]) - Number(right[1]));

describe("rename and references across a define, its call and a ${} read", {
  timeout: 60_000,
}, () => {
  const service = createPluginService(
    {
      [CONSUMER]: 'import "./rows.mx";\nimport "./rows.preact.mx";\n',
      [PAGE]: SOURCE,
      [REGION]: REGION_SOURCE,
    },
    [CONSUMER],
  );

  it.each([
    ["the define's name", 8],
    ["the direct call", 47],
    ["the ${Row} read", 59],
  ])("from %s, rename reaches all three sites", (_site, offset) => {
    expect(
      spans(service.findRenameLocations(PAGE, offset, false, false, {})),
    ).toEqual(ALL_SITES);
  });

  it.each([
    ["the define's name", 8],
    ["the direct call", 47],
    ["the ${Row} read", 59],
  ])("from %s, references reach all three sites", (_site, offset) => {
    expect(
      spans(
        service
          .findReferences(PAGE, offset)
          ?.flatMap((symbol) => symbol.references),
      ),
    ).toEqual(ALL_SITES);
  });

  it.each([
    ["the define's name", 32],
    ["the direct call", 70],
    ["the ${Row} read", 81],
  ])(
    "in a .preact.mx region, from %s, rename and references reach all three sites",
    (_site, offset) => {
      expect(
        spans(service.findRenameLocations(REGION, offset, false, false, {})),
      ).toEqual(REGION_SITES);
      expect(
        spans(
          service
            .findReferences(REGION, offset)
            ?.flatMap((symbol) => symbol.references),
        ),
      ).toEqual(REGION_SITES);
    },
  );
});
