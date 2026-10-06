import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { here, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

// Three independent errors: a scriptlet, an `<if>` without a condition, CDATA.
const PAGE = [
  "<div>ok</div>",
  "$ const a = 1",
  "<p>fine</p>",
  "<if></if>",
  "<![CDATA[raw]]>",
  "<span>fine</span>",
].join("\n");

it(
  "prints every error of a file in one run (decision 162)",
  () => {
    const dir = mkdtempSync(join(here, ".tmp-error-recovery-"));
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
      writeFileSync(join(dir, "page.mx"), PAGE);
      const result = run(mxTsc, ["--noEmit", "--pretty", "false", "-p", dir]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("page.mx(2,1): error TS80001");
      expect(result.output).toContain("page.mx(4,1): error TS80001");
      expect(result.output).toContain("page.mx(5,1): error TS80001");
      expect(result.output).toContain("scriptlets");
      expect(result.output).toContain("without a condition");
      expect(result.output).toContain("CDATA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);
