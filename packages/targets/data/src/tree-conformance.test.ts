import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

/**
 * Every source the `@mxlang/tree-sitter-mx` grammar accepts
 * (`packages/editors/tree-sitter-mx/test/corpus/*.txt`, which the grammar's
 * own `corpus.bun-test.mts` proves parses with no ERROR/MISSING node) goes
 * through `parseData`. A case either parses clean, or sits in exactly one of
 * two lists:
 *
 * - `intended`: a refusal the language or the data target makes on purpose.
 *   The case must still be refused, and only for a reason in that list.
 * - `knownGaps`: grammar-accepted syntax the data target cannot parse yet.
 *   Bugs, not policy. Expected-failure semantics: the case must still fail, so
 *   fixing one fails this test until its entry is deleted.
 *
 * The class this guards: comments were rejected by the data target from
 * alpha.5 to alpha.10 while the grammar highlighted them fine.
 */

const CORPUS_DIR = path.resolve(
  import.meta.dirname,
  "../../../editors/tree-sitter-mx/test/corpus",
);

interface CorpusCase {
  file: string;
  name: string;
  source: string;
}

// The format `tree-sitter test --update` writes: 15 `=` header lines around a
// name, the source, 15 `-`, the expected tree. Mirrors `read.mts` in the
// corpus directory (this package's rootDir cannot import it).
function readCorpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const header = /^={15}\n(.+)\n={15}\n/;
  const divider = /\n-{15}\n/;
  const next = /\n={15}\n.+\n={15}\n/;
  for (const file of fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .sort()) {
    let rest = fs.readFileSync(path.join(CORPUS_DIR, file), "utf-8");
    while (rest.length > 0) {
      const h = header.exec(rest);
      if (!h) throw new Error(`${file}: no case header`);
      rest = rest.slice(h[0].length);
      const d = divider.exec(rest);
      if (!d) throw new Error(`${file}: ${h[1]} has no divider`);
      const source = rest.slice(0, d.index);
      rest = rest.slice(d.index + d[0].length);
      const n = next.exec(rest);
      rest = n ? rest.slice(n.index + 1) : "";
      cases.push({ file, name: h[1] as string, source });
    }
  }
  return cases;
}

const INTENDED: Record<string, { pattern: RegExp; cases: string[] }> = {
  // decision 54: MX has no scriptlets
  scriptlets: {
    pattern: /scriptlets \(/,
    cases: [
      "commas-relax",
      "scriptlet-block",
      "scriptlet-block-division",
      "scriptlet-block-html",
      "scriptlet-block-multiline-comment",
      "scriptlet-block-regex",
      "scriptlet-block-single-line-comment",
      "scriptlet-block-space-semi-colon",
      "scriptlet-block-template-literal-href",
      "scriptlet-block-with-semi-colon",
      "scriptlet-comment",
      "scriptlet-eof",
      "scriptlet-line",
      "scriptlet-line-continue",
      "scriptlet-line-continue-chain",
      "scriptlet-line-html",
      "scriptlet-line-multiline-comments",
      "scriptlet-line-regex-open-bracket",
      "scriptlet-line-regex-open-curly",
      "scriptlet-line-template-literal",
      "scriptlet-line-trailing-line-comment",
      "scriptlet-terminated-by-semi-colon",
    ],
  },
  // the data target refuses CDATA (build.ts)
  cdata: {
    pattern: /CDATA/,
    cases: ["cdata", "cdata-2", "cdata-pos", "mixed-cdata"],
  },
  // a doctype means nothing in a data file (build.ts)
  doctype: {
    pattern: /doctype/,
    cases: [
      "double-hyphen-block",
      "double-hyphen-line",
      "double-hyphen-line-start",
      "dtd",
      "var",
    ],
  },
  // an XML declaration or processing instruction is refused (build.ts)
  xmlDeclaration: {
    pattern: /XML declaration/,
    cases: ["declaration", "xml-declaration", "xml-declaration-ill-formed"],
  },
  // a dynamic tag has no name in a static tree (build.ts)
  dynamicTag: {
    pattern: /dynamic tag/,
    cases: [
      "argument-and-params",
      "placeholder-tag-name-concise",
      "placeholder-tag-name-html",
      "tag-name-expression-literal-prefix",
      "tag-name-expression-literal-prefix-attrs",
      "tag-name-expression-literal-prefix-suffix",
      "tag-name-expression-literal-suffix",
      "tag-name-expression-shorthand-id",
      "tag-name-expression-simple",
      "tag-name-expression-simple-empty-close",
    ],
  },
  // a tag variable binds without evaluating (build.ts)
  tagVariable: {
    pattern: /tag variable/,
    cases: [
      "comma-after-tag-variable",
      "tag-var-before-concise-text",
      "tag-var-comma-concise",
      "tag-var-declaration",
      "tag-var-type-with-parens",
    ],
  },
  // core merges a shorthand class and a class attribute into a synthesized
  // class with no span (build.ts)
  shorthandClassBesideClass: {
    pattern: /shorthand class/,
    cases: [
      "attr-grouped-3",
      "attr-grouped-4",
      "attr-grouped-multiple",
      "shorthand-class-dynamic-literal-prefix",
      "shorthand-class-dynamic-literal-suffix",
      "shorthand-closing-html",
    ],
  },
  // a bound value is not supported on name sugar
  boundOnSugar: { pattern: /bound value/, cases: ["attr-bound"] },
  // a tag with no argument contract takes none
  tagArguments: {
    pattern: /Tag does not support arguments/,
    cases: [
      "argument-tag",
      "argument-tag-complex",
      "argument-tag-extra-whitespace",
      "argument-tag-nested-parens",
    ],
  },
  // not an attribute name; Marko rejects it too
  invalidAttributeName: {
    pattern: /Invalid attribute name/,
    cases: [
      "comma-ends-attr-operators",
      "complex-attr-name",
      "css-calc",
      "css-grid",
      "placeholder-unnamed-attr-escaped",
      "placeholder-unnamed-attr-escaped-escaped",
      "scriptlet-line-no-middle",
      "unary-as-member-expression",
    ],
  },
  // a newline inside a quoted string is a JS syntax error
  newlineInString: {
    pattern: /Unterminated string constant/,
    cases: ["attr-multi-line-string", "placeholder-within-string-newlines"],
  },
};

const KNOWN_GAPS: Record<string, string[]> = {
  // TypeScript syntax in a tag head (type parameters and arguments, params
  // after a tag var, an argument on an attribute tag) and a nested scriptlet
  // block: "Unexpected token". Marko accepts these; decision 172.
  "ts-syntax-in-tag-head": [
    "argument-tag-attr",
    "attr-method-shorthand-with-type-parameters",
    "param-tag",
    "scriptlet-block-nested",
    "tag-params-with-type-parameters",
    "tag-var-with-params",
    "tag-with-type-arguments",
  ],
  // Operators beside an attribute value across spaces or newlines, and
  // non-literal or undelimited values: "Expected a single expression".
  // htmljs-parser keeps one expression; decision 146 covers only `x .y`.
  "attribute-operator-spacing": [
    "attr-non-literal",
    "attr-operators-newline-after",
    "attr-operators-newline-before",
    "attr-operators-space-after",
    "attr-operators-space-before",
    "attr-operators-space-between",
    "attr-without-delimiters",
  ],
  // Open-tag-only void tags (`<img>`), raw-text `<script>`/`<style>`, an
  // html-comment tag and a regexp attribute: the data taglib switches the
  // HTML parse rules off, so these bodies parse as tags ("Missing ending",
  // "closing X does not match").
  "open-tag-only-and-raw-text": [
    "attr-regexp",
    "html-comment-tag",
    "mixed-open-tag-only",
    "open-tag-only",
    "parsed-text-style-tag",
    "script",
    "script-concise",
    "script-mismatched-close",
  ],
  // `#a${x}`: core builds the id value with no authored span. Rejected
  // positioned (build.ts); it used to be an `internal error`.
  "shorthand-id-placeholder": [
    "shorthand-id-dynamic-literal-prefix",
    "shorthand-id-dynamic-literal-suffix",
  ],
};

const cases = readCorpus();

const intendedBy = new Map<string, { group: string; pattern: RegExp }>();
for (const [group, { pattern, cases: names }] of Object.entries(INTENDED)) {
  for (const name of names) intendedBy.set(name, { group, pattern });
}
const gapBy = new Map<string, string>();
for (const [group, names] of Object.entries(KNOWN_GAPS)) {
  for (const name of names) gapBy.set(name, group);
}

function run(source: string) {
  // Only real parse rejections count: the structural, import and unknown-tag
  // checks are left at their pass-through settings.
  return parseData(source, "/corpus.mx", {
    structural: "pass",
    imports: "pass",
    unknownTags: "allow",
  });
}

describe("tree-sitter-mx corpus through parseData", () => {
  it("reads the whole corpus, and every list entry names a case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(300);
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of [...intendedBy.keys(), ...gapBy.keys()]) {
      expect(names, name).toContain(name);
    }
    for (const name of intendedBy.keys())
      expect(gapBy.has(name), name).toBe(false);
  });

  for (const c of cases) {
    const intended = intendedBy.get(c.name);
    const gap = gapBy.get(c.name);

    if (intended) {
      it(`${c.name}: refused on purpose (${intended.group})`, () => {
        const errors = run(c.source).diagnostics.filter(
          (d) => d.severity === "error",
        );
        expect(errors.length).toBeGreaterThan(0);
        const allowed = Object.values(INTENDED).map((i) => i.pattern);
        for (const e of errors) {
          expect(
            allowed.some((p) => p.test(e.message)),
            e.message,
          ).toBe(true);
        }
      });
    } else if (gap) {
      it(`${c.name}: known gap (${gap}) still fails`, () => {
        const errors = run(c.source).diagnostics.filter(
          (d) => d.severity === "error",
        );
        // Fixed? Delete this case from KNOWN_GAPS.
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.map((e) => e.message).join("\n")).not.toMatch(
          /^internal error/,
        );
      });
    } else {
      it(`${c.file} ${c.name}: parses with no error`, () => {
        const result = run(c.source);
        expect(
          result.diagnostics.filter((d) => d.severity === "error"),
        ).toEqual([]);
        expect(result.tree).toBeDefined();
      });
    }
  }
});

describe("a shorthand id with a placeholder", () => {
  it("is one positioned reject, not an internal error", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax, not a template literal
    const { tree, diagnostics } = run("<x#a${y}/>\n");
    expect(tree).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/shorthand id with a placeholder/);
    expect(diagnostics[0]?.line).toBe(1);
  });
});
