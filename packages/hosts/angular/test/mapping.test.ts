/**
 * Mapping tests (task 2.2b).
 *
 * Every assertion here is the same shape, and it is the one that matters:
 * slice the emitted template by a mapping's generated span, slice the `.mx`
 * source by its source span, and check both against the text they must be.
 * A mapping that is off by a byte on either side fails, which a test
 * asserting only "some mapping exists" would not catch.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile, compileTagModule } from "../src/index.ts";
import {
  lineColumnAt,
  offsetAt,
  resolveLineColumn,
  sourceOffsetFor,
} from "../src/mapping.ts";

/**
 * Compiles `source` and returns the pairs each mapping slices to.
 *
 * Both halves come from slicing, never from the emitter's own report, so a
 * mapping whose offsets do not select the text it claims cannot pass.
 */
function slicePairs(
  source: string,
): Array<{ generated: string; source: string }> {
  const result = compile(source, "x.mx");
  return result.mappings.map((mapping) => ({
    generated: result.code.slice(mapping.generatedStart, mapping.generatedEnd),
    source: source.slice(mapping.sourceStart, mapping.sourceEnd),
  }));
}

/** Asserts that some mapping slices to exactly this generated/source pair. */
function expectPair(
  source: string,
  generated: string,
  sourceText: string,
): void {
  expect(slicePairs(source)).toContainEqual({ generated, source: sourceText });
}

describe("mappings: expressions", () => {
  it("maps an interpolation expression to its source text", () => {
    expectPair("<div>${user.name}</div>", "user.name", "user.name");
  });

  it("maps a dynamic attribute's expression and its name", () => {
    const source = "<div title=user.name/>";
    expectPair(source, "user.name", "user.name");
    expectPair(source, "title", "title");
  });

  it("maps an @if condition", () => {
    expectPair("<if=user.admin><p>hi</p></if>", "user.admin", "user.admin");
  });

  it("maps each @else if condition to its own source", () => {
    const source = "<if=a><p>1</p></if><else if=b><p>2</p></else>";
    expectPair(source, "a", "a");
    expectPair(source, "b", "b");
  });

  it("maps a @for list expression", () => {
    expectPair("<for|i| of=items><p>${i}</p></for>", "items", "items");
  });

  it("maps a @let init expression", () => {
    expectPair("<const/total=a+b/><p>${total}</p>", "a+b", "a+b");
  });

  it("maps an event handler expression", () => {
    expectPair("<button onClick=save>x</button>", "save", "save");
  });

  it("maps the derived DOM event name back to the authored attribute", () => {
    // `onClick` is written, `click` is emitted — different spellings, which
    // is exactly the case a mapping has to carry.
    expectPair("<button onClick=save>x</button>", "click", "onClick");
  });

  it("maps a `<for in=>` object expression", () => {
    expectPair("<for|k,v| in=counts><p>${k}</p></for>", "counts", "counts");
  });
});

describe("mappings: dynamic component outlet", () => {
  it("maps the component expression and each input's name and value", () => {
    // `[ngComponentOutletInputs]` used to be built as one raw string, so
    // every input inside it was unmapped.
    const source = '<${Cmp} a=count b="x"/>';
    const pairs = slicePairs(source);
    expect(pairs).toContainEqual({ generated: "Cmp", source: "Cmp" });
    expect(pairs).toContainEqual({ generated: "a", source: "a" });
    expect(pairs).toContainEqual({ generated: "count", source: "count" });
    expect(pairs).toContainEqual({ generated: "b", source: "b" });
  });
});

describe("mappings: names", () => {
  // A *discovered* tag call carries no `nameSpan`: core sets it to
  // `nodeSpan(ctx, node.name)` over the gensym'd binding it minted
  // (`$mx_Icon1`, `lower.ts`'s Component branch), which the author never
  // wrote and which has no authored position. The emitter therefore has
  // nothing to anchor the selector to, and emits it unmapped rather than
  // pointing at a position the author cannot see. Giving a discovered call
  // the span of its *call site* is a core change (C4's writer half), not
  // something this host can do — see the report's open questions.
  it("emits the selector unmapped for a discovered tag, which carries no authored name span", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-angular-map-"));
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
    writeFileSync(join(dir, "tags", "icon.mx"), "<i>*</i>\n");
    const path = join(dir, "page.mx");
    const page = "<div><icon/></div>\n";
    writeFileSync(path, page);
    const result = compile(page, path, {
      customTags: getCustomTags(path) as never,
    });
    // The selector is emitted correctly; it simply carries no mapping.
    expect(result.code).toContain("<mx-icon>");
    expect(
      result.mappings.some(
        (mapping) =>
          result.code.slice(mapping.generatedStart, mapping.generatedEnd) ===
          "mx-icon",
      ),
    ).toBe(false);
  });

  it("maps an attribute name on a component call", () => {
    // The call's own attributes are authored text and do map, even though
    // the discovered selector above does not.
    const dir = mkdtempSync(join(tmpdir(), "mx-angular-map-"));
    mkdirSync(join(dir, "tags"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
    writeFileSync(join(dir, "tags", "icon.mx"), "<i>*</i>\n");
    const path = join(dir, "page.mx");
    const page = "<div><icon size=big/></div>\n";
    writeFileSync(path, page);
    const result = compile(page, path, {
      customTags: getCustomTags(path) as never,
    });
    const pairs = result.mappings.map((mapping) => ({
      generated: result.code.slice(
        mapping.generatedStart,
        mapping.generatedEnd,
      ),
      source: page.slice(mapping.sourceStart, mapping.sourceEnd),
    }));
    expect(pairs).toContainEqual({ generated: "size", source: "size" });
    expect(pairs).toContainEqual({ generated: "big", source: "big" });
  });

  it("maps a boolean attribute's name", () => {
    expectPair("<input disabled>", "disabled", "disabled");
  });

  it("maps a static attribute's name", () => {
    expectPair('<div id="main"/>', "id", "id");
  });
});

describe("mappings: escaping keeps the anchor", () => {
  it("maps an escaped expression whole-to-whole despite the length change", () => {
    // `&&` survives, but `"` in the expression is escaped to `&quot;` for the
    // surrounding HTML attribute, so generated and source lengths differ.
    const source = '<div title=a+"x"/>';
    const pairs = slicePairs(source);
    const pair = pairs.find((p) => p.source === 'a+"x"');
    expect(pair).toBeDefined();
    expect(pair?.generated).toBe("a+&quot;x&quot;");
    // The point of the rule: different lengths, still one whole-to-whole pair.
    expect(pair?.generated.length).not.toBe(pair?.source.length);
  });

  it("maps a `&` escaped in an attribute value", () => {
    const source = "<div title=a&&b/>";
    const pairs = slicePairs(source);
    expect(pairs).toContainEqual({ generated: "a&amp;&amp;b", source: "a&&b" });
  });
});

describe("sourceOffsetFor", () => {
  it("resolves an offset inside a mapped run to the source expression", () => {
    const source = "<div>${user.name}</div>";
    const result = compile(source, "x.mx");
    const at = result.code.indexOf("user.name");
    expect(sourceOffsetFor(result.mappings, at)).toBe(
      source.indexOf("user.name"),
    );
  });

  it("resolves an offset in the middle of a run to the run's start", () => {
    // The whole-to-whole rule: mid-expression resolves to the expression's
    // start, not to the matching character, because escaping means the two
    // sides do not advance in step.
    const source = "<div>${user.name}</div>";
    const result = compile(source, "x.mx");
    const at = result.code.indexOf("user.name") + 5;
    expect(sourceOffsetFor(result.mappings, at)).toBe(
      source.indexOf("user.name"),
    );
  });

  it("returns null for an offset in generated punctuation", () => {
    const source = "<div>${user.name}</div>";
    const result = compile(source, "x.mx");
    // Offset 0 is the `<` of `<div>`, which came from no mapped run.
    expect(sourceOffsetFor(result.mappings, 0)).toBeNull();
  });

  it("prefers the innermost mapping when spans nest", () => {
    // The attribute expression lies inside the element that contains it; the
    // narrower span is the more specific answer.
    const source = "<div title=user.name/>";
    const result = compile(source, "x.mx");
    const at = result.code.indexOf("user.name");
    expect(sourceOffsetFor(result.mappings, at)).toBe(
      source.indexOf("user.name"),
    );
  });
});

describe("line/column round trip", () => {
  it("converts an offset to line/column and back", () => {
    const text = "a\nbb\nccc";
    expect(lineColumnAt(text, 0)).toEqual({ line: 1, column: 0 });
    expect(lineColumnAt(text, 2)).toEqual({ line: 2, column: 0 });
    expect(lineColumnAt(text, 6)).toEqual({ line: 3, column: 1 });
    for (let i = 0; i <= text.length; i += 1) {
      expect(offsetAt(text, lineColumnAt(text, i))).toBe(i);
    }
  });

  it("resolves a multi-line template position back to the source line", () => {
    // The case `mx-angular map` reports: an expression on the third source
    // line has to come back as that line, not as the first.
    const source = "<div>\n  <p>x</p>\n  <p>${user.name}</p>\n</div>";
    const result = compile(source, "x.mx");
    const at = lineColumnAt(result.code, result.code.indexOf("user.name"));
    const resolved = resolveLineColumn(
      result.code,
      source,
      result.mappings,
      at,
    );
    expect(resolved).toEqual(lineColumnAt(source, source.indexOf("user.name")));
    expect(resolved?.line).toBe(3);
  });
});

describe("compileTagModule(): mappings rebased onto the module", () => {
  /** Compiles a tag file and slices every mapping out of the emitted module. */
  function modulePairs(
    tagSource: string,
  ): Array<{ generated: string; source: string }> {
    const dir = mkdtempSync(join(tmpdir(), "mx-angular-tagmap-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
    const path = join(dir, "badge.mx");
    writeFileSync(path, tagSource);
    const result = compileTagModule(tagSource, path);
    return result.mappings.map((mapping) => ({
      generated: result.code.slice(
        mapping.generatedStart,
        mapping.generatedEnd,
      ),
      source: tagSource.slice(mapping.sourceStart, mapping.sourceEnd),
    }));
  }

  it("slices to the source text through the quoted template literal", () => {
    // The offsets are module-relative, not template-relative: a mapping that
    // forgot to rebase past `template: "` would slice the wrong bytes here.
    const source =
      "export interface Input { label: string }\n<span>${input.label}</span>\n";
    expect(modulePairs(source)).toContainEqual({
      generated: "label",
      source: "input.label",
    });
  });

  it("maps an attribute expression inside a tag module", () => {
    const source =
      "export interface Input { title: string }\n<div title=input.title/>\n";
    const pairs = modulePairs(source);
    expect(pairs).toContainEqual({ generated: "title", source: "title" });
    expect(pairs).toContainEqual({ generated: "title", source: "input.title" });
  });
});

describe("compile(): the map itself", () => {
  it("returns a non-empty v3 mappings string, not the identity placeholder", () => {
    const result = compile("<div>${user.name}</div>", "x.mx");
    expect(result.map.version).toBe(3);
    expect(result.map.mappings.length).toBeGreaterThan(0);
    expect(result.mappings.length).toBeGreaterThan(0);
  });

  it("emits no mapping for a template with no source-derived names", () => {
    // Text only: nothing to point at, so an empty list is correct rather than
    // a mapping covering literal text.
    const result = compile("hello", "x.mx");
    expect(result.mappings).toEqual([]);
  });
});
