import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { $ } from "bun";
import { collectMxRegions } from "../../../tsx-bridge/src/index.ts";

// Emulate the find command used in parse-all.sh
const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, "../../../..");
const LOCAL_FIXTURES = join(HERE, "../fixtures");

function findFiles(): string[] {
  const dirs = [
    join(REPO_ROOT, "fixtures"),
    join(REPO_ROOT, "examples"),
    LOCAL_FIXTURES,
  ];

  const files: string[] = [];
  const visit = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(path);
        } else if (entry.isFile() && entry.name.endsWith(".solid.mx")) {
          files.push(path);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  // Like `find -type f` in parse-all.sh, do not follow dependency symlinks.
  for (const dir of dirs) {
    visit(dir);
  }
  return files.sort();
}

/** Convert tree-sitter's zero-based UTF-8 byte point to a JS UTF-16 offset. */
function offsetAt(source: string, line: number, byteColumn: number): number {
  let currentLine = 0;
  let offset = 0;
  while (currentLine < line && offset < source.length) {
    if (source.charCodeAt(offset++) === 10) currentLine++;
  }

  let bytes = 0;
  while (offset < source.length && source.charCodeAt(offset) !== 10) {
    const codePoint = source.codePointAt(offset);
    if (codePoint === undefined || bytes >= byteColumn) break;
    const character = String.fromCodePoint(codePoint);
    const width = Buffer.byteLength(character);
    if (bytes + width > byteColumn) {
      throw new Error(
        `tree-sitter column ${byteColumn} splits a UTF-8 code point on line ${line}`,
      );
    }
    bytes += width;
    offset += character.length;
  }
  return offset;
}

async function run() {
  const files = findFiles();
  let totalFiles = 0;
  let totalRegions = 0;
  let mismatches = 0;

  console.log(`differential: checking ${files.length} source files`);

  for (const file of files) {
    totalFiles++;
    const source = readFileSync(file, "utf8");

    // 1. Get Tree-sitter regions
    const parsed = await $`bunx tree-sitter parse -x ${file}`.quiet().nothrow();
    if (parsed.exitCode !== 0) {
      const output = [
        parsed.stdout.toString().trim(),
        parsed.stderr.toString().trim(),
      ]
        .filter(Boolean)
        .join("\n");
      throw new Error(
        `tree-sitter parse failed for ${relative(REPO_ROOT, file)} (exit ${parsed.exitCode})${output ? `\n${output}` : "\n(no output)"}`,
      );
    }
    const xml = parsed.stdout.toString();
    const tsRegions: { start: number; end: number }[] = [];
    const regex =
      /<mx_element[^>]*srow="(\d+)" scol="(\d+)" erow="(\d+)" ecol="(\d+)"/g;
    let match = regex.exec(xml);
    while (match !== null) {
      const srow = Number.parseInt(match[1], 10);
      const scol = Number.parseInt(match[2], 10);
      const erow = Number.parseInt(match[3], 10);
      const ecol = Number.parseInt(match[4], 10);
      tsRegions.push({
        start: offsetAt(source, srow, scol),
        end: offsetAt(source, erow, ecol),
      });
      match = regex.exec(xml);
    }

    // 2. Get Walker regions
    const walkerRegions = collectMxRegions(source, file);

    // 3. Compare
    let mismatch = false;
    if (tsRegions.length !== walkerRegions.length) {
      mismatch = true;
    } else {
      for (let i = 0; i < tsRegions.length; i++) {
        if (
          tsRegions[i].start !== walkerRegions[i].start ||
          tsRegions[i].end !== walkerRegions[i].end
        ) {
          mismatch = true;
          break;
        }
      }
    }

    totalRegions += tsRegions.length;

    if (mismatch) {
      mismatches++;
      console.error(`\nMismatch in ${file}`);
      console.error("  Tree-sitter found:");
      for (const r of tsRegions) console.error(`    [${r.start}, ${r.end})`);
      console.error("  Walker found:");
      for (const r of walkerRegions)
        console.error(`    [${r.start}, ${r.end})`);

      // Find first differing region
      const maxLen = Math.max(tsRegions.length, walkerRegions.length);
      for (let i = 0; i < maxLen; i++) {
        const tr = tsRegions[i];
        const wr = walkerRegions[i];
        if (!tr || !wr || tr.start !== wr.start || tr.end !== wr.end) {
          console.error(`\n  First differing region (index ${i}):`);
          if (tr) {
            console.error(
              `  Tree-sitter range [${tr.start}, ${tr.end}):\n    ${JSON.stringify(
                source.slice(Math.max(0, tr.start - 20), tr.start) +
                  "|" +
                  source.slice(tr.start, tr.end) +
                  "|" +
                  source.slice(tr.end, Math.min(source.length, tr.end + 20)),
              )}`,
            );
          }
          if (wr) {
            console.error(
              `  Walker range      [${wr.start}, ${wr.end}):\n    ${JSON.stringify(
                source.slice(Math.max(0, wr.start - 20), wr.start) +
                  "|" +
                  source.slice(wr.start, wr.end) +
                  "|" +
                  source.slice(wr.end, Math.min(source.length, wr.end + 20)),
              )}`,
            );
          }
          break;
        }
      }
    }
  }

  console.log(
    `differential: ${totalFiles} files, ${totalRegions} regions, ${mismatches} mismatches`,
  );
  if (mismatches > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("differential: FAILED");
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exitCode = 1;
});
