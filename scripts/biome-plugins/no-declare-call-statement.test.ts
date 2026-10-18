import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const biome = join(repoRoot, "node_modules", ".bin", "biome");
const ruleFile = "no-declare-call-statement.grit";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Lint `source` as a .ts file under a config that loads only `rule`. */
function lint(
  source: string,
  rule = join(here, ruleFile),
): {
  failed: boolean;
  output: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "mx-biome-plugin-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "biome.json"),
    JSON.stringify({
      linter: { enabled: true, rules: { recommended: false } },
      plugins: [rule],
    }),
  );
  writeFileSync(join(dir, "case.ts"), source);
  const result = spawnSync(
    biome,
    ["lint", "--config-path", dir, join(dir, "case.ts")],
    {
      encoding: "utf8",
    },
  );
  return {
    failed: result.status !== 0,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe("no-declare-call-statement", () => {
  it("is the rule that biome.json loads", () => {
    const config = JSON.parse(
      readFileSync(join(repoRoot, "biome.json"), "utf8"),
    );
    expect(config.plugins).toContain(`./scripts/biome-plugins/${ruleFile}`);
  });

  it.each([
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
  ])("fails on %s", (_name, source) => {
    const { failed, output } = lint(source);
    expect(failed).toBe(true);
    expect(output).toContain("Bun 1.3.14's TypeScript transpiler erases");
    expect(output).toContain("Rename the helper");
  });

  it.each([
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
  ])("passes on %s", (_name, source) => {
    const { failed, output } = lint(source);
    expect(output).not.toContain("transpiler erases");
    expect(failed).toBe(false);
  });

  it("reports the line of the statement", () => {
    const { output } = lint("const a = 1;\n\ndeclare(a);\n");
    expect(output).toContain("case.ts:3:1");
  });

  // Mutation check: a rule that no longer matches `declare` lets the fixture through.
  it("stops failing when the name is removed from the rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-biome-plugin-rule-"));
    dirs.push(dir);
    const mutated = join(dir, ruleFile);
    writeFileSync(
      mutated,
      readFileSync(join(here, ruleFile), "utf8").replace(
        'r"declare(?:',
        'r"other(?:',
      ),
    );
    expect(lint("declare(x);\n", mutated).failed).toBe(false);
  });
});
