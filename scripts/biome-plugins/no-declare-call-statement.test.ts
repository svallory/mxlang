import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const biome = join(repoRoot, "node_modules", ".bin", "biome");
const ruleFile = "no-declare-call-statement.grit";

const FAILS: Array<[string, string]> = [
  ["a top-level statement", "declare(x);\n"],
  ["a statement without a semicolon", "declare(x)\nfoo();\n"],
  ["a statement inside a block", "if (c) {\n  declare(x);\n}\n"],
  ["a statement inside a loop body", "for (const x of xs) declare(x);\n"],
  ["a statement split over two lines", "declare\n(x);\n"],
  ["an optional call", "declare?.(1);\n"],
  ["a call with type arguments", "declare<number>(1);\n"],
  ["a non-null call", "declare!(1);\n"],
  ["a call with a type assertion", "declare(1) as any;\n"],
  ["a tagged template", "declare`x`;\n"],
  ["a .call", "declare.call(null, 1);\n"],
  ["a .apply", "declare.apply(null, [1]);\n"],
  ["a computed member call", "declare[`call`](null, 1);\n"],
  ["a comma expression", "declare(1), y;\n"],
  ["a binary expression", "declare(1) + 1;\n"],
  ["a logical expression", "declare(1) || f(1);\n"],
];

const PASSES: Array<[string, string]> = [
  ["a method call", "x.declare(1);\n"],
  ["an optional method call", "x?.declare(1);\n"],
  ["a call used as an initializer", "const y = declare(x);\n"],
  ["a call as an arrow body", "xs.forEach((v) => declare(v));\n"],
  ["a call as an argument", "foo(declare(x));\n"],
  ["a call that is returned", "function f() {\n  return declare(x);\n}\n"],
  [
    "another keyword-named helper",
    "type(x);\nabstract(x);\nnamespace(x);\nmodule(x);\nglobal(x);\n",
  ],
  ["a differently named helper", "countName(x);\n"],
  ["a name that starts with declare", "declareX(x);\ndeclare$(x);\n"],
  ["a parenthesized callee", "(declare)(1);\n"],
  ["a parenthesized call", "(declare(1));\n"],
  ["a void call", "void declare(1);\n"],
  ["an awaited call", "async function f() {\n  await declare(1);\n}\n"],
];

const LINE_SOURCE = "const a = 1;\n\ndeclare(a);\n";
const MUTATION_SOURCE = "declare(x);\n";

/** Every source the tests lint, linted together in one biome run. */
const SOURCES = [
  ...new Set([
    ...FAILS.map(([, source]) => source),
    ...PASSES.map(([, source]) => source),
    LINE_SOURCE,
  ]),
];

type LintResult = { failed: boolean; output: string };

type BiomeDiagnostic = {
  severity: string;
  message: string;
  category: string;
  location?: { path?: string; start?: { line: number; column: number } };
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escapes
const ansi = /\u001b\[[0-9;]*m/g;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Lint every source as its own `case-<n>.ts` in one directory, under a config
 * that loads only `rule`, in ONE biome spawn. Each case's result is the
 * diagnostics biome reported for its file, rendered as
 * `case.ts:<line>:<col> <category> <message>`.
 */
function lintAll(
  sources: readonly string[],
  rule: string,
): Map<string, LintResult> {
  const dir = mkdtempSync(join(tmpdir(), "mx-biome-plugin-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "biome.json"),
    JSON.stringify({
      linter: { enabled: true, rules: { recommended: false } },
      plugins: [rule],
    }),
  );
  const files = sources.map((source, n) => {
    const file = `case-${n}.ts`;
    writeFileSync(join(dir, file), source);
    return file;
  });
  const result = spawnSync(
    biome,
    [
      "lint",
      "--config-path",
      dir,
      "--reporter=json",
      "--max-diagnostics=none",
      ...files.map((file) => join(dir, file)),
    ],
    { encoding: "utf8" },
  );
  const stdout = result.stdout.replace(ansi, "");
  const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    summary: { diagnosticsNotPrinted: number };
    diagnostics: BiomeDiagnostic[];
  };
  if (report.summary.diagnosticsNotPrinted !== 0) {
    throw new Error(
      `biome withheld ${report.summary.diagnosticsNotPrinted} diagnostics`,
    );
  }
  const byFile = new Map<string, string[]>(files.map((file) => [file, []]));
  for (const d of report.diagnostics) {
    const lines = byFile.get(basename(d.location?.path ?? ""));
    if (!lines) {
      // An error outside the case files (a rule biome cannot load) must not
      // read as "every case passed".
      if (d.severity === "error") {
        throw new Error(`biome error outside the cases: ${d.message}`);
      }
      continue;
    }
    const at = d.location?.start
      ? `${d.location.start.line}:${d.location.start.column}`
      : "?";
    lines.push(`case.ts:${at} ${d.category} ${d.message}`);
  }
  return new Map(
    sources.map((source, n) => {
      const lines = byFile.get(files[n] as string) ?? [];
      return [source, { failed: lines.length > 0, output: lines.join("\n") }];
    }),
  );
}

let results: Map<string, LintResult>;
let mutated: Map<string, LintResult>;

beforeAll(() => {
  results = lintAll(SOURCES, join(here, ruleFile));
  // Mutation check: a rule that no longer matches `declare` lets the fixture through.
  const dir = mkdtempSync(join(tmpdir(), "mx-biome-plugin-rule-"));
  dirs.push(dir);
  const rule = join(dir, ruleFile);
  writeFileSync(
    rule,
    readFileSync(join(here, ruleFile), "utf8").replace(
      'r"declare(?:',
      'r"other(?:',
    ),
  );
  mutated = lintAll([MUTATION_SOURCE], rule);
});

/** The precomputed result for `source`; a source missing from the batch throws. */
function lint(source: string, from = results): LintResult {
  const result = from.get(source);
  if (!result)
    throw new Error(`source not in the batch: ${JSON.stringify(source)}`);
  return result;
}

describe("no-declare-call-statement", () => {
  it("is the rule that biome.json loads", () => {
    const config = JSON.parse(
      readFileSync(join(repoRoot, "biome.json"), "utf8"),
    );
    expect(config.plugins).toContain(`./scripts/biome-plugins/${ruleFile}`);
  });

  it.each(FAILS)("fails on %s", (_name, source) => {
    const { failed, output } = lint(source);
    expect(failed).toBe(true);
    expect(output).toContain("Bun 1.3.14's TypeScript transpiler erases");
    expect(output).toContain("Rename the helper");
  });

  it.each(PASSES)("passes on %s", (_name, source) => {
    const { failed, output } = lint(source);
    expect(output).not.toContain("transpiler erases");
    expect(failed).toBe(false);
  });

  it("reports the line of the statement", () => {
    const { output } = lint(LINE_SOURCE);
    expect(output).toContain("case.ts:3:1");
  });

  // Mutation check: a rule that no longer matches `declare` lets the fixture through.
  it("stops failing when the name is removed from the rule", () => {
    expect(lint(MUTATION_SOURCE, mutated).failed).toBe(false);
  });
});
