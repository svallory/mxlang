import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

it(
  "keeps a class diagnostic positioned after a no-import directive prologue and hoisted tag import",
  () => {
    const dir = realpathSync(
      mkdtempSync(join(tmpdir(), "mx-ng-hoist-position-")),
    );
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "hoist-position",
          mx: { host: "angular", angular: { diagnostics: "off" } },
        }),
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            module: "esnext",
            moduleResolution: "bundler",
            target: "esnext",
            experimentalDecorators: true,
            types: [],
          },
          include: ["src/x.component.ng.mx"],
        }),
      );
      mkdirSync(join(dir, "src/tags"), { recursive: true });
      writeFileSync(join(dir, "src/tags/badge.mx"), "<span>badge</span>");
      // TypeScript resolves the generated sibling; this test is about the caller's map.
      writeFileSync(join(dir, "src/tags/badge.ts"), "export class Badge {}\n");
      const source =
        '/* detached header */\n\n"use client";\n"use strict";\ndeclare function Component(options: object): ClassDecorator;\n@Component({ template: <div><badge/></div> })\nexport class XComponent { bad: number = "str"; }\n';
      writeFileSync(join(dir, "src/x.component.ng.mx"), source);
      const result = run(mxTsc, ["--noEmit", "-p", dir]);
      const before = source.slice(0, source.indexOf("bad:")).split("\n");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        `x.component.ng.mx(${before.length},${(before.at(-1) ?? "").length + 1}): error TS2322`,
      );
      expect(result.output.match(/error TS/g), result.output).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);
