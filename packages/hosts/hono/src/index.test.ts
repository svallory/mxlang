import { type Child, createElement, jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { compileHonoMx, honoDeclarations, honoDialect } from "./index.ts";

function compile(source: string): string {
  return compileHonoMx(source, "/fixtures/test.mx").code;
}

it("keeps framework diagnostics separate from host capability diagnostics", () => {
  expect(honoDialect.name).toBe("Hono");
  expect(honoDeclarations.name).toBe("@mxlang/hono");
});

function markup(source: string): string {
  const match = compile(source).match(/return \(<>([\s\S]*)<\/>\);/);
  if (!match) throw new Error("compiled module has no JSX return body");
  return match[1] as string;
}

/** The message of the error a template throws, for an error-row assertion. */
function errorOf(source: string): string {
  try {
    compile(source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("Hono dialect", () => {
  it("uses Hono's JSX source and native DOM prop names", () => {
    const code = compile('<label class="field" for="name">Name</label>');
    expect(code).toContain("/** @jsxImportSource hono/jsx */");
    expect(code).toContain('<label class="field" for="name">Name</label>');
  });

  it("a type-only import does not resolve a capitalized tag (decision 114 parity, #151)", () => {
    // A type-only import binds no runtime value, so `<Widget/>` has nothing
    // to call -- the same rule `@mxlang/html`/`@mxlang/solid` already
    // enforce (`import type` excluded from `ctx.imports`).
    expect(
      errorOf('import type Widget from "./widget.mx"\n<Widget/>'),
    ).toContain("Unable to find entry point for custom tag `<Widget>`.");
  });

  it("tells an unresolved capitalized tag how to resolve it (shared emitter)", () => {
    expect(errorOf('<Card title="x"/>')).toContain(
      'Unable to find entry point for custom tag `<Card>`. Import it (`import Card from "./Card.mx"`) or add `tags/Card.mx`.',
    );
  });

  it.each([
    ["self-closing", "<TotallyUndefined/>"],
    ["with a body", "<TotallyUndefined>body</TotallyUndefined>"],
    ["with an attribute", "<TotallyUndefined a=1/>"],
  ])(
    "rejects a capitalized tag with no import, binding, or taglib entry, %s (decision 114 parity)",
    (_label, source) => {
      expect(errorOf(source)).toContain(
        "Unable to find entry point for custom tag `<TotallyUndefined>`.",
      );
    },
  );

  it("imports Hono's specialised AttrTag type", () => {
    expect(
      compile("export interface Input { head?: AttrTag }\n<p>x</p>"),
    ).toContain('import type { AttrTag } from "@mxlang/hono";');
  });

  it("renders a body-only fallback bare through the shared dynamic path", async () => {
    const { dirname, join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      "node:fs"
    );
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-attrtag-"));
    try {
      symlinkSync(
        dirname(dirname(dirname(require.resolve("hono")))),
        join(scratch, "node_modules"),
        "dir",
      );
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            jsxImportSource: "hono/jsx",
          },
        }),
      );
      const entry = join(scratch, "attrtag.tsx");
      writeFileSync(
        entry,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        compileHonoMx("<${input.tag}><@head>H</@head></>", entry).code,
      );
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: { tag: (props: { head: Child }) => Child }) => Child;
      };
      const output = await jsx(mod.default, {
        tag: (props: { head: Child }) =>
          createElement("section", null, props.head as never),
      }).toString();
      expect(output).toBe("<section>H</section>");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("renders a dynamic tag call with arguments, without crashing", async () => {
    const { dirname, join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      "node:fs"
    );
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-dyn-args-"));
    try {
      symlinkSync(
        dirname(dirname(dirname(require.resolve("hono")))),
        join(scratch, "node_modules"),
        "dir",
      );
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            jsxImportSource: "hono/jsx",
          },
        }),
      );
      const entry = join(scratch, "dyn-args.tsx");
      writeFileSync(
        entry,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        compileHonoMx('<${input.render}("x", 2)/>', entry).code,
      );
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: { render: (a: string, b: number) => Child }) => Child;
      };
      const output = await jsx(mod.default, {
        render: (a: string, b: number) =>
          createElement("b", null, `${a}-${b}` as never),
      }).toString();
      expect(output).toBe("<b>x-2</b>");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("renders a string dynamic-tag target as its element, even with arguments", async () => {
    // Marko's own html/dom runtimes never render a string renderer's name
    // as literal text, args or not — see `_dynamic_tag` in
    // `runtime-tags/src/html/dynamic-tag.ts`. args[0] ("x") becomes the
    // spread attributes source (decision 112): `for...in` over a string
    // yields its numeric indices, matching Marko's own `_attrs`.
    const { dirname, join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      "node:fs"
    );
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-dyn-args-str-"));
    try {
      symlinkSync(
        dirname(dirname(dirname(require.resolve("hono")))),
        join(scratch, "node_modules"),
        "dir",
      );
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            jsxImportSource: "hono/jsx",
          },
        }),
      );
      const entry = join(scratch, "dyn-args-str.tsx");
      writeFileSync(
        entry,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        compileHonoMx('<${input.tag}("x", 2)/>', entry).code,
      );
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: { tag: string }) => Child;
      };
      const output = await jsx(mod.default, { tag: "span" }).toString();
      expect(output).toBe('<span 0="x"></span>');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("uses Hono's raw HTML prop", () => {
    expect(markup("<div>$!{input.html}</div>")).toBe(
      "<div dangerouslySetInnerHTML={{ __html: input.html }} />",
    );
  });

  it("keeps structured class and style semantics", () => {
    const code = compile(
      "<div class={active: input.on} style={color: input.color}>x</div>",
    );
    // Sliced verbatim from source (no space after `{`), the same seam that
    // keeps TypeScript type arguments (see packages/core's core.ts and the
    // identical assertions in the Preact/React/Solid host tests).
    expect(code).toContain("class={__mxClass({active: input.on})}");
    expect(code).toContain("style={{color: input.color}}");
    expect(code).toContain(
      'import { mxClass as __mxClass } from "@mxlang/hono/runtime";',
    );
  });

  it("shares keyed list lowering with Preact/React", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      '<for|item| of=input.items by="id"><p>${item.name}</p></for>',
    );
    expect(code).toContain(
      'import { Fragment as __mxFragment } from "hono/jsx";',
    );
    expect(code).toContain("<__mxFragment key={item.id}>");
  });

  it("lowers `<try>` to Hono's built-in ErrorBoundary with fallbackRender", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      'import Risky from "./Risky.mx"\n<try><Risky/><@catch|error|><p>${error.message}</p></@catch></try>',
    );
    expect(code).toContain(
      'import { ErrorBoundary as __mxErrorBoundary } from "hono/jsx";',
    );
    expect(code).toContain(
      "<__mxErrorBoundary fallbackRender={(error) => <p>{error.message}</p>}>",
    );
  });

  it("wraps a param-less `<@catch>` fallback in a function for Hono", () => {
    const code = compile(
      'import Risky from "./Risky.mx"\n<try><Risky/><@catch><p>failed</p></@catch></try>',
    );
    expect(code).toContain(
      "<__mxErrorBoundary fallbackRender={() => <p>failed</p>}>",
    );
  });

  it("lowers `<@placeholder>` to Hono's native Suspense", () => {
    const code = compile(
      'import Risky from "./Risky.mx"\n<try><Risky/><@placeholder><p>loading</p></@placeholder></try>',
    );
    expect(code).toContain(
      'import { Suspense as __mxSuspense } from "hono/jsx";',
    );
    expect(code).toContain("<__mxSuspense fallback={<p>loading</p>}>");
  });

  it("rejects Marko state with Hono-specific guidance", () => {
    expect(() => compile("<let/count=0/>")).toThrow("Hono's `useState`");
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("recomposes the prop from the DOM event name", () => {
    expect(markup("<button onClick=handler>x</button>")).toBe(
      "<button onClick={handler}>x</button>",
    );
  });

  it("collapses onDblClick and on-dblclick byte-identically", () => {
    const a = markup("<button onDblClick=f>x</button>");
    const b = markup("<button on-dblclick=f>x</button>");
    expect(a).toBe("<button onDblclick={f}>x</button>");
    expect(a).toBe(b);
  });

  it("emits onChange for the change event and leaves hono's input alias to hono", () => {
    // Decision 101 (d): hono's runtime binds `onChange` to the `input` event
    // for React compatibility; MX emits the prop unchanged and documents the
    // divergence rather than papering over it.
    expect(markup("<input onChange=handler>")).toBe(
      "<input onChange={handler} />",
    );
  });

  it("rejects a custom DOM event name uniformly, pointing at a ref", () => {
    expect(() => compile("<div on-my-event=fn>x</div>")).toThrow(
      '`on-my-event` names a custom DOM event (`my-event`) a JSX prop cannot spell; use a `ref` to add a custom event listener (`ref={el => el?.addEventListener("my-event", fn)}`)',
    );
  });

  it("passes a static inline handler string through verbatim", () => {
    expect(markup('<button onClick="alert(1)">x</button>')).toBe(
      '<button onClick="alert(1)">x</button>',
    );
  });

  it("rejects on: with a fix-it naming on-<exact>", () => {
    expect(() => compile("<div on:click=fn>x</div>")).toThrow(
      "write `onClick=fn` for a DOM event or `on-click=fn` for a custom event name",
    );
  });
});

describe("event name plain-recomposition spellings", () => {
  it("recomposes multi-word DOM names with capitalize-first (onKeydown), unlike React", () => {
    expect(markup("<input onKeyDown=handler>")).toBe(
      "<input onKeydown={handler} />",
    );
  });
});

/**
 * Decision 116: a capitalized tag bound to a value import that is not a
 * `.marko`/`.mx` default import lowers as a dynamic tag — the routing
 * itself, exercised with an ordinary `import { X } from "./target.ts"` and
 * an ordinary `<X>`/`<X/>` call, compiled and rendered for real through
 * `hono/jsx`.
 */
describe("decision 116: value import used as a tag (hono)", () => {
  async function renderImportedTag(
    entrySource: string,
    targetSource: string,
  ): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname, basename } = await import("node:path");
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-decision116-"));
    try {
      // `hono/package.json` is not in the package's `exports` map, and Node
      // (unlike Bun) enforces that for `require.resolve` — resolve the bare
      // `hono` specifier instead and walk up from its entry file to the
      // `node_modules` directory that contains the `hono` package dir.
      let dir = dirname(require.resolve("hono"));
      while (basename(dir) !== "hono") dir = dirname(dir);
      const repoNodeModules = dirname(dir);
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" },
        }),
      );
      writeFileSync(join(scratch, "target.ts"), targetSource);
      const entryPath = join(scratch, "entry.mx");
      writeFileSync(entryPath, entrySource);
      const { compileHonoFile } = await import("./index.ts");
      const code = compileHonoFile(entryPath).code;
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: Record<string, unknown>) => unknown;
      };
      const element = jsx(mod.default, {});
      const html = element.toString();
      return typeof html === "string" ? html : await html;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("a string value import renders as a real element", async () => {
    const html = await renderImportedTag(
      'import { Tag } from "./target.ts"\n<Tag name="1">body</Tag>\n<Tag/>',
      'export const Tag = "div";',
    );
    expect(html).toBe('<div name="1">body</div><div></div>');
  });

  it("undefined renders only the tag's body content (Marko parity)", async () => {
    const html = await renderImportedTag(
      'import { Missing } from "./target.ts"\n<Missing name="1">body</Missing>',
      "export const Missing = undefined;",
    );
    expect(html).toBe("body");
  });

  it("null renders only the tag's body content (Marko parity)", async () => {
    const html = await renderImportedTag(
      'import { Nul } from "./target.ts"\n<Nul name="1">body</Nul>',
      "export const Nul = null;",
    );
    expect(html).toBe("body");
  });
});

/**
 * The local extension of decision 116 (firstmate's ruling under decision 116
 * in `notes/decisions-2026-09-10.md`): a non-import PascalCase local
 * (`static`, a `<const>`, a tag param) whose value core cannot statically
 * prove is a function/arrow/class also lowers as a dynamic tag; a plain
 * `function Foo(){}`/arrow-valued `static const`/`<const>` stays a direct
 * call, unchanged.
 */
describe("local-value-as-tag-parity: non-import local used as a tag (hono)", () => {
  async function renderLocalTag(entrySource: string): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname, basename } = await import("node:path");
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-local116-"));
    try {
      let dir = dirname(require.resolve("hono"));
      while (basename(dir) !== "hono") dir = dirname(dir);
      const repoNodeModules = dirname(dir);
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" },
        }),
      );
      const entryPath = join(scratch, "entry.mx");
      writeFileSync(entryPath, entrySource);
      const { compileHonoFile } = await import("./index.ts");
      const code = compileHonoFile(entryPath).code;
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: Record<string, unknown>) => unknown;
      };
      const element = jsx(mod.default, {});
      const html = element.toString();
      return typeof html === "string" ? html : await html;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("a static const string is unknown and renders as a real element", async () => {
    const html = await renderLocalTag(
      'static const Tag = "div";\n<Tag name="1">body</Tag>',
    );
    expect(html).toBe('<div name="1">body</div>');
  });

  it("a static arrow-function const stays a direct component call", async () => {
    const html = await renderLocalTag(
      "static const Comp = (props: { n: number }) => `<em>${props.n}</em>`;\n<Comp n=1/>",
    );
    expect(html).toContain("1");
  });

  it("a conditional string-or-component local is unknown and lowers as a dynamic tag", async () => {
    const html = await renderLocalTag(
      [
        'static function A() { return "<span>a</span>"; }',
        'static function B() { return "<span>b</span>"; }',
        "static const useA = true;",
        "static const Tag = useA ? A : B;",
        "<Tag/>",
      ].join("\n"),
    );
    expect(html).toBe("&lt;span&gt;a&lt;/span&gt;");
  });

  it("a <const> bound to a call result (unknown) lowers as a dynamic tag", async () => {
    const html = await renderLocalTag(
      [
        'static function make() { return "div"; }',
        "<const/Tag=make()/>",
        '<Tag name="1">body</Tag>',
      ].join("\n"),
    );
    expect(html).toBe('<div name="1">body</div>');
  });

  it("a tag param is always unknown and lowers as a dynamic tag", async () => {
    const html = await renderLocalTag(
      [
        'static const Tag = "div";',
        "<define/Wrapper|Row|>",
        "  <Row/>",
        "</define>",
        "<Wrapper(Tag)/>",
      ].join("\n"),
    );
    expect(html).toBe("<div></div>");
  });

  /**
   * Firstmate's follow-up on decision 116: hono/jsx's own `memo`/
   * `forwardRef` return real FUNCTIONS (measured, unlike React's own — see
   * `@mxlang/react`'s sibling suite), so `mxDynamic`'s pre-existing
   * `typeof target === "function"` branch already handled them, unaffected
   * by `mxIsHostComponentObject`.
   *
   * React's raw `memo(Foo)`/`forwardRef(...)` object does NOT work on this
   * host either, through `mxDynamic` or otherwise — measured directly:
   * `hono/jsx`'s own `jsx()` runtime has no object-based component dispatch
   * (only Preact's/hono's shared JSX-element machinery,
   * `typeof === "function"`), so a bare `<Comp/>` with `Comp` = React's
   * `memo` object renders a literal `<[object Object]>` tag whether or not
   * it passes through `mxDynamic` — the identical Preact-vs-React
   * incompatibility documented in `@mxlang/preact`'s suite, not a
   * decision-116 routing gap. `mxIsHostComponentObject`'s widened check in
   * the shared emitter is still correct: it is what makes React's own suite
   * pass, and is simply inert (never taken) on hono/preact, since neither
   * runtime can act on the result regardless.
   */
  it("hono/jsx's own memo(Foo) (a real function) already renders correctly", async () => {
    const html = await renderLocalTag(
      [
        'import { memo } from "hono/jsx";',
        "static function Foo(props: { n: number }) { return `<em>${props.n}</em>`; }",
        "static const Comp = memo(Foo);",
        "<Comp n=1/>",
      ].join("\n"),
    );
    expect(html).toContain("1");
  });
});

describe("hook-guard-module-list: each host's JsxDialect declares its own hookModules", () => {
  it("rejects a hook imported from hono/jsx in a unit that declares <return>", () => {
    // Hono declares only `["hono/jsx"]` on its own JsxDialect.hookModules.
    expect(() =>
      compileHonoMx(
        [
          'import { useState } from "hono/jsx"',
          "<p>x</p>",
          "<return value=1/>",
        ].join("\n"),
        "/fixtures/tags/hooky.mx",
      ),
    ).toThrow(/`useState` cannot be used in a tag that declares `<return>`/);
  });
});

/**
 * JSX-significant characters in authored text (the `jsx-text-lt-unescaped`
 * bug): the shared `@mxlang/preact` emitter this host reuses must escape
 * `<`, `>`, and braces so the *generated* TSX parses, and Hono's own
 * renderer must produce the DOM text Marko does (`a < b` is text in Marko;
 * the pre-fix emitter copied it verbatim into the JSX, which failed
 * downstream parsing with `[builtin:vite-transform] Unexpected token`).
 */
describe("text with JSX-significant characters (rendered, hono runtime)", () => {
  it("escapes `<` and `>` in emitted text", () => {
    expect(markup("<div>a < b</div>")).toBe("<div>a &#60; b</div>");
    expect(markup("<div>a > b</div>")).toBe("<div>a &#62; b</div>");
  });

  it("renders a bare `<` in text as text, like Marko", async () => {
    const { renderToString } = await import("hono/jsx/dom/server");
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-text-"));
    try {
      // Hono's exports table blocks `hono/package.json`, so resolve a real
      // subpath and walk up to the workspace `node_modules`.
      let nodeModules = dirname(require.resolve("hono/jsx"));
      while (!nodeModules.endsWith("node_modules")) {
        nodeModules = dirname(nodeModules);
      }
      symlinkSync(nodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono" },
        }),
      );
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, compileHonoMx("<div>a < b</div>", entry).code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: () => unknown;
      };
      expect(renderToString(jsx(mod.default, null))).toBe(
        "<div>a &lt; b</div>",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
