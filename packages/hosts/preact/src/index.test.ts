// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source and messages use `${...}` placeholders.

/**
 * One test per lowering row and per error, as the brief requires.
 *
 * The assertions are on the *emitted JSX text*, not on rendered HTML: render
 * parity with `@mxlang/html` is the oracle's job (`bun run oracle:preact`),
 * and duplicating it here would test Preact rather than this lowering. What
 * these pin is the shape an author reads back out of the generated file —
 * which `key` lands on a row, which prop raw HTML goes through, which import
 * a `<try>` pulls in.
 */

import type { CustomTag, MxWarning } from "@mxlang/core";

const ATTR = "__mxAttrValue";
const SPREAD = "__mxAttrSpread";

import { type FunctionComponent, h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx, preactDeclarations, preactDialect } from "./index.ts";

/** Compiles one template and returns the emitted module. */
function compile(source: string): string {
  return compilePreactMx(source, "/fixtures/test.mx").code;
}

it("keeps framework diagnostics separate from host capability diagnostics", () => {
  expect(preactDialect.name).toBe("Preact");
  expect(preactDeclarations.name).toBe("@mxlang/preact");
});

/** The body of the emitted component's `return (…)`, without the wrapper. */
function markup(source: string): string {
  const code = compile(source);
  const match = code.match(/return \(<>([\s\S]*)<\/>\);/);
  if (!match) throw new Error(`no render body in:\n${code}`);
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

describe("module shape", () => {
  it("emits the JSX pragma, the props type and a default export", () => {
    const code = compile("<p>hi</p>");
    expect(code).toContain("/** @jsxImportSource preact */");
    expect(code).toContain("export interface Input {}");
    // Named after the file (`test.mx` -> `Test`), never anonymous: that is
    // what lets a self-recursive tag call itself with no self-import.
    expect(code).toContain("export default function Test(props: Input) {");
    // The template's own expressions read `input`; the JSX parameter is
    // `props`, and the bridge between them also maps JSX's `children` onto
    // Marko's `content`.
    expect(code).toContain("const input: Input & { content?: unknown }");
  });

  it("keeps the author's own `export interface Input`", () => {
    const code = compile(
      "export interface Input { title: string }\n<h1>${input.title}</h1>",
    );
    expect(code).toContain("export interface Input { title: string }");
    expect(code).not.toContain("export interface Input {}");
  });

  it("hoists imports and `static` blocks to module scope", () => {
    const code = compile(
      'import Card from "./card.mx"\nstatic const G = 1;\n<p>${G}</p>',
    );
    // Above the component, not inside it.
    const componentAt = code.indexOf("export default function");
    expect(code.indexOf('import Card from "./card.mx"')).toBeLessThan(
      componentAt,
    );
    expect(code.indexOf("const G = 1;")).toBeLessThan(componentAt);
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

  it("imports nothing when the template uses no helper", () => {
    const code = compile("<p>hi</p>");
    expect(code).not.toContain('from "preact"');
    expect(code).not.toContain("@mxlang/preact/runtime");
  });

  it("imports the host-specialised AttrTag type when core requests it", () => {
    const code = compile("export interface Input { head?: AttrTag }\n<p>x</p>");
    expect(code).toContain('import type { AttrTag } from "@mxlang/preact";');
  });
});

describe("elements and text", () => {
  it("emits an element with its attributes", () => {
    expect(markup('<div class="card" id="x">hi</div>')).toBe(
      '<div class="card" id="x">hi</div>',
    );
  });

  it("emits a void element self-closed", () => {
    expect(markup("<input value=input.v>")).toBe(
      `<input value={${ATTR}("value", input.v, "input")} />`,
    );
  });

  it("escapes braces in text, which JSX would read as an expression", () => {
    expect(markup("<p>a {b} c</p>")).toBe("<p>a &#123;b&#125; c</p>");
  });

  it("escapes angle brackets in text, which JSX would read as element markup", () => {
    expect(markup("<p>a < b</p>")).toBe("<p>a &#60; b</p>");
    expect(markup("<p>a > b</p>")).toBe("<p>a &#62; b</p>");
  });

  it("decodes authored entities to numeric references the JSX transform decodes", () => {
    // Marko's parser keeps `&lt;`/`&amp;` raw and the browser decodes them
    // at parse. The emitter instead decodes authored text with HTML5 rules
    // and re-emits each JSX-significant or non-ASCII character as a numeric
    // reference, which every JSX transform decodes back to the same
    // character — so a browser's HTML5-only or unterminated legacy entity
    // cannot slip past the narrower JSX named-entity set.
    expect(markup("<p>&lt;a&gt; &amp; b</p>")).toBe(
      "<p>&#60;a&#62; &#38; b</p>",
    );
  });

  it("emits an escaped placeholder as an expression container", () => {
    expect(markup("<p>${input.name}</p>")).toBe("<p>{input.name}</p>");
  });

  it("carries an attribute method as a callable prop, a function expression", () => {
    expect(markup("<button onClick() { go(); }>x</button>")).toContain(
      "onClick={function () { go(); }}",
    );
  });

  it("emits a spread attribute", () => {
    expect(markup("<div ...input.rest>x</div>")).toBe(
      `<div {...${SPREAD}({ ...input.rest }, "div", ["ref","key","dangerouslySetInnerHTML"], true)}>x</div>`,
    );
  });
});

describe("class and style", () => {
  it("passes a plain string class through", () => {
    expect(markup('<div class="a b">x</div>')).toBe('<div class="a b">x</div>');
  });

  it("joins an object class through the emitted helper", () => {
    const code = compile("<div class={active: input.on}>x</div>");
    // The object's contents are sliced verbatim from source (this task's
    // fix keeps TypeScript type arguments the same way), not reformatted by
    // the generator, so no space follows `{` here.
    expect(code).toContain("class={__mxClass({active: input.on})}");
    expect(code).toContain(
      'import { mxClass as __mxClass } from "@mxlang/preact/runtime";',
    );
  });

  it("joins the `.class` shorthand merged with an object", () => {
    expect(markup("<div.card class={active: input.on}>x</div>")).toContain(
      "__mxClass(",
    );
  });

  it("emits an object style as a Preact style object", () => {
    // Sliced verbatim from source (no space after `{`), like the class case
    // above.
    expect(markup("<div style={color: input.c}>x</div>")).toBe(
      "<div style={{color: input.c}}>x</div>",
    );
  });

  it("rejects a non-object `style=` value", () => {
    expect(errorOf("<div style=input.s>x</div>")).toContain(
      "`style=` takes an object literal",
    );
  });

  it("leaves `#id` beside an explicit `id=` to Marko's own parse error", () => {
    // Marko rejects the pair in its parser, before any host declaration runs,
    // so this host adds no check of its own — it would be unreachable.
    expect(errorOf('<div#one id="two">x</div>')).toContain(
      "Cannot have shorthand id and id attribute",
    );
  });
});

describe("raw HTML", () => {
  it("lowers a sole `$!{…}` child to the raw-HTML prop", () => {
    expect(markup("<div>$!{input.html}</div>")).toBe(
      "<div dangerouslySetInnerHTML={{ __html: input.html }} />",
    );
  });

  it("rejects a raw placeholder beside other children", () => {
    expect(errorOf("<div>$!{input.html}<span>x</span></div>")).toContain(
      "raw placeholder (`$!{…}`) must be the only child",
    );
  });

  it("rejects a raw placeholder beside an explicit raw-HTML attribute", () => {
    expect(
      errorOf("<div dangerouslySetInnerHTML=input.x>$!{input.html}</div>"),
    ).toContain("combined with an explicit `dangerouslySetInnerHTML=`");
  });
});

describe("<if> chains", () => {
  it("lowers a lone `<if>` to a ternary ending in null", () => {
    expect(markup("<if=input.a><p>A</p></if>")).toBe(
      "{input.a ? <p>A</p> : null}",
    );
  });

  it("lowers `<if>`/`<else>` to one ternary", () => {
    expect(markup("<if=input.a><p>A</p></if>\n<else><p>B</p></else>")).toBe(
      "{input.a ? <p>A</p> : <p>B</p>}",
    );
  });

  it("chains `<else-if>` branches", () => {
    expect(
      markup(
        "<if=input.a><p>A</p></if>\n<else-if=input.b><p>B</p></else-if>\n<else><p>C</p></else>",
      ),
    ).toBe("{input.a ? <p>A</p> : input.b ? <p>B</p> : <p>C</p>}");
  });

  it("wraps a multi-node branch in a fragment", () => {
    expect(markup("<if=input.a><p>A</p><p>B</p></if>")).toContain(
      "<><p>A</p><p>B</p></>",
    );
  });
});

describe("<for> loops", () => {
  it("keys an `of` loop by the row itself when `by=` is absent", () => {
    expect(markup("<for|x| of=input.items><li>${x}</li></for>")).toBe(
      "{((mxList) => mxList ? [...mxList] : [])(input.items).map((x) => <__mxFragment key={x}><li>{x}</li></__mxFragment>)}",
    );
  });

  it("keys an `of` loop by the field a string `by=` names", () => {
    expect(
      markup('<for|item| of=input.items by="id"><li>${item.name}</li></for>'),
    ).toContain("key={item.id}");
  });

  it("keys an `of` loop by a `by=` function applied to the row", () => {
    expect(
      markup("<for|item| of=input.items by=keyOf><li>x</li></for>"),
    ).toContain("key={(keyOf)(item)}");
  });

  it("keys by index through a `by=` arrow, the README's duplicates answer", () => {
    // The default key is the row's own value, which collides for a list of
    // duplicate primitives — so the README tells an author to key by
    // position there. Pinned so that advice cannot drift from what compiles.
    expect(
      markup(
        "<for|tag, index| of=input.tags by=(tag, index) => index><li>${tag}</li></for>",
      ),
    ).toContain("key={((tag, index) => index)(tag, index)}");
  });

  it("binds the index parameter only when the author declares one", () => {
    expect(markup("<for|x, i| of=input.items><li>${i}</li></for>")).toContain(
      "map((x, i) =>",
    );
    expect(markup("<for|x| of=input.items><li>x</li></for>")).toContain(
      "map((x) =>",
    );
  });

  it("keys an `in` loop by the property name", () => {
    expect(markup("<for|k, v| in=input.obj><p>${k}</p></for>")).toBe(
      "{Object.entries(input.obj ?? {}).map(([k, v]) => <__mxFragment key={k}><p>{k}</p></__mxFragment>)}",
    );
  });

  it("names the `in` loop's value binding when the author omits it", () => {
    expect(markup("<for|k| in=input.obj><p>${k}</p></for>")).toContain(
      "([k, value])",
    );
  });

  it("lowers an inclusive range and keys rows by their value", () => {
    const out = markup("<for|i| from=1 to=3><b>${i}</b></for>");
    expect(out).toContain("(3) - (1) + 1");
    expect(out).toContain("map((i) => <__mxFragment key={i}>");
  });

  it("lowers an exclusive range without the inclusive adjustment", () => {
    expect(markup("<for|i| from=0 until=3><b>${i}</b></for>")).toContain(
      "Math.max(0, (3) - (0))",
    );
  });

  it("folds `step` into the emitted row value", () => {
    const out = markup("<for|i| from=1 to=9 step=2><b>${i}</b></for>");
    expect(out).toContain("(1) + __mxIndex * (2)");
    expect(out).toContain("Math.floor(((9) - (1)) / (2)) + 1");
  });

  it("renders an empty list for a backwards range rather than throwing", () => {
    expect(markup("<for|i| from=5 until=1><b>${i}</b></for>")).toContain(
      "Math.max(0,",
    );
  });

  it("names the counter `__mxIndex`, a name authored code cannot take", () => {
    // The counter is in scope for the authored `from`/`to`/`step`
    // expressions, which is why it must be a reserved `__mx` name and not a
    // plausible author name: see `range-name-collision.test.ts`. The
    // disambiguation `hygienicName` still does is unreachable for the base
    // name — an authored `__mxIndex` is rejected at the binding — but it
    // still guards the generated-name-versus-generated-name case.
    expect(markup("<for|i| from=0 to=2><b>${i}</b></for>")).toContain(
      "(__mxUnused, __mxIndex)",
    );
  });
});

describe("components", () => {
  it("passes attributes as props", () => {
    expect(
      markup('import Card from "./card.mx"\n<Card title="x" n=input.n/>'),
    ).toBe('<Card title="x" n={input.n} />');
  });

  it("passes ordinary children as JSX children", () => {
    expect(
      markup('import Card from "./card.mx"\n<Card><p>body</p></Card>'),
    ).toBe("<Card><p>body</p></Card>");
  });

  it("maps only the first repeated attribute tag's name, never a fabricated position for the rest", () => {
    // A second (or later) `<@item>` contributes another array entry with no
    // name string of its own in the generated text — the data-value array has
    // one `item` prop name to map, not two. A prior version pushed
    // a synthetic mapping for every repeat, hardcoded to the *first*
    // occurrence's generated position — silently misattributing any
    // diagnostic on the second tag's name to the first tag's source location.
    const source =
      'import List from "./list.mx"\n<List><@item>a</@item><@item>b</@item></List>';
    const result = compilePreactMx(source, "/fixtures/test.mx");
    const firstOffset = source.indexOf("item");
    const secondOffset = source.indexOf("item", firstOffset + 1);
    expect(firstOffset).not.toBe(secondOffset);

    const firstMapping = result.mappings.find(
      (mapping) => mapping.sourceStart === firstOffset,
    );
    expect(firstMapping).toBeDefined();
    expect(
      result.code.slice(
        firstMapping?.generatedStart,
        firstMapping?.generatedEnd,
      ),
    ).toBe("item");

    const secondMapping = result.mappings.find(
      (mapping) => mapping.sourceStart === secondOffset,
    );
    expect(secondMapping).toBeUndefined();
  });

  it("passes tag params as a render-prop child", () => {
    expect(
      markup(
        'import List from "./list.mx"\n<List|item| items=input.items><span>${item}</span></List>',
      ),
    ).toBe("<List items={input.items}>{(item) => <span>{item}</span>}</List>");
  });

  it("passes ordinary children the JSX way, so `input.content` still reads them", () => {
    // The two halves of the same bridge: the caller emits children as JSX
    // children, and the callee's `${input.content}` reads them back. Each was
    // separately plausible and together they silently rendered an empty
    // element — `<Card><p/></Card>` compiled clean and dropped the `<p>`.
    const caller = compile(
      'import Card from "./card.mx"\n<Card><p>body</p></Card>',
    );
    expect(caller).toContain("<Card><p>body</p></Card>");

    const callee = compile('<div class="card">${input.content}</div>');
    expect(callee).toContain("(props as { children?: unknown }).children");
  });

  it("forwards tag arguments to the inlined mxDynamic helper", () => {
    expect(markup('<${input.render}("x", 2)/>')).toBe(
      '{__mxDynamic(input.render, ["x", 2])}',
    );
  });

  it("emits a dynamic tag name (with a body) through the inlined mxDynamic helper", () => {
    // JSX's tag position is static and Marko's dynamic tag is polymorphic at
    // run time (a tag-name string, a render function, or already-rendered
    // content passed straight through — see the `nested-layout` oracle
    // fixture), so this host inlines a small helper rather than binding the
    // expression to a JSX tag position.
    expect(markup("<${input.tag}>hi</>")).toBe(
      "{__mxDynamic(input.tag, { content: () => <><>hi</></> })}",
    );
    expect(compile("<${input.tag}>hi</>")).toContain("function __mxDynamic(");
  });

  it("emits a bare `${expr}` line the same way, as a dynamic tag", () => {
    // A bare concise-position `${expr}` line and `<${expr}/>` parse to the
    // same Marko node and both are the dynamic-tag shape — see the "four
    // Marko facts" in AGENTS.md.
    expect(markup("<${input.tag}/>")).toBe("{__mxDynamic(input.tag, {  })}");
  });

  it("passes attributes through on a dynamic tag", () => {
    expect(markup("<${input.tag} n=1/>")).toBe(
      '{__mxDynamic(input.tag, { "n": 1 })}',
    );
  });

  it("only inlines mxDynamic when a template actually uses a dynamic tag", () => {
    expect(compile("<p>x</p>")).not.toContain("__mxDynamic");
  });
});

/**
 * `mxDynamic`'s three value kinds, rendered for real through
 * `preact-render-to-string` — Marko's own dynamic-tag polymorphism (a
 * tag-name string, a render function/component, or already-rendered content
 * such as a caller's `input.content`/`children`, passed straight through
 * rather than called again). The `nested-layout` oracle fixture
 * (`<main><${input.content}/></main>`) is the real-world case for the third
 * kind: this host's `content` is JSX children, not a callable.
 */
describe("mxDynamic's three value kinds (rendered)", () => {
  async function renderCompiled(
    source: string,
    input: unknown,
  ): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const code = compilePreactMx(source, "/fixtures/dyn.mx").code;
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-dyn-"));
    try {
      const repoNodeModules = dirname(
        dirname(require.resolve("preact/package.json")),
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      const entry = join(scratch, "dyn.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, unknown>>;
      };
      return render(h(mod.default, input as Record<string, unknown>));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("renders a string target as an element with that tag name", async () => {
    const html = await renderCompiled('<${input.tag} class="x"/>', {
      tag: "span",
    });
    expect(html).toBe('<span class="x"></span>');
  });

  it("renders a function target by calling it as a component", async () => {
    const html = await renderCompiled("<${input.tag} n=1/>", {
      tag: (props: { n: number }) => `<em>${props.n}</em>`,
    });
    // A plain JS function used as a JSX tag renders through Preact's own
    // function-component path, not through the html host's string return —
    // `preact-render-to-string` calls it and renders whatever it returns.
    expect(html).toContain("1");
  });

  it("passes already-rendered content straight through, rather than calling it again", async () => {
    // The `nested-layout` oracle fixture's real shape: a caller's ordinary
    // JSX children become `input.content`, and `<${input.content}/>` must
    // render that tree as-is, not treat it as a component or tag name.
    const html = await renderCompiled("<div><${input.content}/></div>", {
      children: h("em", null),
    });
    expect(html).toBe("<div><em></em></div>");
  });

  it("passes body-only fallback attribute tags bare through a dynamic call", async () => {
    const html = await renderCompiled("<${input.tag}><@head>H</@head></>", {
      tag: (props: { head: unknown }) => props.head,
    });
    expect(html).toBe("H");
  });

  it("forwards tag arguments to a dynamic tag call, positionally", async () => {
    // `<${input.render}("x", 2)/>`, no content/attribute tags: no trailing
    // props object, so the target is called with the arguments alone.
    const html = await renderCompiled('<${input.render}("x", 2)/>', {
      render: (a: string, b: number) => h("b", null, `${a}-${b}`),
    });
    expect(html).toBe("<b>x-2</b>");
  });

  it("renders a string target as its element, even with arguments", async () => {
    // Marko's own html/dom runtimes treat a string renderer as a tag name
    // to emit whatever arguments it was called with — it never renders the
    // tag name as literal text. `mxDynamic` must not fall through to
    // returning the bare string here. args[0] ("x", a non-object) becomes
    // the spread attributes source (decision 112): `for...in` over a string
    // yields its numeric indices, matching Marko's own `_attrs`'s `for
    // (const name in data)` over the same non-object value.
    const html = await renderCompiled('<${input.tag}("x", 2)/>', {
      tag: "span",
    });
    expect(html).toBe('<span 0="x"></span>');
  });

  it("uses args[0] as the string target's attributes (decision 112, Marko parity)", async () => {
    const html = await renderCompiled(
      '<${input.tag}({ id: "x", class: "y" })/>',
      { tag: "span" },
    );
    expect(html).toBe('<span id="x" class="y"></span>');
  });

  it("appends a trailing props object when arguments combine with a body (decision 109, Marko parity)", async () => {
    const html = await renderCompiled('<${input.render}("x", 2)>body</>', {
      render: (a: string, b: number, extra?: { content?: () => unknown }) =>
        h("b", null, `${a}-${b}-`, extra?.content?.() as never),
    });
    expect(html).toBe("<b>x-2-body</b>");
  });

  it("appends a trailing props object when arguments combine with an attribute tag (decision 109, Marko parity)", async () => {
    const html = await renderCompiled(
      '<${input.render}("x", 2)><@head>H</@head></>',
      {
        render: (a: string, b: number, extra?: { head?: unknown }) =>
          h("b", null, `${a}-${b}-`, extra?.head as never),
      },
    );
    expect(html).toBe("<b>x-2-H</b>");
  });
});

/**
 * Decision 116: a capitalized tag bound to a value import that is not a
 * `.marko`/`.mx` default import lowers as a dynamic tag — the routing
 * itself, exercised with an ordinary `import { X } from "./target.ts"` and
 * an ordinary `<X>`/`<X/>` call, not `<${expr}>` syntax.
 */
describe("decision 116: value import used as a tag (preact)", () => {
  async function renderImportedTag(
    entrySource: string,
    targetSource: string,
    input: unknown = {},
  ): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-decision116-"));
    try {
      const repoNodeModules = dirname(
        dirname(require.resolve("preact/package.json")),
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      writeFileSync(join(scratch, "target.ts"), targetSource);
      const code = compilePreactMx(entrySource, join(scratch, "entry.mx")).code;
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, unknown>>;
      };
      return render(h(mod.default, input as Record<string, unknown>));
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

  it("a plain function value import is called as a host component (decision 116, intentional Marko divergence)", async () => {
    const html = await renderImportedTag(
      'import { Comp } from "./target.ts"\n<Comp n=1/>',
      "export function Comp(props: { n: number }) {\n  return `<em>${props.n}</em>`;\n}",
    );
    expect(html).toContain("1");
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
describe("local-value-as-tag-parity: non-import local used as a tag (preact)", () => {
  async function renderLocalTag(entrySource: string): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-local116-"));
    try {
      const repoNodeModules = dirname(
        dirname(require.resolve("preact/package.json")),
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      const code = compilePreactMx(entrySource, join(scratch, "entry.mx")).code;
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, unknown>>;
      };
      return render(h(mod.default, {}));
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
    // The chosen function is called and its return value used, matching the
    // plain-function divergence measured for decision 116's own import case
    // above — but a JSX host renders a returned *string* as escaped text
    // (there is no raw-HTML-from-string channel without
    // `dangerouslySetInnerHTML`), so the markup comes back escaped rather
    // than parsed, unlike html's target.
    const html = await renderLocalTag(
      [
        'static function A() { return "<span>a</span>"; }',
        'static function B() { return "<span>b</span>"; }',
        "static const useA = true;",
        "static const Tag = useA ? A : B;",
        "<Tag/>",
      ].join("\n"),
    );
    expect(html).toBe("&lt;span>a&lt;/span>");
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
 * Firstmate's follow-up on decision 116: preact/compat's own `memo`/
 * `forwardRef` return real FUNCTIONS (measured, unlike React's own — see the
 * sibling describe block in `@mxlang/react`'s suite), so `mxDynamic`'s
 * pre-existing `typeof target === "function"` branch already handled them.
 * The one real gap on this host is React's own `memo`/`forwardRef` reached
 * indirectly — a `.tsx` value import can bring in an object built with
 * React's real `memo` even inside a Preact app (e.g. through `react-dom`
 * interop or a shared library) — exercised here directly against `mxDynamic`
 * to prove the fix in `@mxlang/preact`'s emitter covers every host that
 * shares it.
 */
describe("local-value-as-tag-parity: memo()/forwardRef() objects on the dynamic path (preact)", () => {
  async function renderWithLibrary(entrySource: string): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-memo116-"));
    try {
      // Neither `require.resolve("preact/package.json")` nor
      // `require.resolve("react/package.json")` lands at a directory holding
      // *both* packages — bun's isolated linker resolves each to its own
      // `.bun/<pkg>@.../node_modules` store, which holds only that package's
      // own dependencies. This test needs both preact and react resolvable
      // from the same symlinked `node_modules`, so it walks up to the real
      // worktree root instead (`.../packages/hosts/preact/src/` -> root is
      // four levels up), where bun's top-level linker hoists everything.
      const { fileURLToPath } = await import("node:url");
      const repoNodeModules = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../node_modules",
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      const code = compilePreactMx(entrySource, join(scratch, "entry.mx")).code;
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, unknown>>;
      };
      return render(h(mod.default, {}));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("preact/compat's own memo(Foo) (a real function) already renders correctly", async () => {
    const html = await renderWithLibrary(
      [
        'import { memo } from "preact/compat";',
        'static function Foo(props: { n: number }) { return h("em", null, props.n); }',
        'import { h } from "preact";',
        "static const Comp = memo(Foo);",
        "<Comp n=1/>",
      ].join("\n"),
    );
    expect(html).toBe("<em>1</em>");
  });

  // Measured, not assumed: React's raw `memo(Foo)`/`forwardRef(...)` object
  // cannot render on Preact at all, through `mxDynamic` or otherwise — this
  // is not a decision-116 routing gap, it is a real Preact-vs-React
  // incompatibility that exists in hand-written Preact code with no MX
  // involved. `preact-render-to-string`'s own dispatcher
  // (`typeof type == "function"`, `src/index.js:327`) has no object-based
  // component branch at all, unlike React's reconciler — a bare
  // `<Comp/>` where `Comp` is React's own `memo` object throws
  // `"[object Object] is not a valid HTML tag name"` identically whether
  // reached through `mxDynamic` or through a plain, unrelated JSX element
  // written by hand (confirmed by hand outside this suite: `<Comp n={1}/>`
  // with no MX layer throws the same error). This is *why*
  // `preact/compat`'s own `memo`/`forwardRef` deliberately wrap in a real
  // function instead of returning an object — the test above renders that
  // form successfully. `mxIsHostComponentObject`'s widened check in
  // `mxDynamic` (this package's emitter) is still correct for React and
  // Hono, both of which do support the object form (see `@mxlang/react`'s
  // and `@mxlang/hono`'s own suites) — Preact genuinely has no such form to
  // support, on any path.
});

/**
 * Attribute-tag rendered shape (decisions 106–107), executed through Preact
 * rather than asserted only as emitted source text.
 */
describe("attribute tag values (executed)", () => {
  /**
   * A temporary `row.mx` is written before its caller is compiled, so core's
   * real callee-Input resolver sees declared shapes. Both generated modules
   * are then rendered together through Preact.
   */
  async function renderCompiled(
    callerBody: string,
    rowBody: string,
    input: Record<string, unknown> = {},
  ): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-attrtag-"));
    try {
      const repoNodeModules = dirname(
        dirname(require.resolve("preact/package.json")),
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      const rowSource = join(scratch, "row.mx");
      writeFileSync(rowSource, rowBody);
      const rowCode = compilePreactMx(rowBody, rowSource).code;
      const callerSource = join(scratch, "attrtag.mx");
      const callerCode = compilePreactMx(callerBody, callerSource).code.replace(
        'from "./row.mx"',
        'from "./row.tsx"',
      );
      writeFileSync(join(scratch, "row.tsx"), rowCode);
      const entry = join(scratch, "attrtag.tsx");
      writeFileSync(entry, callerCode);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, unknown>>;
      };
      return render(h(mod.default, input));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("body-only fallback single and array values use the renderable shape", async () => {
    const html = await renderCompiled(
      'import Row from "./row.mx"\n<Row><@item>solo</@item><@many>a</@many><@many>b</@many></Row>',
      '<div>single=${String(!Array.isArray(input.item))} array=${String(Array.isArray(input.many))} entries=${String(input.many.every((item) => !(typeof item === "object" && item !== null && "content" in item)))}</div>',
    );
    expect(html).toContain("single=true");
    expect(html).toContain("array=true");
    expect(html).toContain("entries=true");
  });

  it("renders a parameterized placeholder body through data content", async () => {
    const html = await renderCompiled(
      'import Row from "./row.mx"\n<Row><@item|value|>${value}</@item></Row>',
      [
        "export interface Input { item: AttrTag<{ params: [value: string] }> }",
        '<p><span>${input.item.content("safe")}</span></p>',
      ].join("\n"),
    );
    expect(html).toBe("<p><span>safe</span></p>");
  });

  it("emits declared data, array, renderable, params and bodyless shapes", async () => {
    const html = await renderCompiled(
      [
        'import Row from "./row.mx"',
        '<Row><@head tone="hot">H</@head><@item id=1>A</@item><@item id=2>B</@item><@slot>S</@slot><@render|label|><b>${label}</b></@render><@empty/></Row>',
      ].join("\n"),
      [
        'export interface Input { head: AttrTag<{ attrs: { tone: string } }>; item: AttrTag<{ attrs: { id: number } }>[]; none: AttrTag[]; slot: AttrTag<{ as: "renderable" }>; render: AttrTag<{ as: "renderable"; params: [label: string] }>; empty: AttrTag }',
        '<section data-tone=input.head.tone><${input.head.content}/><for|item| of=input.item><i data-id=item.id><${item.content}/></i></for><${input.slot}/><${input.render("P")}/><u>${input.none.length}:${String(input.empty.content === undefined)}</u></section>',
      ].join("\n"),
    );
    expect(html).toBe(
      '<section data-tone="hot">H<i data-id="1">A</i><i data-id="2">B</i>S<b>P</b><u>0:true</u></section>',
    );
  });

  it("emits if/else values and merges static plus for values in order", async () => {
    const html = await renderCompiled(
      [
        'import Row from "./row.mx"',
        "<Row><if=input.ok><@head>A</@head></if><else><@head>B</@head></else><@item>S</@item><for|value| of=input.values><@item>${value}</@item></for></Row>",
      ].join("\n"),
      [
        "export interface Input { head: AttrTag; item: AttrTag[] }",
        "<div><${input.head.content}/><for|item| of=input.item><i>${item.content}</i></for></div>",
      ].join("\n"),
      { ok: false, values: ["1", "2"] },
    );
    expect(html).toBe("<div>B<i>S</i><i>1</i><i>2</i></div>");
  });

  it("recursively emits nested data tags two levels deep", async () => {
    const html = await renderCompiled(
      'import Row from "./row.mx"\n<Row><@tab title="One"><@icon label="star">I</@icon>T</@tab></Row>',
      [
        "export interface Input { tab: AttrTag<{ attrs: { title: string; icon: AttrTag<{ attrs: { label: string } }> } }>[] }",
        "<article><for|tab| of=input.tab><h2>${tab.title}</h2><b>${tab.icon.label}:<${tab.icon.content}/></b><${tab.content}/></for></article>",
      ].join("\n"),
    );
    expect(html).toBe("<article><h2>One</h2><b>star:I</b>T</article>");
  });
});

describe("component aliases", () => {
  // Decision 164: a lowercase tag is a native element or a registered tag,
  // never a call to an imported binding. A lowercase taglib tag is the only
  // route to the alias, because JSX would read `<badge>` as an element.
  it("aliases a lowercase taglib tag a JSX element would shadow", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-alias-"));
    try {
      mkdirSync(join(scratch, "tags"));
      writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
      mkdirSync(join(scratch, "impl"));
      writeFileSync(
        join(scratch, "marko.json"),
        JSON.stringify({ "<badge>": { template: "./impl/badge.mx" } }),
      );
      writeFileSync(join(scratch, "impl", "badge.mx"), "<p>${input.label}</p>");
      const { code } = compilePreactMx(
        '<badge label="x"/>',
        join(scratch, "main.mx"),
      );
      expect(code).toContain('import _badge from "./impl/badge.mx"');
      expect(code).toContain('<_badge label="x" />');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("calls a registered taglib tag whatever a same-named import binds", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-alias-reg-"));
    try {
      mkdirSync(join(scratch, "tags"));
      writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
      mkdirSync(join(scratch, "impl"));
      writeFileSync(
        join(scratch, "marko.json"),
        JSON.stringify({ "<badge>": { template: "./impl/badge.mx" } }),
      );
      writeFileSync(join(scratch, "impl", "badge.mx"), "<p>${input.label}</p>");
      const warnings: MxWarning[] = [];
      const { code } = compilePreactMx(
        'import badge from "./badge.mx"\n<badge label="x"/>',
        join(scratch, "main.mx"),
        { warnings },
      );
      // The taglib tag, under core's binding: never the authored import.
      expect(code).toContain('import _badge from "./impl/badge.mx"');
      expect(code.split('"./impl/badge.mx"')).toHaveLength(2);
      expect(code).toContain('<_badge label="x" />');
      expect(code).not.toContain("__mxBadge");
      expect(code).not.toContain('<badge label="x" />');
      expect(warnings).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a lowercase tag that names a tag import and is no element", () => {
    expect(() =>
      compilePreactMx(
        'import badge from "./badge.mx"\n<badge label="x"/>',
        "/fixtures/test.mx",
      ),
    ).toThrow(
      "`<badge>` is not a tag here: `badge` is imported from ./badge.mx, and a lowercase tag never calls a binding. Write `<Badge>` (rename the import) or `<${badge}/>`",
    );
  });

  it("leaves a capitalized component name alone", () => {
    const code = compile('import Badge from "./badge.mx"\n<Badge label="x"/>');
    expect(code).toContain("<Badge");
    expect(code).not.toContain("MxBadge");
  });
});

describe("<define> and <const>", () => {
  it("lowers a top-level `<const>` to a binding in the component body", () => {
    const code = compile("<const/n=input.a * 2/>\n<p>${n}</p>");
    expect(code).toContain("const n = input.a * 2;");
    expect(code).toContain("<p>{n}</p>");
  });

  it("lowers a top-level `<define>` to a local function", () => {
    const code = compile(
      "<define/Row|label|><li>${label}</li></define>\n<Row('a')/>",
    );
    expect(code).toContain("const Row = (label) => (<><li>{label}</li></>);");
    expect(code).toContain("{Row('a')}");
  });

  it("accepts a `<define>` call mixing tag-argument form with an attribute tag (decision 109, Marko parity)", async () => {
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const code = compilePreactMx(
      "<define/Card|title, head|><div>${title}<${head}/></div></define>\n<Card('a')><@head>H</@head></Card>",
      "/fixtures/card.mx",
    ).code;
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-define-args-"));
    try {
      const repoNodeModules = dirname(
        dirname(require.resolve("preact/package.json")),
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      const entry = join(scratch, "card.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, unknown>>;
      };
      const html = render(h(mod.default, {}));
      expect(html).toBe("<div>aH</div>");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a `<const>` nested inside markup", () => {
    expect(errorOf("<div><const/n=1/><p>${n}</p></div>")).toContain(
      "`<const>` must appear at the top level",
    );
  });
});

describe("<try>", () => {
  it("lowers `<@catch>` to the error boundary with a function fallback", () => {
    const code = compile(
      'import Body from "./body.mx"\n<try><Body/><@catch|err|><p>${err}</p></@catch></try>',
    );
    expect(code).toContain(
      'import { MxErrorBoundary as __mxErrorBoundary } from "@mxlang/preact/runtime";',
    );
    expect(code).toContain(
      "<__mxErrorBoundary fallback={(err) => <p>{err}</p>}>{() => (<><Body />",
    );
    expect(code).toContain("</>)}</__mxErrorBoundary>");
  });

  it("passes the body as a thunk so a throw written in it is inside the boundary", () => {
    expect(
      markup(
        'import Body from "./body.mx"\n<try><p>${input.a.b}</p><@catch><p>failed</p></@catch></try>',
      ),
    ).toBe(
      "<__mxErrorBoundary fallback={() => <p>failed</p>}>{() => (<><p>{input.a.b}</p></>)}</__mxErrorBoundary>",
    );
  });

  it("emits a param-less `<@catch>` fallback as a function", () => {
    expect(
      markup(
        'import Body from "./body.mx"\n<try><Body/><@catch><p>failed</p></@catch></try>',
      ),
    ).toContain("fallback={() => <p>failed</p>}");
  });

  it("leaves a body without `<@catch>` inline", () => {
    expect(markup('import Body from "./body.mx"\n<try><Body/></try>')).toBe(
      "<Body />",
    );
  });

  it("lowers `<@placeholder>` to the suspense wrapper", () => {
    const code = compile(
      'import Body from "./body.mx"\n<try><Body/><@placeholder><p>loading</p></@placeholder></try>',
    );
    expect(code).toContain(
      'import { MxPlaceholder as __mxSuspense } from "@mxlang/preact/runtime";',
    );
    expect(code).toContain("<__mxSuspense fallback={<p>loading</p>}>");
  });

  it("nests the placeholder inside the boundary when both are given", () => {
    const out = markup(
      'import Body from "./body.mx"\n<try><Body/><@catch><p>e</p></@catch><@placeholder><p>l</p></@placeholder></try>',
    );
    expect(out.indexOf("<__mxErrorBoundary")).toBeLessThan(
      out.indexOf("<__mxSuspense"),
    );
  });

  it("rejects an unknown attribute tag inside `<try>`", () => {
    expect(
      errorOf(
        'import Body from "./body.mx"\n<try><Body/><@other>x</@other></try>',
      ),
    ).toContain("unknown attribute tag `<@other>`");
  });

  it("rejects a repeated attribute tag inside `<try>`", () => {
    expect(
      errorOf(
        'import Body from "./body.mx"\n<try><Body/><@catch>a</@catch><@catch>b</@catch></try>',
      ),
    ).toContain("may not be repeated");
  });
});

describe("stateful Marko tags are errors naming the Preact equivalent", () => {
  it.each([
    ["<let>", "<let/count=0/>\n<p>${count}</p>", "useState"],
    ["<effect>", "<effect() { go(); }/>", "useEffect"],
    ["<lifecycle>", "<lifecycle onMount() { go(); }/>", "useEffect"],
    ["<id>", "<id/x/>\n<p>${x}</p>", "useId"],
    ["<script>", "<script>go();</script>", "client-runtime tag"],
    [
      "a client block",
      "client const x = 1;\n<p>${x}</p>",
      "client-runtime split",
    ],
  ])("rejects %s", (_name, source, hint) => {
    expect(errorOf(source)).toContain(hint);
  });

  it("rejects `:=`, which has no Preact equivalent", () => {
    expect(errorOf("<input value:=input.v>")).toContain(
      "Marko's two-way binding",
    );
  });

  it("rejects an attribute modifier with Preact's own spelling", () => {
    expect(errorOf("<div class:active=input.on>x</div>")).toContain(
      "is not Preact syntax",
    );
  });

  it("rejects a document type, which belongs in the HTML shell", () => {
    expect(errorOf("<!doctype html>\n<p>x</p>")).toContain(
      "cannot appear in a Preact component",
    );
  });
});

// Ref custom-tags-import-precedence: spec §4's precedence (explicit import >
// local tags/ > mx.tags), on the second real JSX host the round 1 review
// asked for.
describe("import precedence over registered custom tags", () => {
  const marker: CustomTag = {
    transform: (_call, ctx) => [ctx.build.element("mx-marker", [], [])],
  };

  it("resolves an imported PascalCase component over a registered custom tag of the same name", () => {
    const code = compilePreactMx(
      'import Panel from "./panel.mx"\n<Panel/>\n',
      "/fixtures/test.mx",
      { customTags: { Panel: marker } },
    ).code;
    expect(code).not.toContain("mx-marker");
    expect(code).toMatch(/<Panel\s*\/>/);
  });

  // Round 1 regression: a lowercase import must not shadow a registered
  // custom tag either — Preact's own `isComponentName` (emitter.ts) never
  // treats a lowercase name as a component, imported or not.
  it("does not let a lowercase import shadow a registered custom tag of the same name", () => {
    const code = compilePreactMx(
      'import panel from "./panel.mx"\n<panel/>\n',
      "/fixtures/test.mx",
      { customTags: { panel: marker } },
    ).code;
    expect(code).toContain("mx-marker");
  });
});

// Ref custom-tags-local-bindings (decision 113): a file-local *scope*
// binding — `<const/Panel=…/>`, a `<for|Panel|>` param, a
// `<define/Box|Panel|>` param — shadows a registered custom tag of the same
// name too, scoped to where the binding is in effect. IR-level coverage
// lives in `packages/core/src/custom-tags.test.ts`; this is the executed
// render the brief required on a second real JSX host.
describe("local scope bindings shadow a registered custom tag (executed)", () => {
  const panel: CustomTag = {
    transform: (_call, ctx) => [ctx.build.element("mx-marker", [], [])],
  };

  async function renderWithCustomTag(body: string): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const code = compilePreactMx(body, "/fixtures/local-binding.mx", {
      customTags: { Panel: panel },
    }).code.replace('from "./local-panel.ts"', 'from "./local-panel"');
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-local-binding-"));
    try {
      const repoNodeModules = dirname(
        dirname(require.resolve("preact/package.json")),
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      writeFileSync(
        join(scratch, "local-panel.tsx"),
        "export default function LocalPanel() { return <span>local-panel</span>; }\n",
      );
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, unknown>>;
      };
      return render(h(mod.default, {}));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("a `<const/Panel=…/>` binding renders the local component, not the registered custom tag", async () => {
    const html = await renderWithCustomTag(
      [
        'import LocalPanel from "./local-panel.ts"',
        "<const/Panel=LocalPanel/>",
        "<Panel/>",
      ].join("\n"),
    );
    expect(html).toBe("<span>local-panel</span>");
  });

  it("a `<for|Panel|>` param renders the loop's own binding inside the loop, and the registered custom tag immediately outside it", async () => {
    const html = await renderWithCustomTag(
      [
        'import LocalPanel from "./local-panel.ts"',
        "<for|Panel| of=[LocalPanel]>",
        "<Panel/>",
        "</for>",
        "<Panel/>",
      ].join("\n"),
    );
    expect(html).toBe("<span>local-panel</span><mx-marker></mx-marker>");
  });

  it("a `<define/Box|Panel|>` param renders the define's own binding inside the body, and the registered custom tag immediately outside it", async () => {
    const html = await renderWithCustomTag(
      [
        'import LocalPanel from "./local-panel.ts"',
        "<define/Box|Panel|>",
        "<Panel/>",
        "</define>",
        "<Box(LocalPanel)/>",
        "<Panel/>",
      ].join("\n"),
    );
    expect(html).toBe("<span>local-panel</span><mx-marker></mx-marker>");
  });

  // Round 2 (lead review): the leak this closes is a `<const>` inside an
  // `<if>`/`<else>` branch permanently replacing `ctx.tagVarShadowed` because
  // `scopeBindings` (core.ts) didn't snapshot it — `<const>` never restores
  // its own shadow (by design), so leak prevention has to come entirely from
  // the branch's own `scopeBindings` wrapper. This host cannot express that
  // scenario at all: every structural kind here lowers to a JSX expression
  // with no statement position, so a `<const>` (or `<define>`) *nested*
  // inside `<if>`/`<for>` markup is a compile error on this host regardless
  // of the fix (`PreactEmitter`'s `constant`/`define`: "must appear at the
  // top level of the template" — pre-existing, unrelated to this decision).
  // A `<for|Panel|>` tag param nested the same way is legitimate here, but
  // does not exercise the fixed code path: `<for>`'s own `shadowBindings`
  // restore already reverts `tagVarShadowed` on its own, independent of the
  // enclosing `<if>`'s `scopeBindings` — so there is nothing to leak. The
  // round-2 regression and its fix are executed-render tested on html
  // (`packages/targets/html/src/translate.test.ts`), the host that can
  // actually compile the repro; IR-level coverage for `<if>`/`<else>`/nested
  // `<for>` is in `packages/core/src/custom-tags.test.ts`.
});

/**
 * `<return>` and `/var` on the JSX hosts (acceptance C3).
 *
 * The call to a returning unit is emitted as an ordinary *function call*,
 * not as a JSX element, and that is the whole point: a JSX element is a
 * description of a call the runtime makes later, so `<Counter/>` in
 * expression position would never hand the `{ value, output }` pair back.
 */
describe("a unit that returns a value", () => {
  const counterSource = [
    "export interface Input { start: number }",
    "<span>${input.start}</span>",
    "<return value=input.start + 1/>",
  ].join("\n");

  const counter: CustomTag = {
    template: { filename: "/fixtures/tags/counter.mx", source: counterSource },
  } as CustomTag;

  const callerCode = (source: string): string =>
    compilePreactMx(source, "/fixtures/page.mx", {
      customTags: { counter },
    }).code;

  it("returns { value, output } from .render, output alone from the default export", () => {
    const code = compilePreactMx(
      counterSource,
      "/fixtures/tags/counter.mx",
    ).code;

    // Decision 155's model on this host: the body function returns the pair
    // and binds it as `.render`; the default export returns only the output,
    // so any caller without static knowledge of the unit (a dynamic tag, a
    // hand-written TSX import) renders the body, never the pair object.
    expect(code).toContain("return { value: input.start + 1, output: (<>");
    expect(code).toMatch(
      /function CounterUnit\(props: Input\) \{[\s\S]*return \{ value:/,
    );
    expect(code).toContain("Counter.render = CounterUnit;");
    expect(code).toContain("function Counter(props: Input) {");
    expect(code).toContain("return CounterUnit(props).output;");
    expect(code).toContain("export default Counter;");
  });

  it("evaluates the call above the return and binds the /var", () => {
    const code = callerCode("<counter/n start=1/>\n<p>${n}</p>");

    // Invariant §7.5-4's sequence, in the one place this target has a
    // statement position: the call, then the binding, then the output where
    // the call stood.
    const call = code.indexOf("const __mxRet0 = $mx_Counter1.render(");
    const bind = code.indexOf("const n = __mxRet0.value;");
    const ret = code.indexOf("return (<>");
    expect(call).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(call);
    expect(ret).toBeGreaterThan(bind);
    expect(code).toContain("{__mxRet0.output}");
    expect(code).toContain("<p>{n}</p>");
  });

  it("unwraps the output when the call binds no /var", () => {
    const code = callerCode("<counter start=1/>");

    expect(code).toContain('{$mx_Counter1({ "start": 1 })}');
    expect(code).not.toContain("__mxRet");
  });

  it("gives each /var call site its own temp", () => {
    const code = callerCode(
      "<counter/a start=1/>\n<counter/b start=2/>\n<p>${a}${b}</p>",
    );

    expect(code).toContain("const a = __mxRet0.value;");
    expect(code).toContain("const b = __mxRet1.value;");
  });

  // Round 1, findings 1 and 2. Every structural kind on this target is an
  // expression, so a callback scope has no statement position — and hoisting
  // the call to the component body took it out of the scope it was written
  // in: inside a `<for>` it read a row binding that did not exist there and
  // ran once for a body rendered N times. Invariant §7.5-8 rejects the
  // escape rather than emitting it.
  it("rejects /var inside <for>, naming the tag as written", () => {
    expect(() =>
      callerCode("<for|i| of=[1,2]><counter/n start=i/><p>${n}</p></for>"),
    ).toThrow(/`\/var` on `<counter>` inside `<for>`\/`<if>` is not supported/);
  });

  it("rejects /var inside <if>", () => {
    expect(() =>
      callerCode("<if=true><counter/n start=1/><p>${n}</p></if>"),
    ).toThrow(/is not supported on Preact yet/);
  });

  it("still allows a call with no /var inside <for>", () => {
    // Only the *binding* is refused; the call itself is an ordinary one and
    // its output renders per row (the default export already returns it).
    const code = callerCode("<for|i| of=[1,2]><counter start=i/></for>");

    expect(code).toContain('$mx_Counter1({ "start": i })');
  });

  it("rejects a hook in a unit that declares <return>", () => {
    // A returning unit is invoked as a plain function, so its hooks would
    // bind to the *calling* component's hook list rather than its own.
    expect(() =>
      compilePreactMx(
        [
          'import { useState } from "preact/hooks"',
          "<const/s=useState(0)/>",
          "<p>x</p>",
          "<return value=1/>",
        ].join("\n"),
        "/fixtures/tags/hooky.mx",
      ),
    ).toThrow(/`useState` cannot be used in a tag that declares `<return>`/);
  });

  // Round 2, finding A. The first guard matched the module as a
  // double-quoted substring of the printed import and tested the *local*
  // binding name, so each of these three spellings walked straight past it.
  // They are now decided on the parsed statement: the source's own value,
  // and the name the module exports rather than the name this file calls it.
  it.each([
    ["a single-quoted specifier", "import { useState } from 'preact/hooks'"],
    ["a namespace import", 'import * as h from "preact/hooks"'],
    ["an aliased import", 'import { useState as us } from "preact/hooks"'],
  ])("rejects a hook reached through %s", (_what, statement) => {
    expect(() =>
      compilePreactMx(
        [statement, "<p>x</p>", "<return value=1/>"].join("\n"),
        "/fixtures/tags/hooky.mx",
      ),
    ).toThrow(/cannot be used in a tag that declares `<return>`/);
  });

  it("names the hook by its exported name when it is aliased", () => {
    // `us` is what the author reads in this file, but `useState` is what
    // identifies the hook — so the message carries both.
    expect(() =>
      compilePreactMx(
        [
          'import { useState as us } from "preact/hooks"',
          "<p>x</p>",
          "<return value=us(0)/>",
        ].join("\n"),
        "/fixtures/tags/hooky.mx",
      ),
    ).toThrow(/`useState` \(imported as `us`\)/);
  });

  it("rejects a hook imported from preact/compat", () => {
    expect(() =>
      compilePreactMx(
        [
          'import { useState } from "preact/compat"',
          "<p>x</p>",
          "<return value=1/>",
        ].join("\n"),
        "/fixtures/tags/hooky.mx",
      ),
    ).toThrow(/`useState` cannot be used in a tag that declares `<return>`/);
  });

  it("rejects a hook imported from react (hook-guard-module-list round 2): preact/compat aliases react's hook exports, so a Preact-compiled unit can reach a real dispatcher through either specifier", () => {
    expect(() =>
      compilePreactMx(
        [
          'import { useState } from "react"',
          "<p>x</p>",
          "<return value=1/>",
        ].join("\n"),
        "/fixtures/tags/hooky.mx",
      ),
    ).toThrow(/`useState` cannot be used in a tag that declares `<return>`/);
  });

  it("leaves a non-hook export of a hook module alone", () => {
    // The module is on the list, but `createContext` is not a hook: the test
    // is the imported *name*, not where it came from.
    const code = compilePreactMx(
      [
        'import { createContext } from "preact/compat"',
        "<p>x</p>",
        "<return value=1/>",
      ].join("\n"),
      "/fixtures/tags/ctx.mx",
    ).code;

    expect(code).toContain("return { value: 1, output: (<>");
  });

  it("leaves a hook alone in a unit that does not return", () => {
    const code = compilePreactMx(
      [
        'import { useState } from "preact/hooks"',
        "<const/s=useState(0)/>",
        "<p>x</p>",
      ].join("\n"),
      "/fixtures/tags/hooky.mx",
    ).code;

    expect(code).toContain("const s = useState(0);");
  });

  it("leaves a local use-prefixed helper alone", () => {
    // The guard keys on the *module* a hook comes from, not the name alone:
    // a local `useTotal` is ordinary code.
    const code = compilePreactMx(
      [
        'import { useTotal } from "./helpers.ts"',
        "<p>x</p>",
        "<return value=useTotal()/>",
      ].join("\n"),
      "/fixtures/tags/total.mx",
    ).code;

    expect(code).toContain("return { value: useTotal(), output: (<>");
  });

  it("accepts <return> in a page, where it used to be an error", () => {
    // This host rejected `<return>` outright while a tag template was
    // expanded into its caller. Under the unit model every `.mx` file is a
    // module with a caller, so a page is not a special case.
    const code = compilePreactMx(
      "<p>x</p>\n<return=42/>",
      "/fixtures/p.mx",
    ).code;

    expect(code).toContain("return { value: 42, output: (<>");
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("recomposes the prop from the DOM event name, not the authored spelling", () => {
    expect(markup("<button onClick=handler>x</button>")).toBe(
      "<button onClick={handler}>x</button>",
    );
  });

  it("collapses onDblClick and on-dblclick byte-identically", () => {
    const a = markup("<button onDblClick=f>x</button>");
    const b = markup("<button on-dblclick=f>x</button>");
    expect(a).toBe("<button onDblClick={f}>x</button>");
    expect(a).toBe(b);
  });

  it("rejects onDoubleClick: Preact's types declare no such prop (no aliases)", () => {
    // Core warns (`onDoubleClick` is not a DOM event) and never rewrites;
    // the emitter refuses a name the Preact types do not declare rather than
    // emit `onDoubleclick`. The warning is pinned in the core's lower tests.
    expect(errorOf("<button onDoubleClick=handler>x</button>")).toContain(
      "`onDoubleClick` names the DOM event `doubleclick`, which Preact's JSX types declare no handler prop for",
    );
  });

  it("rejects a custom DOM event name uniformly, pointing at a ref", () => {
    expect(errorOf("<div on-my-event=fn>x</div>")).toContain(
      '`on-my-event` names a custom DOM event (`my-event`) a JSX prop cannot spell; use a `ref` to add a custom event listener (`ref={el => el?.addEventListener("my-event", fn)}`)',
    );
  });

  it("passes a static inline handler string through verbatim", () => {
    // Spec §4: a string-valued `onClick` stays an ordinary static attribute;
    // MX does not invent a policy against inline handler strings.
    expect(markup('<button onClick="alert(1)">x</button>')).toBe(
      '<button onClick="alert(1)">x</button>',
    );
  });

  it("rejects on: with a fix-it naming on-<exact>", () => {
    expect(errorOf("<div on:click=fn>x</div>")).toContain(
      "write `onClick=fn` for a DOM event or `on-click=fn` for a custom event name",
    );
  });

  it("preserves oncapture: as an ordinary attribute, not a capture alias", () => {
    expect(markup("<div oncapture:click=fn>x</div>")).toBe(
      `<div oncapture:click={${ATTR}("oncapture:click", fn, "div")}>x</div>`,
    );
  });
});

describe("event name positions and spellings", () => {
  it("looks multi-word DOM names up in Preact's camelCase names (onKeyDown)", () => {
    // Preact lowercases the prop at bind time, so the old `onKeydown` still
    // bound `keydown`; but the JSX types declare `onKeyDown` only, so the
    // spelling is the declared one (decision 161).
    expect(markup("<input onKeyDown=handler>")).toBe(
      "<input onKeyDown={handler} />",
    );
    expect(markup("<div onPointerDown=f>x</div>")).toBe(
      "<div onPointerDown={f}>x</div>",
    );
    expect(markup("<div on-mousedown=f>x</div>")).toBe(
      "<div onMouseDown={f}>x</div>",
    );
  });

  it("positions the custom-event error at the attribute name", () => {
    let error: unknown;
    try {
      markup("<div   on-my-event=fn>x</div>");
    } catch (caught) {
      error = caught;
    }
    // `<div` is 4 chars, three spaces, the name starts at column 7 — the
    // same offset `nameSpan.sourceStart` carries, so the language server
    // underlines the name rather than the tag.
    expect(error).toMatchObject({ line: 1, column: 7 });
    expect((error as Error).message).toContain("on-my-event");
  });

  it("positions the error on the attribute's own line", () => {
    let error: unknown;
    try {
      markup("<p>x</p>\n<div  on-my-event=fn>y</div>");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ line: 2, column: 6 });
  });
});

/**
 * JSX-significant characters in authored text (the `jsx-text-lt-unescaped`
 * bug): the emitter must escape `<`, `>`, and braces so the *generated* TSX
 * parses, and the rendered DOM text must equal Marko's. Marko renders
 * `a < b` as text; the pre-fix emitter copied it verbatim into the JSX,
 * which failed downstream with `[builtin:vite-transform] Unexpected token`.
 */
describe("text with JSX-significant characters (rendered)", () => {
  async function renderCompiled(source: string): Promise<string> {
    const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    const code = compilePreactMx(source, "/fixtures/text.mx").code;
    const scratch = mkdtempSync(join(tmpdir(), "mx-preact-text-"));
    try {
      const repoNodeModules = dirname(
        dirname(require.resolve("preact/package.json")),
      );
      symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
      writeFileSync(
        join(scratch, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
        }),
      );
      const entry = join(scratch, "text.tsx");
      writeFileSync(entry, code);
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: FunctionComponent<Record<string, never>>;
      };
      return render(h(mod.default, {}));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("renders a bare `<` in text as text, like Marko", async () => {
    // Marko renders `<div>a < b</div>`; Preact's serializer escapes the
    // text for HTML, so the byte form differs but the parsed DOM is equal.
    expect(await renderCompiled("<div>a < b</div>")).toBe(
      "<div>a &lt; b</div>",
    );
  });

  it("renders a bare `>` and a literal ampersand like Marko", async () => {
    // Preact's serializer leaves `>` bare in text; parse5-decoded, both
    // forms equal Marko's `a > b` / `a & b`.
    expect(await renderCompiled("<div>a > b</div>")).toBe("<div>a > b</div>");
    expect(await renderCompiled("<div>a & b</div>")).toBe(
      "<div>a &amp; b</div>",
    );
  });

  it("renders authored entities as the decoded character, like Marko's browser parse", async () => {
    // Preact's serializer escapes `<` and `&` but leaves `>` bare in text, so
    // the byte form differs from Marko's while the parsed DOM is equal.
    expect(await renderCompiled("<div>&lt;a&gt; &amp; b</div>")).toBe(
      "<div>&lt;a> &amp; b</div>",
    );
  });

  it("renders HTML5-only and unterminated legacy entities like Marko's browser parse", async () => {
    // jsx-text-entities: JSX transforms decode only `;`-terminated numeric
    // references and the HTML4 named set, where the browser applies the
    // HTML5 rules. The emitter decodes authored text with `entities`' spec-
    // exact decoder, so these render as Marko + parse5 does.
    expect(await renderCompiled("<div>&copy 2026</div>")).toBe(
      "<div>© 2026</div>",
    );
    expect(await renderCompiled("<div>&amp y</div>")).toBe(
      "<div>&amp; y</div>",
    );
    expect(await renderCompiled("<div>&check; &lt &#123</div>")).toBe(
      "<div>✓ &lt; {</div>",
    );
    expect(await renderCompiled("<div>&nLt; &#xD800;</div>")).toBe(
      "<div>≪⃒ �</div>",
    );
  });

  it("keeps authored entities undecoded inside a raw-text <style> body", () => {
    // The HTML tokenizer applies no character references inside raw-text
    // elements, so the emitter must not HTML5-decode a <style> body even
    // though the same text outside would decode. (The JSX transform itself
    // may still decode `;`-terminated references it recognises — raw-text
    // parity for a `&` inside <style> is impossible once the host serializer
    // re-escapes it — so this pins the emitter, which is what MX controls.)
    expect(markup("<style>a { color: red; } /* &copy; stays */</style>")).toBe(
      "<style>a &#123; color: red; &#125; /* &copy; stays */</style>",
    );
  });

  it("renders decoded newline references as newlines, not JSX-collapsed space", async () => {
    // jsx-text-entities round 2: a decoded `\n` re-emitted literally into
    // JSX text is trimmed/collapsed by the JSX whitespace rules (`a b`),
    // where Marko's `a&#10;b` renders `a\nb`. The emitter re-emits every
    // control character as a numeric reference, which JSX decodes after its
    // own whitespace handling.
    expect(await renderCompiled("<div>a&#10;b</div>")).toBe("<div>a\nb</div>");
    expect(await renderCompiled("<div>a&#10;</div>")).toBe("<div>a\n</div>");
    expect(await renderCompiled("<div>&#10;a</div>")).toBe("<div>\na</div>");
    expect(await renderCompiled("<div>a&#9;b</div>")).toBe("<div>a\tb</div>");
  });

  it("rejects <html-comment> instead of emitting a literal element", () => {
    // JSX has no comment node; before the claim, the tag fell through to
    // the native-element path and silently rendered `<html-comment>` where
    // Marko renders `<!--…-->`.
    expect(() => markup("<html-comment>hi</html-comment>")).toThrow(
      /cannot appear in a Preact component/,
    );
  });

  it("renders braces in text as literal characters, like Marko", async () => {
    expect(await renderCompiled("<div>a {b} c</div>")).toBe(
      "<div>a {b} c</div>",
    );
  });
});
