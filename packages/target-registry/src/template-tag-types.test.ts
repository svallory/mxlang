import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import { builtinLookup, getCustomTags } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  core.clearScanCache();
  core.resetTemplateCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const cases = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["element arguments", "<p<string>>${input.a}</p>", "<p>${input.a}</p>"],
  [
    "const arguments",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    "<const<string>/value=input.a/>\n<p>${value}</p>",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    "<const/value=input.a/>\n<p>${value}</p>",
  ],
  [
    "define parameters",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    "<define/Foo<T>|value: T|><p>${value}</p></define>\n<Foo(input.a)/>",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    "<define/Foo|value: T|><p>${value}</p></define>\n<Foo(input.a)/>",
  ],
  [
    "generic tag call",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    "<define/Foo|value|><p>${value}</p></define>\n<Foo<string>(input.a)/>",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    "<define/Foo|value|><p>${value}</p></define>\n<Foo(input.a)/>",
  ],
  [
    "generic expression call",
    "static function identity<T>(value: T): T { return value; }\n" +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<p<string>>${identity<string>(input.a)}</p>",
    "static function identity<T>(value: T): T { return value; }\n" +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<p>${identity<string>(input.a)}</p>",
  ],
] as const;

for (const target of ["html", "preact-jsx", "react-jsx", "hono-jsx"]) {
  for (const typeCheck of [false, true]) {
    describe(`${target}, typeCheck=${typeCheck}: discovered template types`, () => {
      it.each(cases)("erases %s in caller metadata", (_name, typed, plain) => {
        const root = mkdtempSync(join(tmpdir(), "mx-template-tag-types-"));
        dirs.push(root);
        writeFileSync(join(root, "package.json"), '{"name":"tag-types-test"}');
        mkdirSync(join(root, "tags"));
        const page = join(root, "page.mx");
        const unit = join(root, "tags/x.mx");
        const targets = builtinLookup();
        const descriptor = targets.target(target);
        const compiler = descriptor?.load?.(core);
        if (!compiler) throw new Error(`missing compiler for ${target}`);
        const options = { targets, typeCheck };
        const source = (body: string) =>
          `export interface Input { a: string }\n${body}\n<return value=input.a as string/>`;
        const compileCaller = (body: string) => {
          core.clearScanCache();
          core.resetTemplateCache();
          writeFileSync(unit, source(body));
          const customTags = getCustomTags(page, {
            host: descriptor?.host?.name,
          });
          expect(customTags.x).toBeDefined();
          const warnings: core.MxWarning[] = [];
          const result = compiler.compileModule(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
            '<x/result a="hi"/>\n<p>${result}</p>',
            page,
            { ...options, customTags, warnings },
          );
          return { result, warnings };
        };

        // Cold-cache calls exercise the metadata reparse, not a prior unit compile.
        const baseline = compileCaller(plain);
        const actual = compileCaller(typed);
        expect(actual).toEqual(baseline);
        expect(actual.result.code).toContain("./tags/x.mx");
        // The tag's own whole-file compile already erases tag containers too.
        expect(compiler.compileModule(source(typed), unit, options).code).toBe(
          compiler.compileModule(source(plain), unit, options).code,
        );
      });
    });
  }
}
