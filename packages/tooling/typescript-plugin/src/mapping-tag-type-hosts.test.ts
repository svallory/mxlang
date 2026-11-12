import * as core from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";
import { describe, expect, it } from "vitest";
import { createHtmlMappings } from "./mx-language.ts";

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX

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

const jsxHosts = ["preact-jsx", "react-jsx", "hono-jsx"] as const;

/** Each final mapping as [authored text, generated text, generated offset]. */
function mapped(name: (typeof jsxHosts)[number], text: string) {
  const lookup = builtinLookup();
  const descriptor = lookup.target(name);
  if (!descriptor?.load) throw new Error(`missing ${name} compiler`);
  const fileName = "/project/mapping-values.mx";
  const result = descriptor
    .load(core)
    .compileModule(text, fileName, { typeCheck: true, targets: lookup });
  const mappings = createHtmlMappings(
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
  const recorded = (result.mappings ?? []).map((mapping) => ({
    source: text.slice(mapping.sourceStart, mapping.sourceEnd),
    generatedOffset: mapping.generatedStart,
  }));
  const final = mappings.map((mapping) => {
    const [from = 0] = mapping.sourceOffsets;
    const [to = 0] = mapping.generatedOffsets;
    return {
      source: text.slice(from, from + (mapping.lengths[0] ?? 0)),
      generated: result.code.slice(
        to,
        to + (mapping.generatedLengths?.[0] ?? mapping.lengths[0] ?? 0),
      ),
      generatedOffset: to,
    };
  });
  return Object.assign(final, { recorded });
}

describe("expression values map to their authored text on every JSX host", () => {
  const IMPORT = 'import Field from "./field.mx"\n';
  // Measured not to reproduce; hono only, since it had no mapping test of its
  // own and the three JSX hosts share one emitter.
  it.each(["hono-jsx"] as const)(
    "%s: a component prop's function value",
    (name) => {
      const found = mapped(
        name,
        `${IMPORT}<Field onPick=function () { go() }/>`,
      );
      expect(
        found.filter((m) => m.source === "function () { go() }"),
      ).not.toHaveLength(0);
    },
  );

  it.each(["hono-jsx"] as const)("%s: $!{} raw text", (name) => {
    const found = mapped(name, "<p>$!{input.html}</p>");
    expect(found.map((m) => m.source)).toContain("input.html");
  });

  it.each(["hono-jsx"] as const)(
    "%s: a <for of=> and an <if=> attribute value",
    (name) => {
      expect(
        mapped(name, "<for|x| of=items><p>${x}</p></for>").map((m) => m.source),
      ).toContain("items");
      expect(
        mapped(name, "<if=cond><p>a</p></if>").map((m) => m.source),
      ).toContain("cond");
    },
  );

  // A text match for an expression the emitter recorded itself is a guess:
  // `n` is first found in the emitted helper preamble, ahead of its real place.
  it.each(jsxHosts)(
    "%s: a recorded prop value is not also mapped to an earlier text match",
    (name) => {
      const found = mapped(name, `${IMPORT}<Field count=n/>`);
      const recorded = found.recorded.filter((m) => m.source === "n");
      expect(recorded).toHaveLength(1);
      expect(
        found
          .filter((m) => m.source === "n")
          .map(({ source, generatedOffset }) => ({
            source,
            generatedOffset,
          })),
      ).toEqual(recorded);
    },
  );
});
