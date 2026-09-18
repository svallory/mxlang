import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

function compile(source: string): string {
  return compileHonoMx(source, "/fixtures/test.mx").code;
}

function markup(source: string): string {
  const match = compile(source).match(/return \(<>([\s\S]*)<\/>\);/);
  if (!match) throw new Error("compiled module has no JSX return body");
  return match[1] as string;
}

describe("Hono target", () => {
  it("uses Hono's JSX source and native DOM prop names", () => {
    const code = compile('<label class="field" for="name">Name</label>');
    expect(code).toContain("/** @jsxImportSource hono/jsx */");
    expect(code).toContain('<label class="field" for="name">Name</label>');
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
    expect(code).toContain("class={mxClass({active: input.on})}");
    expect(code).toContain("style={{color: input.color}}");
    expect(code).toContain('import { mxClass } from "@mxlang/hono/runtime";');
  });

  it("shares keyed list lowering with Preact/React", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      '<for|item| of=input.items by="id"><p>${item.name}</p></for>',
    );
    expect(code).toContain('import { Fragment } from "hono/jsx";');
    expect(code).toContain("<Fragment key={item.id}>");
  });

  it("lowers `<try>` to Hono's built-in ErrorBoundary with fallbackRender", () => {
    const code = compile(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      'import Risky from "./Risky.mx"\n<try><Risky/><@catch|error|><p>${error.message}</p></@catch></try>',
    );
    expect(code).toContain('import { ErrorBoundary } from "hono/jsx";');
    expect(code).toContain(
      "<ErrorBoundary fallbackRender={(error) => <p>{error.message}</p>}>",
    );
  });

  it("wraps a param-less `<@catch>` fallback in a function for Hono", () => {
    const code = compile(
      'import Risky from "./Risky.mx"\n<try><Risky/><@catch><p>failed</p></@catch></try>',
    );
    expect(code).toContain(
      "<ErrorBoundary fallbackRender={() => <p>failed</p>}>",
    );
  });

  it("lowers `<@placeholder>` to Hono's native Suspense", () => {
    const code = compile(
      'import Risky from "./Risky.mx"\n<try><Risky/><@placeholder><p>loading</p></@placeholder></try>',
    );
    expect(code).toContain('import { Suspense } from "hono/jsx";');
    expect(code).toContain("<Suspense fallback={<p>loading</p>}>");
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
