import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lowerSource } from "./index.ts";

/**
 * Every source the `@mxlang/tree-sitter-mx` grammar accepts
 * (`packages/editors/tree-sitter-mx/test/corpus/*.txt`, which the grammar's
 * own `corpus.bun-test.mts` proves parses with no ERROR/MISSING node; its
 * `:error` cases, the sources htmljs-parser rejects, are not conformance cases
 * and are skipped here) goes
 * through `lowerSource`. A case either lowers clean, or sits in exactly one of
 * two lists:
 *
 * - `intended`: a refusal the language or the IR entry point makes on purpose.
 *   The case must still be refused, and only for a reason in that list.
 * - `knownGaps`: grammar-accepted syntax the IR entry point cannot parse yet.
 *   Bugs, not policy. Expected-failure semantics: the case must still fail, so
 *   fixing one fails this test until its entry is deleted.
 *
 * The class this guards: comments were rejected by the data target (the
 * entry point's predecessor, `@mxlang/data`) from
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
  const header = /^={15}\n(.+)\n((?::[a-z]+\n)*)={15}\n/;
  const divider = /\n-{15}\n/;
  const next = /\n={15}\n.+\n(?::[a-z]+\n)*={15}\n/;
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
      if (!(h[2] as string).includes(":error\n"))
        cases.push({ file, name: h[1] as string, source });
    }
  }
  return cases;
}

const INTENDED: Record<string, { pattern: RegExp; cases: string[] }> = {
  // decision 54: MX has no scriptlets (`$ stmt` is refused)
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
  // decision 139: non-tag prologue syntax (CDATA) is refused at the construct
  cdata: {
    pattern: /CDATA/,
    cases: ["cdata", "cdata-2", "cdata-pos", "mixed-cdata"],
  },
  // a doctype means nothing in a data file (checks.ts); same group of non-tag
  // prologue syntax as CDATA: decision 139 addendum 2026-10-09
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
  // decision 139: an XML declaration or processing instruction is refused
  xmlDeclaration: {
    pattern: /XML declaration/,
    cases: ["declaration", "xml-declaration", "xml-declaration-ill-formed"],
  },
  // decision 131 addendum, ruling 3: a dynamic tag has no name in a static tree
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
  // decision 131 addendum, ruling 3: a tag variable binds without evaluating.
  // tag-var-declaration also carries Marko's own `foo + 1 is not a valid tag
  // variable` (Marko refuses `<let/foo + 1/>` too); both match this pattern.
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
  // PR #236 (the message's origin, bc76fdcd2): core merges a shorthand class
  // and a class attribute into a synthesized class with no span
  shorthandClassBesideClass: {
    pattern: /shorthand class/,
    cases: [
      "attr-grouped-3",
      "attr-grouped-4",
      "attr-grouped-multiple",
      "shorthand-closing-html",
    ],
  },
  // decision 146: a bound value is not supported on name sugar
  boundOnSugar: { pattern: /bound value/, cases: ["attr-bound"] },
  // decision 172 (Marko behaviour is the default): a tag with no argument
  // contract takes none, as in stock Marko
  tagArguments: {
    pattern: /Tag does not support arguments/,
    cases: [
      "argument-tag",
      "argument-tag-complex",
      "argument-tag-extra-whitespace",
      "argument-tag-nested-parens",
    ],
  },
  // decision 172 (Marko behaviour is the default): not an attribute name;
  // stock Marko refuses each
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
  // decision 172 (Marko behaviour is the default), the JS string rule: a
  // newline inside a quoted string is a syntax error; stock Marko refuses it
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
  // `#a${x}` and `.a${x}`: core builds the value with no authored span. Stock
  // Marko compiles them. Rejected positioned at the sigil (build.ts); the id
  // case used to be an `internal error`, the class case a wrong "class
  // attribute" message.
  "shorthand-placeholder": [
    "shorthand-class-dynamic-literal-prefix",
    "shorthand-class-dynamic-literal-suffix",
    "shorthand-id-dynamic-literal-prefix",
    "shorthand-id-dynamic-literal-suffix",
  ],
};

/**
 * Gaps of the `none` preset only (`tagRules: "none"`, Mesh's): open-tag-only
 * void tags (`<img>`), raw-text `<script>`/`<style>`, an html-comment tag and
 * a regexp attribute ("Missing ending", "closing X does not match"). Not a
 * bug: `none` switches the HTML parse rules (openTagOnly, text) off on
 * purpose (decision 131 addendum, ruling 1), so these bodies parse as tags.
 * The default, strict rules (decision 212 item 8) parse them all.
 */
const NONE_GAPS: Record<string, string[]> = {
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
};

const cases = readCorpus();

const intendedBy = new Map<string, { group: string; pattern: RegExp }>();
for (const [group, { pattern, cases: names }] of Object.entries(INTENDED)) {
  for (const name of names) intendedBy.set(name, { group, pattern });
}
function gapsOf(...groups: Record<string, string[]>[]): Map<string, string> {
  const gapBy = new Map<string, string>();
  for (const gaps of groups) {
    for (const [group, names] of Object.entries(gaps)) {
      for (const name of names) gapBy.set(name, group);
    }
  }
  return gapBy;
}

/** The corpus under the default rules (strict) and under Mesh's `none`. */
const PRESETS = [
  {
    label: "default (strict) tag rules",
    tagRules: undefined,
    gapBy: gapsOf(KNOWN_GAPS),
  },
  {
    label: '`tagRules: "none"`',
    tagRules: "none" as const,
    gapBy: gapsOf(KNOWN_GAPS, NONE_GAPS),
  },
];

function run(source: string, tagRules?: "none") {
  // Only real parse rejections count: the structural, import and unknown-tag
  // checks are left at their pass-through settings.
  return lowerSource(source, "/corpus.mx", {
    structural: "pass",
    imports: "pass",
    unknownTags: "allow",
    ...(tagRules ? { tagRules } : {}),
  });
}

for (const { label, tagRules, gapBy } of PRESETS) {
  describe(`tree-sitter-mx corpus through lowerSource, ${label}`, () => {
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
          const errors = run(c.source, tagRules).diagnostics.filter(
            (d) => d.severity === "error",
          );
          expect(errors.length).toBeGreaterThan(0);
          const allowed = Object.values(INTENDED).map((i) => i.pattern);
          // Refused for the case's own reason, and for no unlisted one.
          expect(
            errors.some((e) => intended.pattern.test(e.message)),
            errors.map((e) => e.message).join("\n"),
          ).toBe(true);
          for (const e of errors) {
            expect(
              allowed.some((p) => p.test(e.message)),
              e.message,
            ).toBe(true);
          }
        });
      } else if (gap) {
        it(`${c.name}: known gap (${gap}) still fails`, () => {
          const errors = run(c.source, tagRules).diagnostics.filter(
            (d) => d.severity === "error",
          );
          // Fixed? Delete this case from KNOWN_GAPS.
          expect(errors.length).toBeGreaterThan(0);
          expect(errors.map((e) => e.message).join("\n")).not.toMatch(
            /^internal error/m,
          );
        });
      } else {
        it(`${c.file} ${c.name}: parses with no error`, () => {
          const result = run(c.source, tagRules);
          expect(
            result.diagnostics.filter((d) => d.severity === "error"),
          ).toEqual([]);
          expect(result.ir).toBeDefined();
        });
      }
    }
  });
}

describe("a shorthand with a placeholder", () => {
  it.each([
    ["<x#a${y}/>\n", /shorthand id with a placeholder/, 2],
    ["<x.a${y}/>\n", /shorthand class with a placeholder/, 2],
    ["<x.${y}-b/>\n", /shorthand class with a placeholder/, 2],
    ["\n<x.a${y}.b/>\n", /shorthand class with a placeholder/, 2],
  ])("%j is one positioned reject at the sigil", (source, message, column) => {
    const { ir, diagnostics } = run(source);
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(message);
    expect(diagnostics[0]?.line).toBe(source.startsWith("\n") ? 2 : 1);
    expect(diagnostics[0]?.column).toBe(column);
  });

  it("keeps the merged-class message for a shorthand beside a class attribute", () => {
    const { diagnostics } = run('<x.a class="b"/>\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(
      /together with a `class` attribute/,
    );
  });
});
