import * as core from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";
import { describe, expect, it } from "vitest";
import { createHtmlMappings } from "./mx-language.ts";

// All these whole-file targets share the independent IR mapping re-lower.
const targets = [
  "html",
  "preact-jsx",
  "react-jsx",
  "hono-jsx",
  "astro-html",
] as const;
const source = [
  "export interface Input { a: string }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  "<p<string> title=input.a>${(input.a as string) satisfies string}</p>",
].join("\n");

describe("tag erasure across mapping targets", () => {
  it.each(targets)(
    "%s keeps the same generated text and exact mappings",
    (name) => {
      const lookup = builtinLookup();
      const descriptor = lookup.target(name);
      if (!descriptor?.load) throw new Error(`missing ${name} compiler`);
      const compiler = descriptor.load(core);
      const fileName = "/project/mapping-host.mx";
      // Replace only the erased container, keeping all authored offsets equal.
      const padded = source.replace("<string>", " ".repeat("<string>".length));
      const compiled = compiler.compileModule(source, fileName, {
        typeCheck: true,
        targets: lookup,
      });
      const baseline = compiler.compileModule(padded, fileName, {
        typeCheck: true,
        targets: lookup,
      });
      expect(compiled.code).toBe(baseline.code);
      const map = (text: string, result: typeof compiled) =>
        createHtmlMappings(
          text,
          fileName,
          result.code,
          false,
          descriptor.declarations?.default,
          result.mappings,
          undefined,
          [],
          lookup,
          undefined,
          descriptor.translator,
        );
      const mappings = map(source, compiled);
      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings).toEqual(map(padded, baseline));
    },
  );
});
