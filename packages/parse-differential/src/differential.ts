/**
 * One input through both paths, projected into the neutral form, compared.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MxStatementKeyword } from "@mxlang/babel/mx-ast";
import { parse } from "../../parser/src/frontend/parse.ts";
import {
  compareExpressions,
  mxExpressions,
  todayExpressions,
} from "./expressions.ts";
import { markoTagShape, projectMarko } from "./marko.ts";
import { projectMx } from "./mx.ts";
import { type NDocument, type NNode, print } from "./neutral.ts";
import { compareTextRuns, lineStartsOf } from "./rules.ts";

export const REPO = join(import.meta.dirname, "../../..");

const SIX: ReadonlySet<MxStatementKeyword> = new Set([
  "import",
  "export",
  "static",
  "server",
  "client",
  "class",
]);

/** The input glob: whole-file `.mx` sources tracked in the repo (region and `.astro.mx` files hold no whole template). */
export const INPUT_GLOB =
  "git ls-files '*.mx' minus *.{solid,ng,astro,preact,react}.mx";

export function fixtureInputs(): { path: string; source: string }[] {
  const listed = execFileSync("git", ["ls-files", "*.mx"], {
    cwd: REPO,
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      (path) => path && !/\.(solid|ng|astro|preact|react)\.mx$/.test(path),
    );
  return listed.map((path) => ({
    path,
    source: readFileSync(join(REPO, path), "utf8"),
  }));
}

export interface Outcome {
  readonly equal: boolean;
  readonly mx: string[];
  readonly marko: string[];
  /** Rule `text-runs` (A13) violations. */
  readonly text: string[];
  /** The whitespace differential (PR 3): text nodes compared, differences. */
  readonly whitespace: { compared: number; differences: string[] };
  /** The expression differential (PR 3): containers compared, differences. */
  readonly expressions: { compared: number; differences: string[] };
  /** Why the input is not compared tree to tree (today's path crashed, or an error PR 2b owns). */
  readonly note?: string;
}

function dropTexts(nodes: readonly NNode[]): NNode[] {
  return nodes
    .filter((node) => node.kind !== "text")
    .map((node) =>
      node.kind === "tag"
        ? { ...node, children: dropTexts(node.children) }
        : node,
    );
}

/**
 * Text runs grouped by their parent, the parent named by its path among
 * the non-text nodes (`0.2` is the third non-text child of the first
 * top-level non-text node), so a run under the wrong parent is a difference.
 */
function textsByParent(
  nodes: readonly NNode[],
  path = "",
  out = new Map<string, (readonly [number, number])[]>(),
) {
  let index = 0;
  for (const node of nodes) {
    if (node.kind === "text") {
      const runs = out.get(path) ?? [];
      runs.push(node.span);
      out.set(path, runs);
      continue;
    }
    if (node.kind === "tag")
      textsByParent(node.children, `${path}.${index}`, out);
    index++;
  }
  return out;
}

export function compare(source: string): Outcome {
  const marko = projectMarko(source);
  const document = parse(source, {
    statementKeywords: SIX,
    tagShape: markoTagShape,
  });
  const mx = projectMx(document);
  if (marko.crash !== undefined) {
    return {
      equal: false,
      mx: print(mx),
      marko: [],
      text: [],
      whitespace: { compared: 0, differences: [] },
      expressions: { compared: 0, differences: [] },
      note: `today's path threw: ${marko.crash}`,
    };
  }
  if (marko.document.error !== null || mx.error !== null) {
    // No tree on today's side: compare the error's message and range only.
    // MX's own template error, or its first front-end error (ast §3.13):
    // today's path throws those the same way at the same offset.
    const strip = (error: string | null) =>
      error?.replace(/^[A-Z_]+ /, "") ?? "(none)";
    const a = strip(mx.error ?? mx.frontEndError ?? null);
    const b = strip(marko.document.error);
    return {
      equal: a === b,
      mx: [`error ${a}`],
      marko: [`error ${b}`],
      text: [],
      whitespace: { compared: 0, differences: [] },
      expressions: { compared: 0, differences: [] },
    };
  }
  // Rule `text-runs` (A13), per parent: today's (trimmed) runs under a tag
  // must sit in that same tag's MX runs.
  const mxRunsByParent = textsByParent(mx.body);
  const markoRunsByParent = textsByParent(marko.document.body);
  const text: string[] = [];
  for (const parent of new Set([
    ...mxRunsByParent.keys(),
    ...markoRunsByParent.keys(),
  ])) {
    for (const problem of compareTextRuns(
      source,
      markoRunsByParent.get(parent) ?? [],
      mxRunsByParent.get(parent) ?? [],
    )) {
      text.push(`under ${parent || "the document"}: ${problem}`);
    }
  }
  // Atoms inside an expression today's Babel could not parse are not in
  // today's tree (it holds the raw text): not compared (rules.ts).
  const failed = marko.failed ?? [];
  const inFailed = (line: string) => {
    const [, s, e] = /@\[(\d+),(\d+)\)$/.exec(line) ?? [];
    return failed.some(([fs, fe]) => Number(s) >= fs && Number(e) <= fe);
  };
  const comparable = { ...mx, atoms: mx.atoms.filter((a) => !inFailed(a)) };
  const strip = (d: NDocument): NDocument => ({
    ...d,
    body: dropTexts(d.body),
  });
  const a = print(strip(comparable));
  const b = print(strip(marko.document));
  // The whitespace differential (PR 3): value and valueSpan of every text
  // node, against Marko's final `value` and its (trimmed) `withLoc` range.
  const mxTexts = mxTextNodes(document.body);
  const whitespace: string[] = [];
  const markoTexts = marko.textNodes;
  if (mxTexts.length !== markoTexts.length) {
    whitespace.push(
      `${mxTexts.length} MX text nodes != ${markoTexts.length} Marko text nodes`,
    );
  }
  for (let i = 0; i < Math.min(mxTexts.length, markoTexts.length); i++) {
    const mxText = mxTexts[i] as { value: string; start: number; end: number };
    const markoText = markoTexts[i] as {
      value: string;
      start: number;
      end: number;
    };
    if (mxText.value !== markoText.value)
      whitespace.push(
        `text #${i} [${mxText.start},${mxText.end}): ${JSON.stringify(mxText.value)} != ${JSON.stringify(markoText.value)}`,
      );
    if (mxText.start !== markoText.start || mxText.end !== markoText.end)
      whitespace.push(
        `text #${i} valueSpan [${mxText.start},${mxText.end}) != [${markoText.start},${markoText.end}) (${JSON.stringify(mxText.value)})`,
      );
  }
  // The expression differential (PR 3).
  const expressions = compareExpressions(
    mxExpressions(document),
    todayExpressions(marko.ast, source, lineStartsOf(source)),
    source,
  );
  return {
    equal:
      text.length === 0 &&
      whitespace.length === 0 &&
      expressions.differences.length === 0 &&
      JSON.stringify(a) === JSON.stringify(b),
    mx: a,
    marko: b,
    text,
    whitespace: { compared: mxTexts.length, differences: whitespace },
    expressions,
  };
}

/** The MX text nodes' final `value` and `valueSpan`, in document order. */
// biome-ignore lint/suspicious/noExplicitAny: walks the MX tree generically
function mxTextNodes(
  body: any,
): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = [];
  const walk = (nodes: any): void => {
    for (const node of nodes ?? []) {
      if (node.type === "MxText") {
        out.push({
          value: node.value,
          start: node.valueSpan.start,
          end: node.valueSpan.end,
        });
        continue;
      }
      if (node.body) walk(node.body);
    }
  };
  walk(body);
  return out;
}
