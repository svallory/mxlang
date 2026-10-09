// Reads the tree-sitter corpus files in this directory. The format is
// tree-sitter's own (`tree-sitter test` runs the same files): a header, the
// source, a divider, the expected tree. Headers are fifteen `=` and dividers
// fifteen `-` (what `tree-sitter test --update` writes), so a source may hold
// a shorter `---` line. The source is the text between header and divider
// with the single newline before the divider removed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CorpusCase {
  file: string;
  name: string;
  source: string;
  /** The header carries tree-sitter's `:error`: the source must not parse clean. */
  error: boolean;
}

export const CORPUS_DIR = path.dirname(fileURLToPath(import.meta.url));

const HEADER = /^={15}\n(.+)\n((?::[a-z]+\n)*)={15}\n/;
const DIVIDER = /\n-{15}\n/;

export function parseCorpus(file: string, text: string): CorpusCase[] {
  const cases: CorpusCase[] = [];
  let rest = text;
  while (rest.length > 0) {
    const header = HEADER.exec(rest);
    if (!header)
      throw new Error(
        `${file}: no case header at ${JSON.stringify(rest.slice(0, 60))}`,
      );
    rest = rest.slice(header[0].length);
    const divider = DIVIDER.exec(rest);
    if (!divider) throw new Error(`${file}: case ${header[1]} has no divider`);
    const source = rest.slice(0, divider.index);
    rest = rest.slice(divider.index + divider[0].length);
    const next = /\n={15}\n.+\n(?::[a-z]+\n)*={15}\n/.exec(rest);
    rest = next ? rest.slice(next.index + 1) : "";
    cases.push({
      file,
      name: header[1],
      source,
      error: header[2].includes(":error\n"),
    });
  }
  return cases;
}

export function readCorpus(dir: string = CORPUS_DIR): CorpusCase[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .flatMap((f) =>
      parseCorpus(f, fs.readFileSync(path.join(dir, f), "utf-8")),
    );
}
