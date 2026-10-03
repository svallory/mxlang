// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX content syntax
/** Compile outside jsdom: Marko's resolver needs Node conditions, not browser ones. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import ts from "typescript";
import cases from "../../../../test-fixtures/body-whitespace/cases.json";
import { angularOwnTargets } from "../src/own-targets.ts";
import { compileTagModule } from "../src/tag-module.ts";

const dir = process.argv[2];
if (!dir) throw new Error("missing fixture directory");

function writeModule(file: string, source: string) {
  const result = compileTagModule(source, file, {
    customTags: getCustomTags(file, {
      targets: angularOwnTargets,
      host: "angular",
    }),
  });
  const code = ts
    .transpileModule(result.code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
      },
    })
    .outputText.replace(/from "(\.[^"]+?)(?:\.ts)?"/g, 'from "$1.mjs"');
  writeFileSync(file.replace(".mx", ".mjs"), code);
}

writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
mkdirSync(join(dir, "tags"));
const wrap = "<section><${input.content}/></section>";
for (const path of ["wrap.mx", "tags/wrap.mx"]) {
  const file = join(dir, path);
  writeFileSync(file, wrap);
  writeModule(file, wrap);
}
for (const discovered of [false, true]) {
  for (const [index, { body }] of cases.entries()) {
    const tag = discovered ? "wrap" : "Wrap";
    writeModule(
      join(dir, `caller-${discovered}-${index}.mx`),
      `${discovered ? "" : 'import Wrap from "./wrap.mx"\n'}<${tag}>${body}</${tag}>`,
    );
  }
}
