import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileReactMx, reactDeclarations, reactDialect } from "./index.ts";

function compile(source: string): string {
  return compileReactMx(source, "/fixtures/test.mx").code;
}

it("keeps framework diagnostics separate from host capability diagnostics", () => {
  expect(reactDialect.name).toBe("React");
  expect(reactDeclarations.name).toBe("@mxlang/react");
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

describe("React dialect", () => {
  it("uses React's JSX source and DOM prop names", () => {
    const code = compile('<label class="field" for="name">Name</label>');
    expect(code).toContain("/** @jsxImportSource react */");
    expect(code).toContain(
      '<label className="field" htmlFor="name">Name</label>',
    );
  });

  it("a type-only import does not resolve a capitalized tag (decision 114 parity, #151)", () => {
    // A type-only import binds no runtime value, so `<Widget/>` has nothing
    // to call -- the same rule `@mxlang/html`/`@mxlang/solid` already
    // enforce (`import type` excluded from `ctx.imports`).
    expect(
      errorOf('import type Widget from "./widget.mx"\n<Widget/>'),
    ).toContain("Unable to find entry point for custom tag `<Widget>`.");
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

  it("imports React's specialised AttrTag type", () => {
    expect(
      compile("export interface Input { head?: AttrTag }\n<p>x</p>"),
    ).toContain('import type { AttrTag } from "@mxlang/react";');
  });

  it("renders a body-only fallback bare through the shared dynamic path", async () => {
    const { dirname, join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      "node:fs"
    );
    const scratch = mkdtempSync(join(tmpdir(), "mx-react-attrtag-"));
    try {
      symlinkSync(
        dirname(dirname(require.resolve("react/package.json"))),
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
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
        }),
      );
      const entry = join(scratch, "attrtag.tsx");
      writeFileSync(
        entry,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        compileReactMx("<${input.tag}><@head>H</@head></>", entry).code,
      );
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: {
          tag: (props: { head: ReactNode }) => ReactNode;
        }) => ReactNode;
      };
      const html = renderToStaticMarkup(
        createElement(mod.default, {
          tag: (props) => createElement("section", null, props.head),
        }),
      );
      expect(html).toBe("<section>H</section>");
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
    const scratch = mkdtempSync(join(tmpdir(), "mx-react-dyn-args-"));
    try {
      symlinkSync(
        dirname(dirname(require.resolve("react/package.json"))),
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
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
        }),
      );
      const entry = join(scratch, "dyn-args.tsx");
      writeFileSync(
        entry,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        compileReactMx('<${input.render}("x", 2)/>', entry).code,
      );
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: {
          render: (a: string, b: number) => ReactNode;
        }) => ReactNode;
      };
      const html = renderToStaticMarkup(
        createElement(mod.default, {
          render: (a: string, b: number) =>
            createElement("b", null, `${a}-${b}`),
        }),
      );
      expect(html).toBe("<b>x-2</b>");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("renders a string dynamic-tag target as its element, even with arguments", async () => {
    // Marko's own html/dom runtimes never render a string renderer's name
    // as literal text, args or not — see `_dynamic_tag` in
    // `runtime-tags/src/html/dynamic-tag.ts`. args[0] ("x") becomes the
    // spread attributes source (decision 112): `for...in` over a string
    // yields its numeric indices, matching Marko's own `_attrs`. React's own
    // renderer (unlike Preact/Hono) rejects a numeric attribute name
    // ("Invalid attribute name: `0`") and drops it, so no attribute renders
    // here — a React runtime quirk this host has no reason to work around.
    const { dirname, join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      "node:fs"
    );
    const scratch = mkdtempSync(join(tmpdir(), "mx-react-dyn-args-str-"));
    try {
      symlinkSync(
        dirname(dirname(require.resolve("react/package.json"))),
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
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
        }),
      );
      const entry = join(scratch, "dyn-args-str.tsx");
      writeFileSync(
        entry,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
        compileReactMx('<${input.tag}("x", 2)/>', entry).code,
      );
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: { tag: string }) => ReactNode;
      };
      const html = renderToStaticMarkup(
        createElement(mod.default, { tag: "span" }),
      );
      expect(html).toBe("<span></span>");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("uses React DOM's raw HTML prop", () => {
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
    // identical assertions in the Preact and Solid host tests).
    expect(code).toContain("className={mxClass({active: input.on})}");
    expect(code).toContain("style={{color: input.color}}");
    expect(code).toContain('import { mxClass } from "@mxlang/react/runtime";');
  });

  it("shares keyed list lowering with Preact", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      '<for|item| of=input.items by="id"><p>${item.name}</p></for>',
    );
    expect(code).toContain('import { Fragment } from "react";');
    expect(code).toContain("<Fragment key={item.id}>");
  });

  it("imports React's boundary runtime for `<try>`", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      'import Risky from "./Risky.mx"\n<try><Risky/><@catch|error|><p>${error.message}</p></@catch></try>',
    );
    expect(code).toContain(
      'import { MxErrorBoundary } from "@mxlang/react/runtime";',
    );
    expect(code).toContain(
      "<MxErrorBoundary fallback={(error) => <p>{error.message}</p>}>",
    );
  });

  it("rejects Marko state with React-specific guidance", () => {
    expect(() => compile("<let/count=0/>")).toThrow("React's `useState`");
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("recomposes the prop from the DOM event name", () => {
    expect(markup("<button onClick=handler>x</button>")).toBe(
      "<button onClick={handler}>x</button>",
    );
  });

  it("uses React's own irregular spellings", () => {
    // react-dom's registration table (measured): `dblclick` → `onDoubleClick`,
    // `focusin` → `onFocus`, `focusout` → `onBlur`; every other DOM name is
    // the plain `on` + capitalized form.
    expect(markup("<button onDblClick=f>x</button>")).toBe(
      "<button onDoubleClick={f}>x</button>",
    );
    expect(markup("<button on-dblclick=g>y</button>")).toBe(
      "<button onDoubleClick={g}>y</button>",
    );
    expect(markup("<input onFocusIn=h>")).toBe("<input onFocus={h} />");
    expect(markup("<input on-focusout=i>")).toBe("<input onBlur={i} />");
  });

  it("emits onDoubleClick as onDoubleclick plus core's warning, never a rewrite", () => {
    // No aliases (decision 101 (c)): the authored `onDoubleClick` lowercases
    // to `doubleclick`, which React would silently drop; core warns and the
    // prop is recomposed exactly as written. The warning is pinned in the
    // core's lower tests.
    expect(markup("<button onDoubleClick=handler>x</button>")).toBe(
      "<button onDoubleclick={handler}>x</button>",
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

/**
 * The local extension of decision 116 (firstmate's ruling under decision 116
 * in `notes/decisions-2026-09-10.md`): a non-import PascalCase local
 * (`static`, a `<const>`, a tag param) whose value core cannot statically
 * prove is a function/arrow/class also lowers as a dynamic tag; a plain
 * `function Foo(){}`/arrow-valued `static const`/`<const>` stays a direct
 * call, unchanged. Executed through `react-dom/server`, not asserted only as
 * emitted source text — the shared emitter is already covered by
 * `@mxlang/preact`'s own executed suite, but React's own runtime (real
 * `react`/`react-dom`) is exercised here too, per the brief.
 */
describe("local-value-as-tag-parity: non-import local used as a tag (react)", () => {
  async function renderLocalTag(entrySource: string): Promise<string> {
    const { dirname, join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      "node:fs"
    );
    const scratch = mkdtempSync(join(tmpdir(), "mx-react-local116-"));
    try {
      symlinkSync(
        dirname(dirname(require.resolve("react/package.json"))),
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
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
        }),
      );
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, compileReactMx(entrySource, entry).code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: Record<string, unknown>) => ReactNode;
      };
      return renderToStaticMarkup(createElement(mod.default, {}));
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
});

/**
 * Firstmate's follow-up on decision 116: React's own `memo`/`forwardRef`
 * return plain OBJECTS (`{ $$typeof, ... }`), not functions — unlike
 * preact/compat's and hono's own `memo`/`forwardRef`, both real functions
 * (measured, see the sibling describe block below). A `memo(Foo)`/
 * `forwardRef(...)` result is "unknown" under decision 116's own
 * classification (a `CallExpression`, never statically function-like), so
 * it always routes dynamic — through `mxDynamic`, which before this fix had
 * no branch recognizing a `$$typeof`-carrying object as a component: it fell
 * through to the final `return props.content ? props.content() : target;`
 * line and handed the bare object back as a JSX child, which React rejects
 * ("Objects are not valid as a React child"). Reachable both as a local
 * (`static const Comp = memo(Foo)`) and, since #155, as a value import
 * (`import Card from "./Card.tsx"` where `Card` is `export default
 * memo(Foo)`).
 */
describe("local-value-as-tag-parity: React's memo()/forwardRef() objects on the dynamic path (react)", () => {
  async function renderWithReact(
    entrySource: string,
    targetSource?: string,
  ): Promise<string> {
    const { dirname, join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import(
      "node:fs"
    );
    const scratch = mkdtempSync(join(tmpdir(), "mx-react-memo116-"));
    try {
      symlinkSync(
        dirname(dirname(require.resolve("react/package.json"))),
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
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
        }),
      );
      if (targetSource)
        writeFileSync(join(scratch, "target.tsx"), targetSource);
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, compileReactMx(entrySource, entry).code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: (props: Record<string, unknown>) => ReactNode;
      };
      return renderToStaticMarkup(createElement(mod.default, {}));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("a local static const bound to memo(Foo) renders the wrapped component", async () => {
    // `static` is a plain-JS block (Marko's own grammar, not JSX), so the
    // wrapped function is written with `createElement` rather than JSX
    // syntax, which would collide with Marko's own tag grammar there.
    const html = await renderWithReact(
      [
        'import { createElement, memo } from "react";',
        'static function Foo(props: { n: number }) { return createElement("em", null, props.n); }',
        "static const Comp = memo(Foo);",
        "<Comp n=1/>",
      ].join("\n"),
    );
    expect(html).toBe("<em>1</em>");
  });

  it("a local static const bound to forwardRef(...) renders the wrapped component", async () => {
    const html = await renderWithReact(
      [
        'import { createElement, forwardRef } from "react";',
        'static const Comp = forwardRef((props: { n: number }, _ref) => createElement("em", null, props.n));',
        "<Comp n=1/>",
      ].join("\n"),
    );
    expect(html).toBe("<em>1</em>");
  });

  it("a .tsx value import whose default export is memo(Foo) renders the wrapped component", async () => {
    const html = await renderWithReact(
      'import Comp from "./target.tsx"\n<Comp n=1/>',
      [
        'import { memo } from "react";',
        "function Foo(props: { n: number }) {",
        "  return <em>{props.n}</em>;",
        "}",
        "export default memo(Foo);",
      ].join("\n"),
    );
    expect(html).toBe("<em>1</em>");
  });

  it("a .tsx value import whose default export is forwardRef(...) renders the wrapped component", async () => {
    const html = await renderWithReact(
      'import Comp from "./target.tsx"\n<Comp n=1/>',
      [
        'import { forwardRef } from "react";',
        "export default forwardRef((props: { n: number }, _ref) => <em>{props.n}</em>);",
      ].join("\n"),
    );
    expect(html).toBe("<em>1</em>");
  });
});

describe("hook-guard-module-list: each host's JsxDialect declares its own hookModules", () => {
  it("rejects a hook imported from react in a unit that declares <return>", () => {
    // React declares only `["react"]` on its own JsxDialect.hookModules — unlike
    // Preact, which also guards `react` because `preact/compat` aliases it.
    expect(() =>
      compileReactMx(
        [
          'import { useState } from "react"',
          "<p>x</p>",
          "<return value=1/>",
        ].join("\n"),
        "/fixtures/tags/hooky.mx",
      ),
    ).toThrow(/`useState` cannot be used in a tag that declares `<return>`/);
  });
});
