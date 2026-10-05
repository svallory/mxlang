/**
 * The worked example on the IR specification page
 * (`docs/architecture/ir-spec.md`).
 *
 * One small `.mx` file, the IR `@mxlang/core` lowers it to, and the module
 * `@mxlang/html` emits from that IR. All three live in `example/ir-spec/` as
 * real files and the page quotes each verbatim; `ir-example.test.ts` fails
 * when
 *
 *   - the IR the core produces today no longer matches the committed JSON,
 *   - the html target's output no longer matches the committed module, or
 *   - a fenced block on the page no longer matches the file it was copied
 *     from.
 *
 * Regenerate both outputs with `bun scripts/ir-example.ts --write` (needs
 * `bun run build` first: it imports the packages' `dist/`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_TAGLIB,
  compileSource,
  type Ir,
  type MxWarning,
} from "@mxlang/core";
import { compile, htmlTargets, policy } from "@mxlang/html";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
export const exampleDir = join(docsRoot, "example", "ir-spec");
export const specPage = join(docsRoot, "docs", "architecture", "ir-spec.md");

export const files = {
  mx: "greeting.mx",
  ir: "greeting.ir.json",
  html: "greeting.html.ts",
} as const;

/** The path the example compiles under, so every `file` in the output is stable. */
export const exampleFilename = "/example/ir-spec/greeting.mx";

export function readExample(file: string): string {
  return readFileSync(join(exampleDir, file), "utf8");
}

/**
 * Lowers `source` exactly as `@mxlang/html` does — same declarations, same
 * taglibs, same discovery dirs, same targets — but hands the IR back instead
 * of emitting it.
 */
export function lowerForHtml(source: string, warnings: MxWarning[]): Ir {
  let captured: Ir | null = null;
  compileSource(source, exampleFilename, policy, {
    taglibs: [["mx-translator-core", CORE_TAGLIB]],
    tagDiscoveryDirs: ["tags"],
    targets: htmlTargets,
    warnings,
    emitIr: (ir) => {
      captured = ir;
      return "";
    },
  });
  if (!captured) throw new Error("compileSource never called emitIr");
  return captured;
}

/**
 * The IR as JSON. `Expr.node` and `For.paramNodes` are the parser's Babel
 * nodes — an implementation detail of today's lowering, not part of the
 * interface a host reads them through — so they are elided, as is every
 * `undefined` field (JSON has none).
 */
export function irToJson(ir: Ir): string {
  return `${JSON.stringify(
    ir,
    (key, value) =>
      key === "node" || key === "paramNodes" ? undefined : value,
    2,
  )}\n`;
}

export function compileForHtml(source: string, warnings: MxWarning[]): string {
  return compile(source, exampleFilename, { warnings }).code;
}

if (import.meta.main && process.argv.includes("--write")) {
  const source = readExample(files.mx);
  const warnings: MxWarning[] = [];
  writeFileSync(
    join(exampleDir, files.ir),
    irToJson(lowerForHtml(source, warnings)),
  );
  writeFileSync(join(exampleDir, files.html), compileForHtml(source, warnings));
  if (warnings.length > 0) {
    throw new Error(`the example warns: ${JSON.stringify(warnings)}`);
  }
}
