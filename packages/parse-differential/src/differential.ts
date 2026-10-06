/**
 * One input through both paths, projected into the neutral form, compared.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MxStatementKeyword } from "@mxlang/babel/mx-ast";
import { parse } from "../../parser/src/frontend/parse.ts";
import { markoTagShape, projectMarko } from "./marko.ts";
import { projectMx } from "./mx.ts";
import { type NDocument, type NNode, print } from "./neutral.ts";
import { compareTextRuns } from "./rules.ts";

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

function textRuns(
  nodes: readonly NNode[],
  out: (readonly [number, number])[] = [],
) {
  for (const node of nodes) {
    if (node.kind === "text") out.push(node.span);
    else if (node.kind === "tag") textRuns(node.children, out);
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
      note: `today's path threw: ${marko.crash}`,
    };
  }
  if (marko.document.error !== null || mx.error !== null) {
    // No tree on today's side: compare the error's message and range only.
    const strip = (error: string | null) =>
      error?.replace(/^[A-Z_]+ /, "") ?? "(none)";
    const a = strip(mx.error);
    const b = strip(marko.document.error);
    return {
      equal: a === b,
      mx: [`error ${a}`],
      marko: [`error ${b}`],
      text: [],
    };
  }
  const text = compareTextRuns(source, marko.texts, textRuns(mx.body));
  const strip = (d: NDocument): NDocument => ({
    ...d,
    body: dropTexts(d.body),
  });
  const a = print(strip(mx));
  const b = print(strip(marko.document));
  return {
    equal: text.length === 0 && JSON.stringify(a) === JSON.stringify(b),
    mx: a,
    marko: b,
    text,
  };
}
