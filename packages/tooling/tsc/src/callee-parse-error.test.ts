import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { here, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

it.each([
  ["<p>ok</p>\n\n<div>\n", 3, 0],
  ["<div a=(x +)/>\n<span>", 1, 11],
] as const)(
  "prints a child syntax error at the child's authored line/column",
  (source, line, column) => {
    const dir = mkdtempSync(join(here, ".tmp-callee-parse-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"x","mx":{"host":"html"}}',
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            allowArbitraryExtensions: true,
          },
          include: ["page.mx"],
        }),
      );
      mkdirSync(join(dir, "tags"));
      writeFileSync(join(dir, "tags/broken.mx"), source);
      writeFileSync(join(dir, "page.mx"), "<main>\n  <broken/>\n</main>\n");
      const result = run(mxTsc, ["--noEmit", "--pretty", "false", "-p", dir]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        `tags/broken.mx(${line},${column + 1}): error TS80001`,
      );
      expect(result.output).toContain("page.mx(1,1): error TS80001");
      expect(result.output).toContain(`tags/broken.mx:${line}:${column + 1})`);
      expect(result.output).not.toContain("page.mx(2,3)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);
