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
 * `package.json`). A `.preact.mx` region is not covered here: its projection
 * maps neither the define's `Row` nor the call's (the region compile forwards
 * no recorded mappings to the bridge), which is a host-side change.
 */

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "preact-policy",
);
const PAGE = join(dir, "rows.mx");
const CONSUMER = join(dir, "consumer.ts");
// `Row` at 8 (the define), 47 (the direct call) and 59 (the `${Row}` read).
const SOURCE =
  "<define/Row|a: number|><li>${a}</li></define>\n<Row(1)/>\n<${Row}/>\n";
const ALL_SITES = [
  [PAGE, 8, 3],
  [PAGE, 47, 3],
  [PAGE, 59, 3],
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
    { [CONSUMER]: 'import "./rows.mx";\n', [PAGE]: SOURCE },
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
});
