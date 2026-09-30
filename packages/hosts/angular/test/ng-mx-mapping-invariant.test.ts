import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCustomTags } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { isDerivedFrom } from "../../../oracle/src/report-angular.ts";
import { compileNgMx } from "../src/ng-mx.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "../../../oracle/fixtures/angular");

/** Inverts the emitter's escaping, as the oracle's page check does. */
function unescapeGenerated(text: string): string {
  return text
    .replace(/\{\{ '(\{|\})' \}\}/g, "$1")
    .replace(/&#64;/g, "@")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Every mapping `compileNgMx` returns must be aligned: its source slice is what
 * its generated slice un-escapes to, or the emitter tagged it as derived and
 * the oracle's exact derivation check accepts it. A mapping into the wrong
 * text would otherwise reach Volar with full capabilities.
 */
function misalignedMappings(source: string, filename: string, customTags = {}) {
  const result = compileNgMx(source, filename, {
    customTags: customTags as never,
  });
  return result.mappings
    .map((mapping) => ({
      mapping,
      generated: result.code.slice(
        mapping.generatedStart,
        mapping.generatedEnd,
      ),
      source: source.slice(mapping.sourceStart, mapping.sourceEnd),
    }))
    .filter(({ mapping, generated, source: text }) => {
      if (text.trim() === "") return true;
      if (unescapeGenerated(generated) === text) return false;
      return !isDerivedFrom(
        generated,
        text,
        mapping.derive,
        mapping.deriveContext,
      );
    })
    .map(({ generated, source: text, mapping }) => ({
      generated,
      source: text,
      sourceStart: mapping.sourceStart,
    }));
}

function component(template: string, preamble = ""): string {
  return [
    'import { Component } from "@angular/core";',
    preamble,
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    "export class XComponent { x = 1; items = [1]; cls = 'a'; go() {} }",
  ].join("\n");
}

describe("compileNgMx mapping invariant", () => {
  const shapes: Record<string, string> = {
    "static attribute names": '<div class="a" id="b">hi</div>',
    "bound attribute": "<div title=x>hi</div>",
    "boolean attribute": "<input disabled/>",
    "event handler": "<button onClick=go>x</button>",
    "class object": "<div class={active: x}>x</div>",
    "style object": "<div style={color: cls}>x</div>",
    "mixed static and bound": '<a href="/x" title=x rel="y">l</a>',
    "control flow":
      '<div><if=(x > 0)><p class=cls>${x}</p></if><else><p id="e">n</p></else></div>',
    "for loop":
      '<ul><for|i| of=items by=(i => i)><li class="row">${i}</li></for></ul>',
    "multi-line region": [
      "<section",
      '  class="wrap"',
      '  id="main"',
      ">",
      '  <p class="inner">${x}</p>',
      "</section>",
    ].join("\n"),
  };

  for (const [name, template] of Object.entries(shapes)) {
    it(`aligns every mapping: ${name}`, () => {
      expect(misalignedMappings(component(template), "/p/x.ng.mx")).toEqual([]);
    });
  }

  it("aligns every mapping after a long, multi-line preamble", () => {
    const preamble = Array.from(
      { length: 12 },
      (_, i) => `const filler${i} = "${"x".repeat(60)}";`,
    ).join("\n");
    expect(
      misalignedMappings(
        component('<div class="a" id="b" title=x>${x}</div>', preamble),
        "/p/x.ng.mx",
      ),
    ).toEqual([]);
  });

  it("aligns every mapping in the oracle .ng.mx fixtures", () => {
    let compiled = 0;
    for (const name of readdirSync(fixtureRoot)) {
      const path = join(fixtureRoot, name, "input.ng.mx");
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      let bad: ReturnType<typeof misalignedMappings>;
      try {
        bad = misalignedMappings(
          source,
          path,
          getCustomTags(path, { host: "angular" }),
        );
      } catch {
        continue; // an error fixture: it is meant not to compile
      }
      compiled++;
      expect({ fixture: name, bad }).toEqual({ fixture: name, bad: [] });
    }
    expect(compiled).toBeGreaterThanOrEqual(3);
  });
});
