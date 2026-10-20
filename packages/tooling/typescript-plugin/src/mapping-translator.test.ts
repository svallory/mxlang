/**
 * The mapping pass's translator (`createHtmlMappings`): per target, with the
 * default target's as the fallback.
 *
 * `compileMxVirtual` passes `descriptor.translator` so the second lowering
 * sees the same tag map as compilation; a target that defines none (solid,
 * astro, angular, html itself supplies the default) falls back to html's
 * inside `createHtmlMappings`. These tests pin that wiring and the
 * byte-identity of the mappings a JSX host's own translator produces against
 * the fallback's, for sources the two taglibs resolve identically.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetDescriptor } from "@mxlang/core";
import * as core from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHtmlMappings,
  createMxLanguagePlugin,
  MX_LANGUAGE_ID,
} from "./mx-language.ts";

/** Restorations for descriptor properties a test replaced (afterEach). */
const restoreDescriptor: Array<() => void> = [];
afterEach(() => {
  for (const restore of restoreDescriptor.splice(0)) restore();
});

const source = [
  "export interface Input { count: number }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  '<p title="${input.count}">${input.count + 1}</p>',
].join("\n");

/** The generated module a host's own compile produces for `source`. */
function generatedFor(descriptor: TargetDescriptor): string {
  const load = descriptor.load;
  if (!load) throw new Error(`missing load on ${descriptor.name}`);
  const compiled = load(core).compileModule(
    source,
    "/src/mapping-translator.mx",
    {
      warnings: [],
    },
  );
  return compiled.code;
}

function lookup(): ReturnType<typeof builtinLookup> {
  return builtinLookup();
}

const jsxHosts = ["preact-jsx", "react-jsx", "hono-jsx"] as const;
const withoutOwn = ["solid-jsx", "astro-html", "angular-template"] as const;

describe("createHtmlMappings translator selection", () => {
  it("consults the translator it is passed, not the default target's", () => {
    const descriptor = lookup().target("preact-jsx");
    if (!descriptor) throw new Error("missing preact-jsx descriptor");
    const poison = {
      get taglibs(): never {
        throw new Error("the poisoned translator was consulted");
      },
    };
    expect(() =>
      createHtmlMappings(
        source,
        "/src/mapping-translator.mx",
        generatedFor(descriptor),
        false,
        descriptor.declarations?.default,
        [],
        undefined,
        [],
        lookup(),
        undefined,
        poison,
      ),
    ).toThrow("the poisoned translator was consulted");
  });

  it.each(jsxHosts)(
    "%s: its own translator yields the same mappings as html's fallback",
    (name) => {
      const descriptor = lookup().target(name);
      if (!descriptor) throw new Error(`missing ${name} descriptor`);
      const fallback = lookup().target(lookup().defaultTarget());
      if (!fallback) throw new Error("missing default target descriptor");
      const generated = generatedFor(descriptor);
      const declarations = descriptor.declarations?.default;
      if (!declarations) throw new Error(`missing ${name} declarations`);
      expect(descriptor.translator, name).toBeDefined();
      const withOwn = createHtmlMappings(
        source,
        "/src/mapping-translator.mx",
        generated,
        false,
        declarations,
        [],
        undefined,
        [],
        lookup(),
        undefined,
        descriptor.translator,
      );
      const withFallback = createHtmlMappings(
        source,
        "/src/mapping-translator.mx",
        generated,
        false,
        declarations,
        [],
        undefined,
        [],
        lookup(),
        undefined,
        fallback.translator,
      );
      expect(withOwn.length, name).toBeGreaterThan(0);
      expect(withOwn, name).toEqual(withFallback);
    },
  );

  it.each(withoutOwn)(
    "%s really falls back to html's translator for its mapping pass",
    (name) => {
      const descriptor = lookup().target(name);
      if (!descriptor) throw new Error(`missing ${name} descriptor`);
      expect(descriptor.translator, name).toBeUndefined();
      const declarations = descriptor.declarations?.default;
      if (!declarations) throw new Error(`missing ${name} declarations`);
      // Angular defines no page compiler (the plugin skips its pages), so its
      // fallback is exercised over html-generated code: what the test pins is
      // `createHtmlMappings` substituting html's translator, not a compiler.
      const fallbackTarget = lookup().target(lookup().defaultTarget());
      if (!fallbackTarget?.load) throw new Error("missing html load");
      const generated = generatedFor(
        name === "angular-template" ? fallbackTarget : descriptor,
      );
      // No `translator` passed: `createHtmlMappings` must substitute the
      // default target's, not crash, and produce exactly the mappings an
      // explicit html translator would for this target's own generated code.
      const viaFallback = createHtmlMappings(
        source,
        "/src/mapping-translator.mx",
        generated,
        false,
        declarations,
        [],
        undefined,
        [],
        lookup(),
      );
      const fallback = lookup().target(lookup().defaultTarget());
      if (!fallback?.translator) throw new Error("missing html translator");
      const viaHtml = createHtmlMappings(
        source,
        "/src/mapping-translator.mx",
        generated,
        false,
        declarations,
        [],
        undefined,
        [],
        lookup(),
        undefined,
        fallback.translator,
      );
      expect(viaFallback.length, name).toBeGreaterThan(0);
      expect(viaFallback, name).toEqual(viaHtml);
    },
  );

  it("a carrier translator (a dialect's taglibs array) drives the pass", () => {
    const descriptor = lookup().target("hono-jsx");
    if (!descriptor) throw new Error("missing hono-jsx descriptor");
    const declarations = descriptor.declarations?.default;
    if (!declarations) throw new Error("missing hono-jsx declarations");
    // The shape `createTranslator` returns: a plain carrier whose `taglibs`
    // a third-party dialect fills. It — not hono's own translator — must be
    // the table the pass reads.
    let reads = 0;
    const carrier = {
      get taglibs() {
        reads++;
        return [];
      },
    };
    const mappings = createHtmlMappings(
      source,
      "/src/mapping-translator.mx",
      generatedFor(descriptor),
      false,
      declarations,
      [],
      undefined,
      [],
      lookup(),
      undefined,
      carrier,
    );
    expect(reads, "the carrier's taglibs was read").toBeGreaterThan(0);
    expect(mappings.length).toBeGreaterThan(0);
  });
});

describe("compileMxVirtual wiring", () => {
  it.each(jsxHosts)(
    "a %s compile hands its descriptor's own translator to the mapping pass",
    (name) => {
      const descriptor = lookup().target(name);
      if (!descriptor) throw new Error(`missing ${name} descriptor`);
      const own = Object.getOwnPropertyDescriptor(descriptor, "translator");
      let mapped = 0;
      Object.defineProperty(descriptor, "translator", {
        configurable: true,
        get() {
          return {
            get taglibs() {
              const stack = new Error().stack ?? "";
              if (stack.includes("createHtmlMappings")) mapped++;
              return [];
            },
          };
        },
      });
      restoreDescriptor.push(() =>
        own
          ? Object.defineProperty(descriptor, "translator", own)
          : delete (descriptor as { translator?: unknown }).translator,
      );
      const dir = mkdtempSync(join(tmpdir(), "mx-mapping-wire-"));
      try {
        writeFileSync(
          join(dir, "package.json"),
          `{"mx":{"host":"${name.replace("-jsx", "")}"}}\n`,
        );
        const file = join(dir, "page.mx");
        const plugin = createMxLanguagePlugin(ts);
        plugin.createVirtualCode?.(
          file,
          MX_LANGUAGE_ID,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
          ts.ScriptSnapshot.fromString("<p>${1}</p>\n"),
          { getAssociatedScript: () => undefined },
        );
        const diagnostics = plugin.getCompileDiagnostics(file);
        expect(diagnostics).toEqual([]);
        expect(
          mapped,
          "the mapping pass read the target's own translator",
        ).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
