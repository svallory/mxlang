/**
 * The copy in `src/template/` must tokenize exactly like the patched npm
 * `htmljs-parser` that core still parses through (`patches/htmljs-parser@5.18.0.patch`).
 *
 * Corpus: every tracked `.mx`, `.marko` and `.amx` file, plus the `mx` and
 * `marko` fenced blocks of every tracked Markdown file. Each input is parsed by
 * both builds with a handler for every event; the full event streams (name and
 * range) must be equal, in two modes: plain, and with `import`/`export`/
 * `static`/`server`/`client` tags treated as statements, as core does.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as installed from "htmljs-parser";
import { describe, expect, it } from "vitest";
import * as source from "./index.ts";

type Parser = typeof source;

const root = join(fileURLToPath(import.meta.url), "../../../../..");
const STATEMENT_TAGS = new Set([
  "static",
  "import",
  "export",
  "server",
  "client",
]);
const SKIP =
  /^(packages\/editors\/zed\/grammars|docs\/upstream|packages\/parser\/src\/template\/__tests__)\//;

// Documentation pages show atoms on purpose; see the atoms test below.
const DOCS_PAGES = "apps/docs/docs/";

const tracked = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f && !SKIP.test(f))
  .sort();

interface Input {
  name: string;
  text: string;
}

function corpus(): Input[] {
  const inputs: Input[] = [];
  for (const file of tracked) {
    if (/\.(mx|marko|amx)$/.test(file)) {
      inputs.push({ name: file, text: readFileSync(join(root, file), "utf8") });
    } else if (/\.mdx?$/.test(file)) {
      const text = readFileSync(join(root, file), "utf8");
      const fence = /^(`{3,})(?:mx|marko)\b[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
      let n = 0;
      for (let m = fence.exec(text); m; m = fence.exec(text)) {
        inputs.push({ name: `${file}#fence${++n}`, text: m[2] ?? "" });
      }
    }
  }
  return inputs;
}

function events(
  mod: Parser | typeof installed,
  text: string,
  statements: boolean,
) {
  const log: unknown[] = [];
  const handlers = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string" || !name.startsWith("on"))
          return undefined;
        return (range: { start?: number; end?: number }) => {
          log.push([name, range]);
          if (statements && name === "onOpenTagName") {
            const tag = text.slice(range.start, range.end);
            return STATEMENT_TAGS.has(tag) ? { type: 1 } : undefined;
          }
          return undefined;
        };
      },
    },
  );
  const parser = (
    mod.createParser as (h: unknown) => { parse(code: string): void }
  )(handlers);
  try {
    parser.parse(text);
  } catch (err) {
    log.push(["throw", String((err as Error).message)]);
  }
  return log;
}

const inputs = corpus();

describe("source copy vs patched npm htmljs-parser", () => {
  it("covers the repo corpus", () => {
    expect(inputs.length).toBeGreaterThanOrEqual(523);
    expect(inputs.some((i) => i.name.includes("#fence"))).toBe(true);
  });

  for (const statements of [false, true]) {
    it(`event streams are identical (statement tags: ${statements})`, () => {
      let total = 0;
      for (const { name, text } of inputs) {
        const mine = events(source, text, statements);
        const theirs = events(installed, text, statements);
        total += mine.length;
        expect(mine, name).toEqual(theirs);
      }
      expect(total).toBeGreaterThan(10_000);
    });
  }

  // Decision 156: outside the documentation pages, only the files listed
  // below hold an atom or a reserved `::`, so atom lexing changes no existing
  // parse (research §5 row 16). Pages under `apps/docs/docs/` are expected to
  // show atoms and are not listed: a new example there is not a finding.
  it("lexes atoms only in the docs pages and the listed files", () => {
    const hits: string[] = [];
    for (const { name, text } of inputs) {
      if (name.startsWith(DOCS_PAGES)) continue;
      for (const [event, range] of events(source, text, true) as [
        string,
        { message?: string },
      ][]) {
        if (
          event === "onAtom" ||
          (event === "onError" && range.message?.includes("is reserved"))
        ) {
          hits.push(name);
        }
      }
    }
    // Files outside the docs pages that use atoms on purpose: the atom
    // fixtures of PR 1's tests, the expression-value mapping fixtures,
    // tree-sitter-mx's Mesh fixture (#339) and the docs home example, which
    // shows one atom (`type=:search`).
    expect([...new Set(hits)]).toEqual([
      "apps/docs/example/home-example.mx",
      "packages/editors/tree-sitter-mx/test/fixtures/mesh-invoice.mx",
      "packages/tooling/tsc/src/fixtures/atoms/preact/page.mx",
      "packages/tooling/tsc/src/fixtures/expression-values/html/page.mx",
      "packages/tooling/tsc/src/fixtures/expression-values/preact/page.mx",
      "packages/tooling/tsc/src/fixtures/expression-values/react/page.mx",
      "packages/tooling/tsc/src/fixtures/expression-values/solid-clean/page.mx",
      "packages/tooling/tsc/src/fixtures/expression-values/solid/page.mx",
    ]);
  });
});
