import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

it("policy errors alone fail one program; fixing them leaves host warnings non-fatal", {
  timeout: 120_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "mx-tsc-target-"));
  try {
    const cases = [
      { target: "bogus" },
      { host: "solid", target: "html" },
      { target: "@acme/target" },
      { target: "tree" },
    ];
    for (const [i, mx] of cases.entries()) {
      const dir = join(root, `p${i}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ mx }));
      writeFileSync(join(dir, "page.mx"), "<p>ok</p>\n");
    }
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "esnext",
          jsx: "preserve",
          types: [],
          allowImportingTsExtensions: true,
          paths: {
            "@mxlang/html": [
              join(
                import.meta.dirname,
                "..",
                "..",
                "..",
                "targets",
                "html",
                "src",
                "index.ts",
              ),
            ],
          },
        },
        include: ["**/*.mx"],
      }),
    );
    const args = ["-p", root, "--pretty", "false"];
    const failed = runInProcess(args);
    const output = stripVTControlCharacters(failed.stderr + failed.stdout);
    expect(failed.status).toBe(1);
    expect(output.match(/error TS80003/g)).toHaveLength(cases.length);
    expect(output).toContain('mx.target "html" has no host');
    expect(output).toContain(
      'mx.target "@acme/target" cannot be resolved from',
    );
    expect(output).toContain("TODO data-target-tooling-dispatch");
    for (const i of cases.keys())
      writeFileSync(
        join(root, `p${i}`, "package.json"),
        '{"mx":{"host":"bogus","target":"html"}}',
      );
    const fixed = runInProcess(args);
    expect(fixed.status).toBe(0);
    expect(stripVTControlCharacters(fixed.stderr)).toContain("warning TS80003");
    expect(fixed.stderr).not.toContain("error TS80003");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
