import { sep } from "node:path";
import { compile } from "@mxlang/html";
import { describe, expect, it } from "vitest";
import { isUnderPagesDir, wrapAsPage } from "./vite-pages.ts";

/**
 * `isUnderPagesDir` — the anchored-prefix check round-2 review Finding 2
 * asked for in place of a bare `path.includes(pagesRoot)` substring test.
 */
describe("isUnderPagesDir", () => {
  const pagesRoot = `/proj/src/pages${sep}`;

  it("matches a file directly under pagesRoot", () => {
    expect(isUnderPagesDir(`/proj/src/pages${sep}index.mx.ts`, pagesRoot)).toBe(
      true,
    );
  });

  it("matches a file in a nested pages subdirectory (dynamic routes)", () => {
    expect(
      isUnderPagesDir(
        `/proj/src/pages${sep}posts${sep}[slug].mx.ts`,
        pagesRoot,
      ),
    ).toBe(true);
  });

  it("does not match a component path outside src/pages", () => {
    expect(
      isUnderPagesDir(`/proj/src/components${sep}card.mx.ts`, pagesRoot),
    ).toBe(false);
  });

  it("does not match a sibling directory that only shares the pagesRoot substring", () => {
    // The bug a substring test would have: `pages-extra` contains `pages` as
    // a substring, and a directory anywhere on disk containing the full
    // `.../src/pages/` text (e.g. `/other-proj/src/pages/x`) must not match
    // a *different* project's `pagesRoot`.
    expect(
      isUnderPagesDir(`/proj/src/pages-extra${sep}x.mx.ts`, pagesRoot),
    ).toBe(false);
    expect(
      isUnderPagesDir(`/other-proj/src/pages${sep}x.mx.ts`, pagesRoot),
    ).toBe(false);
  });

  it("accepts a pagesRoot with or without a trailing separator", () => {
    const withoutTrailingSep = "/proj/src/pages";
    expect(
      isUnderPagesDir(`/proj/src/pages${sep}x.mx.ts`, withoutTrailingSep),
    ).toBe(true);
  });
});

/** Compiles an MX source string the way `@mxlang/vite-plugin` does for a page module. */
function compilePage(source: string): string {
  return compile(source, "page.mx").code;
}

describe("wrapAsPage", () => {
  it("returns null for code with no branded default export", () => {
    expect(wrapAsPage("export const x = 1;\n")).toBeNull();
  });

  it("renames the branded render function, not a helper that also takes input", () => {
    // The matcher anchors on the name the branded tail declares. Anchored on
    // "the first function taking `input`" instead — which is what dropping
    // the literal `render` left behind — this renames `helperOnInput` and
    // leaves the real render function untouched, so the page renders nothing.
    // A hoisted helper or a bundler-inlined tag unit puts such a function
    // above the render function for real.
    const code = [
      "function helperOnInput(input) { return input; }",
      "function About(input) { return helperOnInput(input); }",
      'Object.defineProperty(About, Symbol.for("mx.component"), { value: true });',
      "export default About;",
      "",
    ].join("\n");

    const wrapped = wrapAsPage(code);

    expect(wrapped).not.toBeNull();
    expect(wrapped).toContain("function __mxRenderPage(input) {");
    // The helper keeps its own name and its own body.
    expect(wrapped).toContain(
      "function helperOnInput(input) { return input; }",
    );
    expect(wrapped).not.toContain(
      "function __mxRenderPage(input) { return input; }",
    );
  });

  it("returns null when the brand and the default export name disagree", () => {
    // Both halves of the tail must name the same function. A module where
    // they differ is not `brandRender`'s output, and wrapping it would brand
    // one function while exporting another.
    const code = [
      'function About(input) { return ""; }',
      'Object.defineProperty(Other, Symbol.for("mx.component"), { value: true });',
      "export default Different;",
      "",
    ].join("\n");

    expect(wrapAsPage(code)).toBeNull();
  });

  it("wraps a no-layout page in createComponent, returning renderTemplate of unescapeHTML", () => {
    const compiled = compilePage("<h1>Hello</h1>\n");
    const wrapped = wrapAsPage(compiled);

    expect(wrapped).not.toBeNull();
    expect(wrapped).toContain(
      'import { createComponent, renderComponent, renderTemplate, unescapeHTML } from "astro/runtime/server/index.js";',
    );
    expect(wrapped).toContain(
      "export default createComponent((result, props, slots) => {",
    );
    expect(wrapped).toContain(
      "const astro = result.createAstro(props, slots);",
    );
    expect(wrapped).toContain("params: astro.params,");
    expect(wrapped).toContain("url: astro.url,");
    expect(wrapped).toContain(
      "renderTemplate`${unescapeHTML(__mxRenderPage(input))}`",
    );
    // The branded tail is gone: no leftover MX-component symbol or bare
    // `export default render;` line duplicating the page's own export default.
    expect(wrapped).not.toContain('Symbol.for("mx.component")');
    expect(wrapped).not.toContain("export default render;");
  });

  it("wraps a layout page with renderComponent, resolving the layout specifier relative to the page", () => {
    const compiled = compilePage(
      'export const layout = "../layouts/Base.astro";\n<h1>Hi</h1>\n',
    );
    const wrapped = wrapAsPage(compiled);

    expect(wrapped).not.toBeNull();
    // The layout export is stripped from module scope and turned into a real
    // import, keeping the exact specifier the author wrote (relative to the
    // page file, resolved by the bundler like any other import).
    expect(wrapped).not.toContain(
      'export const layout = "../layouts/Base.astro";',
    );
    expect(wrapped).toContain(
      'import __MxLayout from "../layouts/Base.astro";',
    );
    expect(wrapped).toContain(
      'renderComponent(result, "__MxLayout", __MxLayout, {',
    );
    expect(wrapped).toContain("default: () => unescapeHTML(html),");
    expect(wrapped).toContain(
      'renderTemplate`${renderComponent(result, "__MxLayout", __MxLayout,',
    );
  });

  it("passes every other top-level export through unchanged (getStaticPaths, prerender)", () => {
    const compiled = compilePage(
      'export const getStaticPaths = () => [{ params: { slug: "a" } }];\n' +
        "export const prerender = true;\n" +
        "<h1>${input.params.slug}</h1>\n",
    );
    const wrapped = wrapAsPage(compiled);

    expect(wrapped).not.toBeNull();
    expect(wrapped).toContain("export const getStaticPaths = ()");
    expect(wrapped).toContain("export const prerender = true;");
  });

  it("excludes getStaticPaths/prerender from the layout's frontmatter object", () => {
    const compiled = compilePage(
      'export const layout = "../layouts/Base.astro";\n' +
        'export const title = "A post";\n' +
        'export const getStaticPaths = () => [{ params: { slug: "a" } }];\n' +
        "export const prerender = true;\n" +
        "<h1>${title}</h1>\n",
    );
    const wrapped = wrapAsPage(compiled) as string;

    // `title` is genuine page content and belongs in frontmatter...
    expect(wrapped).toMatch(/const frontmatter = \{[^}]*\btitle\b[^}]*\};/);
    // ...`getStaticPaths`/`prerender` are Astro routing internals and must not.
    const frontmatterLine = wrapped
      .split("\n")
      .find((line) => line.includes("const frontmatter = {"));
    expect(frontmatterLine).toBeDefined();
    expect(frontmatterLine).not.toContain("getStaticPaths");
    expect(frontmatterLine).not.toContain("prerender");
  });

  it("emits an empty frontmatter object when the page declares no other exports", () => {
    const compiled = compilePage(
      'export const layout = "../layouts/Base.astro";\n<h1>Hi</h1>\n',
    );
    const wrapped = wrapAsPage(compiled) as string;

    expect(wrapped).toContain("const frontmatter = {};");
  });
});

import { mxPages } from "./vite-pages.ts";

describe("mxPages plugin", () => {
  it("matches .mx files with a .tsx virtual suffix", () => {
    const plugin = mxPages(new URL("file:///proj/src/"));
    // biome-ignore lint/suspicious/noExplicitAny: testing untyped plugin return
    const transform = plugin.transform as (code: string, id: string) => any;

    // An id matching the bug condition: under pages root, ending in .mx.tsx
    const id = "/proj/src/pages/posts/slug.mx.tsx";

    const validCode = `function render(input) {}
Object.defineProperty(render, Symbol.for("mx.component"), { value: true });
export default render;
`;
    // If the regex fix is working, it doesn't return null early.
    // Instead it wraps the code and returns { code: ... }.
    const result = transform.call({}, validCode, id);
    expect(result).not.toBeNull();
    expect(result.code).toContain("__mxRenderPage");
  });

  it("declines .marko.tsx", () => {
    // MX only supports the MX 1.0 subset of Marko syntax, so a real .marko
    // file is never treated as a page here, even under src/pages and even
    // with a .tsx virtual suffix that would otherwise pass every other
    // check. Regression for a regex that used to accept
    // /\.(?:mx|marko)\.tsx?$/ — a caller-supplied `extensions: [".marko"]`
    // on `mx()`/the Astro integration would have resurrected the .marko
    // page path despite neither loader claiming that extension any more.
    const plugin = mxPages(new URL("file:///proj/src/"));
    // biome-ignore lint/suspicious/noExplicitAny: testing untyped plugin return
    const transform = plugin.transform as (code: string, id: string) => any;

    const id = "/proj/src/pages/posts/slug.marko.tsx";
    const validCode = `function render(input) {}
Object.defineProperty(render, Symbol.for("mx.component"), { value: true });
export default render;
`;

    const result = transform.call({}, validCode, id);
    expect(result).toBeNull();
  });
});
