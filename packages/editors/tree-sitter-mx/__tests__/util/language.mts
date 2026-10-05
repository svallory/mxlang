// MX: loads the grammar through web-tree-sitter from `tree-sitter-mx.wasm`
// (built by `bun run build:wasm`, which scripts/test.sh runs first) instead
// of upstream's native `tree-sitter` binding. The native route needs node-gyp
// and a prebuilt addon per platform; the wasm route needs only
// tree-sitter-cli, which this package already pins for `generate`. Both
// compile the same src/parser.c and src/scanner.c, so the trees are the same.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tree-sitter-mx.wasm",
);

if (!fs.existsSync(WASM)) {
  throw new Error(`${WASM} is missing; run \`bun run build:wasm\` first`);
}

await Parser.init();
export const MX = await Language.load(WASM);

// A scanner bug must fail the test, not hang the suite. web-tree-sitter has
// no setTimeoutMicros; a progress callback that returns true aborts the parse.
const TIMEOUT_MS = 5_000;

// A fresh parser per parse: a timed-out parse can poison subsequent parses
// on the same instance.
export function parseMx(src: string): Tree | null {
  const parser = new Parser();
  parser.setLanguage(MX);
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    return parser.parse(src, null, {
      progressCallback: () => Date.now() > deadline,
    });
  } finally {
    parser.delete();
  }
}
