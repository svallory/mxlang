/**
 * The parser grammar's probe corpus (decision 165) against this source copy,
 * and the link between the corpus and the document: every row of a normative
 * table in `parser-grammar.md` cites a probe, every cited probe exists, and
 * every probe is cited. See `grammar-spec.cases.ts` for the corpus format and
 * the regeneration command.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CORPUS_PATH,
  PROBES,
  type ProbeParserModule,
  renderProbe,
} from "./grammar-spec.cases.ts";
import * as template from "./index.ts";

const mod = template as unknown as ProbeParserModule;

const DOCUMENT = join(
  fileURLToPath(import.meta.url),
  "../../../../../apps/docs/docs/architecture/parser-grammar.md",
);
const PROBE_ID = /\bg\d{4}\b/g;

interface Row {
  line: number;
  normative: boolean;
  ids: string[];
}

/**
 * The data rows of every Markdown table in the document. A table is
 * normative when its last header cell is `Probes`; a row's citations are the
 * probe ids in its last cell.
 */
function tableRows(markdown: string): Row[] {
  const rows: Row[] = [];
  const lines = markdown.split("\n");
  let normative = false;
  let rowInTable = 0;
  for (const [index, text] of lines.entries()) {
    const line = text.trim();
    if (!line.startsWith("|")) {
      rowInTable = 0;
      continue;
    }
    const cells = line.replace(/\|$/, "").split(/(?<!\\)\|/);
    const last = cells[cells.length - 1]?.trim() ?? "";
    rowInTable++;
    if (rowInTable === 1) normative = last === "Probes";
    if (rowInTable <= 2) continue; // the header and the `---` row
    rows.push({
      line: index + 1,
      normative,
      ids: (normative ? last : line).match(PROBE_ID) ?? [],
    });
  }
  return rows;
}

if (process.env.GRAMMAR_SPEC_UPDATE) {
  const updated = PROBES.map((probe) => ({
    ...probe,
    expected: renderProbe(mod, probe),
  }));
  // Non-ASCII characters stay written as escapes, as the corpus has them.
  const json = JSON.stringify(updated, null, 2).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  writeFileSync(CORPUS_PATH, `${json}\n`);
}

describe("parser grammar probes (src/template)", () => {
  it("probe ids are unique", () => {
    expect(new Set(PROBES.map((p) => p.id)).size).toBe(PROBES.length);
  });

  it
    .skipIf(!!process.env.GRAMMAR_SPEC_UPDATE)
    .each(PROBES.map((probe) => [probe.id, probe] as const))(
    "%s",
    (_id, probe) => {
      expect(renderProbe(mod, probe)).toEqual(probe.expected);
    },
  );
});

describe("parser-grammar.md cites the probe corpus", () => {
  const markdown = readFileSync(DOCUMENT, "utf8");
  const rows = tableRows(markdown);
  const known = new Set(PROBES.map((p) => p.id));
  const cited = new Set(rows.flatMap((row) => row.ids));

  it("has normative tables", () => {
    expect(rows.some((row) => row.normative)).toBe(true);
  });

  it("every row of a normative table cites a probe", () => {
    const bare = rows.filter((row) => row.normative && !row.ids.length);
    expect(bare.map((row) => `line ${row.line}`)).toEqual([]);
  });

  it("every probe id written in the document exists", () => {
    const written = new Set(markdown.match(PROBE_ID) ?? []);
    expect([...written].filter((id) => !known.has(id))).toEqual([]);
  });

  it("every probe is cited by a table row", () => {
    expect([...known].filter((id) => !cited.has(id))).toEqual([]);
  });
});
