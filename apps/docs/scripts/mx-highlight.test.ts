/**
 * The docs' MX highlighter: the tree-sitter grammar, run at build time.
 *
 * What these pin: the capture -> class map on the shorthand forms the grammar
 * was extended for; that the landing page's example and an ordinary ```mx
 * fence render the same spans (they share `renderMx`, and this keeps it so);
 * that every ```mx fence on the site parses clean and round-trips; that the
 * docmd plugin hooks in once and only for `mx`; and that the marker node
 * assertions actually fail when a range drifts off its construct.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import plugin, {
  captureNames,
  classOf,
  parseMx,
  renderFence,
  renderMx,
  spansOf,
} from "@mxlang/tree-sitter-mx/docmd";
import { describe, expect, it } from "vitest";
import {
  docsRoot,
  highlightExample,
  type Marker,
  readExample,
  readMarkers,
  siteRoot,
  validateNodes,
} from "./home-example.ts";

/** Every span of `html` as `[class, text]`, outermost spans only. */
function spans(html: string): Array<[string, string]> {
  return [...html.matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)].map(
    (match) => [match[1] as string, unescapeHtml(match[2] as string)],
  );
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** The text of `html` with every tag removed. */
function textOf(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, ""));
}

/**
 * Re-join neighbouring spans of one class. A marker that ends inside a token
 * has to cut it in two; this is the inverse, so a cut span and the uncut
 * original compare equal.
 */
function mergeSpans(html: string): string {
  let merged = html;
  for (;;) {
    const next = merged.replace(
      /<span class="([^"]+)">([^<]*)<\/span><span class="\1">/g,
      '<span class="$1">$2',
    );
    if (next === merged) return merged;
    merged = next;
  }
}

/** Drop the `.mk` marker wrappers, keeping the capture spans inside them. */
function stripMarkers(html: string): string {
  const stack: boolean[] = [];
  return html.replace(/<span[^>]*>|<\/span>/g, (tag) => {
    if (tag === "</span>") return stack.pop() ? "" : tag;
    const isMarker = tag.startsWith('<span class="mk"');
    stack.push(isMarker);
    return isMarker ? "" : tag;
  });
}

function mxFences(): Array<{ file: string; line: number; source: string }> {
  const found: Array<{ file: string; line: number; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".md")) {
        const lines = readFileSync(path, "utf8").split("\n");
        for (let at = 0; at < lines.length; at++) {
          if (!/^\s*```mx\b/.test(lines[at] as string)) continue;
          let end = at + 1;
          while (
            end < lines.length &&
            !/^\s*```\s*$/.test(lines[end] as string)
          )
            end++;
          found.push({
            file: path.slice(docsRoot.length + 1),
            line: at + 1,
            source: lines.slice(at + 1, end).join("\n"),
          });
          at = end;
        }
      }
    }
  };
  walk(join(docsRoot, "docs"));
  return found;
}

describe("the capture classes", () => {
  it("colours every part of a shorthand tag", () => {
    const html = renderMx('<a.c:b x="1" #d .e :f>');
    expect(spans(html)).toEqual([
      ["ts-punctuation-bracket", "<"],
      ["ts-tag", "a"],
      ["ts-property", ".c"],
      ["ts-label", ":b"],
      ["ts-attribute", "x"],
      // highlights.scm captures the `=` as an operator.
      ["ts-operator", "="],
      // The attribute value is an `attr_value_expr`, which injections.scm
      // hands to TypeScript; its own query says string.
      ["ts-string", '"1"'],
      ["ts-constant", "#d"],
      ["ts-property", ".e"],
      ["ts-label", ":f"],
      ["ts-punctuation-bracket", ">"],
    ]);
  });

  it("colours the same shorthand in concise mode", () => {
    const html = renderMx("a.c:b#d\n");
    expect(spans(html)).toEqual([
      ["ts-tag", "a"],
      ["ts-property", ".c"],
      ["ts-label", ":b"],
      ["ts-constant", "#d"],
    ]);
  });

  it("maps every capture name the query can produce to a class", () => {
    for (const name of captureNames) {
      const cls = classOf(name);
      if (name === "none" || name === "embedded") expect(cls).toBeNull();
      else expect(cls, name).toMatch(/^ts-[a-z]+(-[a-z]+)?$/);
    }
    expect(classOf("punctuation.bracket")).toBe("ts-punctuation-bracket");
  });

  it("styles every class it can emit", () => {
    const css = readFileSync(join(docsRoot, "assets/css/home.css"), "utf8");
    for (const name of captureNames) {
      const cls = classOf(name);
      if (cls) expect(css, cls).toMatch(new RegExp(`\\.${cls}[ ,{]`));
    }
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("round-trips: the spans rebuild the source exactly", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    const source = '<if=a < b>\n  ${"<&>"}\n</if>\n// c\n';
    expect(
      spansOf(source)
        .map((span) => span.text)
        .join(""),
    ).toBe(source);
    expect(textOf(renderMx(source))).toBe(source);
  });

  it("keeps non-BMP text aligned with the tree's offsets", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    const source = "<p>😀 ${x}</p>";
    expect(textOf(renderMx(source))).toBe(source);
    expect(renderMx(source)).toContain('<span class="ts-tag">p</span>');
  });
});

describe("injected TypeScript", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  const source = "<p>Hi ${user.name.toUpperCase()}</p>";

  it("colours a placeholder's expression with the TypeScript query", () => {
    expect(spans(renderMx(source))).toEqual([
      ["ts-punctuation-bracket", "<"],
      ["ts-tag", "p"],
      ["ts-punctuation-bracket", ">"],
      ["ts-punctuation-special", "${"],
      ["ts-variable", "user"],
      ["ts-punctuation-delimiter", "."],
      ["ts-property", "name"],
      ["ts-punctuation-delimiter", "."],
      ["ts-function-method", "toUpperCase"],
      ["ts-punctuation-bracket", "()"],
      ["ts-punctuation-special", "}"],
      ["ts-punctuation-bracket", "</"],
      ["ts-tag", "p"],
      ["ts-punctuation-bracket", ">"],
    ]);
  });

  it("colours types, which a bare JavaScript grammar cannot parse", () => {
    const html = renderMx("export interface Input { title: string }");
    expect(html).toContain('<span class="ts-keyword">interface</span>');
    expect(html).toContain('<span class="ts-type-builtin">string</span>');
  });

  it("colours a static body and an attribute value", () => {
    expect(renderMx("static const LIMIT = 3;")).toContain(
      '<span class="ts-number">3</span>',
    );
    expect(renderMx("<p class=cls count=3>x</p>")).toContain(
      '<span class="ts-number">3</span>',
    );
  });

  it("keeps a parameter a parameter, not the catch-all variable", () => {
    const html = renderMx("<for|item| of=items>x</for>");
    expect(html).toContain('<span class="ts-variable-parameter">item</span>');
    expect(html).toContain('<span class="ts-variable">items</span>');
  });

  it("leaves text and structure alone: the spans still rebuild the source", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    const mixed =
      "static const A = 1;\n<div class=x onClick=() => n++>${a?.b ?? 2}</div>\n";
    expect(textOf(renderMx(mixed))).toBe(mixed);
  });
});

describe("the landing example and an ordinary fence", () => {
  const { source } = readExample();
  const text = source.replace(/\n$/, "");

  it("render byte-identical spans for the same text", () => {
    const landing = highlightExample(source, readMarkers());
    const inner = landing.replace(
      /^<pre[^>]*><code[^>]*>|<\/code><\/pre>$/g,
      "",
    );
    // A marker that ends inside a token cuts it in two; merged back, the
    // spans are the plain fence's.
    expect(mergeSpans(stripMarkers(inner))).toBe(renderMx(text));
    expect(highlightExample(source, [])).toBe(
      renderFence(source).replace(
        '<pre class="hljs mx-hl">',
        '<pre class="hljs mx-hl" tabindex="0">',
      ),
    );
  });

  it("wraps each marker around whole, well-nested spans", () => {
    const landing = highlightExample(source, readMarkers());
    let depth = 0;
    for (const tag of landing.match(/<span[^>]*>|<\/span>/g) ?? []) {
      depth += tag === "</span>" ? -1 : 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(textOf(landing)).toBe(text);
  });

  it("splits a token a marker ends inside", () => {
    const html = renderMx("<a.b>", (at) => (at < 3 ? '<span class="mk">' : ""));
    // `.b` is one `ts-property` capture [2,4): the marker cuts it at 3.
    expect(stripMarkers(html)).toBe(
      '<span class="ts-punctuation-bracket">&lt;</span><span class="ts-tag">a</span><span class="ts-property">.</span><span class="ts-property">b</span><span class="ts-punctuation-bracket">&gt;</span>',
    );
  });
});

describe("every ```mx fence in the docs", () => {
  const fences = mxFences();

  it("finds the fences", () => {
    expect(fences.length).toBeGreaterThanOrEqual(46);
  });

  it.each(fences.map((fence) => [`${fence.file}:${fence.line}`, fence]))(
    "%s parses clean and round-trips",
    (_, fence) => {
      const { source } = fence as { source: string };
      expect(parseMx(source).rootNode.hasError).toBe(false);
      expect(textOf(renderMx(source))).toBe(source);
    },
  );

  it.skipIf(!existsSync(siteRoot))(
    "are rendered by the grammar in the built site, not by lite-hl",
    () => {
      let rendered = 0;
      for (const page of new Set(fences.map((fence) => fence.file))) {
        const route = page
          .replace(/^docs\//, "")
          .replace(/\.md$/, "")
          .replace(/(^|\/)index$/, "");
        const file = join(siteRoot, route, "index.html");
        expect(existsSync(file), `${page} is not in the built site`).toBe(true);
        const built = readFileSync(file, "utf8");
        const blocks = [
          ...built.matchAll(
            /<pre class="hljs mx-hl"><code class="language-mx">([\s\S]*?)<\/code><\/pre>/g,
          ),
        ];
        expect(blocks.length, page).toBe(
          fences.filter((fence) => fence.file === page).length,
        );
        for (const block of blocks) {
          expect(block[1], page).not.toMatch(/hljs-/);
          rendered++;
        }
      }
      expect(rendered).toBeGreaterThanOrEqual(46);
    },
  );
});

describe("the docmd plugin", () => {
  const original = (code: string, lang: string) => `original:${lang}:${code}`;

  it("declares the markdown capability in its descriptor", () => {
    expect(plugin.plugin.capabilities).toEqual(["markdown"]);
  });

  it("claims mx only, and does not stack when docmd calls it twice", () => {
    const md = {
      options: { highlight: original } as {
        highlight: (code: string, lang: string) => string;
      },
    };
    plugin.markdownSetup(md);
    plugin.markdownSetup(md);
    expect(md.options.highlight("<p/>", "mx")).toMatch(
      /^<pre class="hljs mx-hl">/,
    );
    expect(md.options.highlight("x", "ts")).toBe("original:ts:x");
    expect(md.options.highlight("x", "marko")).toBe("original:marko:x");
  });
});

describe("the marker node assertions", () => {
  const { source } = readExample();
  const markers = readMarkers();

  it("hold for every marker", () => {
    expect(validateNodes(source, markers)).toEqual([]);
  });

  it("require node, startsIn and endsIn on every marker", () => {
    const bare = markers.map(
      ({ node: _n, startsIn: _s, endsIn: _e, ...rest }) => rest,
    );
    const errors = validateNodes(source, bare as unknown as Marker[]);
    expect(errors).toHaveLength(markers.length);
    expect(errors[0]).toContain("needs `node`, `startsIn` and `endsIn`");
  });

  it("fail when a range drifts off its construct", () => {
    // Shift `escaped` one column right: the region starts mid-token.
    const target = markers.find(
      (marker) => marker.id === "boolean-attr",
    ) as Marker;
    const drifted = markers.map((marker) =>
      marker === target
        ? {
            ...marker,
            ranges: marker.ranges.map((range) => ({
              ...range,
              to: range.to + 1,
            })),
          }
        : marker,
    );
    const errors = validateNodes(source, drifted);
    expect(errors.some((error) => error.includes("boolean-attr"))).toBe(true);
  });

  it("fail when an exact marker is no longer exact, and when a loose one becomes exact", () => {
    const exact = markers.find((marker) => marker.exact) as Marker;
    const loose = markers.find((marker) => !marker.exact) as Marker;
    const errors = validateNodes(source, [
      { ...exact, exact: false },
      { ...loose, exact: true },
    ]);
    expect(errors.join("\n")).toContain(`marker \`${exact.id}\` equals its`);
    expect(errors.join("\n")).toContain(
      `marker \`${loose.id}\` is declared exact`,
    );
  });
});
