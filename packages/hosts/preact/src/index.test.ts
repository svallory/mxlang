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

import type { CustomTag } from "@mxlang/core";
import { h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/** Compiles one template and returns the emitted module. */
function compile(source: string): string {
  return compilePreactMx(source, "/fixtures/test.mx").code;
}

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

  it("imports nothing when the template uses no helper", () => {
    const code = compile("<p>hi</p>");
    expect(code).not.toContain('from "preact"');
    expect(code).not.toContain("@mxlang/preact/runtime");
  });
});

describe("elements and text", () => {
  it("emits an element with its attributes", () => {
    expect(markup('<div class="card" id="x">hi</div>')).toBe(
      '<div class="card" id="x">hi</div>',
    );
  });

  it("emits a void element self-closed", () => {
    expect(markup("<input value=input.v>")).toBe("<input value={input.v} />");
  });

  it("escapes braces in text, which JSX would read as an expression", () => {
    expect(markup("<p>a {b} c</p>")).toBe("<p>a &#123;b&#125; c</p>");
  });

  it("emits an escaped placeholder as an expression container", () => {
    expect(markup("<p>${input.name}</p>")).toBe("<p>{input.name}</p>");
  });

  it("carries an attribute method as a callable prop", () => {
    expect(markup("<button onClick() { go(); }>x</button>")).toContain(
      "onClick={() =>",
    );
  });

  it("emits a spread attribute", () => {
    expect(markup("<div ...input.rest>x</div>")).toBe(
      "<div {...input.rest}>x</div>",
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
    expect(code).toContain("class={mxClass({active: input.on})}");
    expect(code).toContain('import { mxClass } from "@mxlang/preact/runtime";');
  });

  it("joins the `.class` shorthand merged with an object", () => {
    expect(markup("<div.card class={active: input.on}>x</div>")).toContain(
      "mxClass(",
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
      "{[...input.items].map((x) => <Fragment key={x}><li>{x}</li></Fragment>)}",
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
      "{Object.entries(input.obj).map(([k, v]) => <Fragment key={k}><p>{k}</p></Fragment>)}",
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
    expect(out).toContain("map((i) => <Fragment key={i}>");
  });

  it("lowers an exclusive range without the inclusive adjustment", () => {
    expect(markup("<for|i| from=0 until=3><b>${i}</b></for>")).toContain(
      "Math.max(0, (3) - (0))",
    );
  });

  it("folds `step` into the emitted row value", () => {
    const out = markup("<for|i| from=1 to=9 step=2><b>${i}</b></for>");
    expect(out).toContain("(1) + mxIndex * (2)");
    expect(out).toContain("Math.floor(((9) - (1)) / (2)) + 1");
  });

  it("renders an empty list for a backwards range rather than throwing", () => {
    expect(markup("<for|i| from=5 until=1><b>${i}</b></for>")).toContain(
      "Math.max(0,",
    );
  });

  it("picks a non-colliding counter when the body already uses `mxIndex`", () => {
    expect(
      markup("<for|mxIndex| from=0 to=2 step=1><b>${mxIndex}</b></for>"),
    ).toContain("mxIndex2");
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

  it("passes an attribute tag as a prop", () => {
    expect(
      markup(
        'import Card from "./card.mx"\n<Card><@footer>f</@footer><p>b</p></Card>',
      ),
    ).toContain("footer={<>f</>}");
  });

  it("collapses a repeated attribute tag into an array prop", () => {
    // Marko's own rule, and what lets the callee write
    // `<for|it| of=input.item><${it}/></for>`. Emitting the prop twice let
    // the last one win, so the callee's loop iterated a single node.
    expect(
      markup(
        'import List from "./list.mx"\n<List><@item>a</@item><@item>b</@item></List>',
      ),
    ).toContain("item={[<>a</>, <>b</>]}");
  });

  it("maps only the first repeated attribute tag's name, never a fabricated position for the rest", () => {
    // A second (or later) `<@item>` contributes another array entry with no
    // name string of its own in the generated text — `item={[<>a</>, <>b</>]}`
    // has one `item` to map to, not two. A prior version of this code pushed
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

  it("passes an attribute tag with params as a function prop", () => {
    expect(
      markup(
        'import Card from "./card.mx"\n<Card><@row|item|>${item}</@row></Card>',
      ),
    ).toContain("row={(item) => item}");
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

  it("emits a dynamic tag name (with a body) through the inlined mxDynamic helper", () => {
    // JSX's tag position is static and Marko's dynamic tag is polymorphic at
    // run time (a tag-name string, a render function, or already-rendered
    // content passed straight through — see the `nested-layout` oracle
    // fixture), so this host inlines a small helper rather than binding the
    // expression to a JSX tag position.
    expect(markup("<${input.tag}>hi</>")).toBe(
      "{mxDynamic(input.tag, { content: () => <><>hi</></> })}",
    );
    expect(compile("<${input.tag}>hi</>")).toContain("function mxDynamic(");
  });

  it("emits a bare `${expr}` line the same way, as a dynamic tag", () => {
    // A bare concise-position `${expr}` line and `<${expr}/>` parse to the
    // same Marko node and both are the dynamic-tag shape — see the "four
    // Marko facts" in AGENTS.md.
    expect(markup("<${input.tag}/>")).toBe("{mxDynamic(input.tag, {  })}");
  });

  it("passes attributes through on a dynamic tag", () => {
    expect(markup("<${input.tag} n=1/>")).toBe(
      '{mxDynamic(input.tag, { "n": 1 })}',
    );
  });

  it("only inlines mxDynamic when a template actually uses a dynamic tag", () => {
    expect(compile("<p>x</p>")).not.toContain("mxDynamic");
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
      // biome-ignore lint/suspicious/noExplicitAny: bridges the compiled module's real props type into `h`'s untyped generic
      const mod = (await import(`${entry}?t=${Date.now()}`)) as {
        default: any;
      };
      return render(h(mod.default, input as Record<string, unknown>));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("renders a string target as an element with that tag name", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
    const html = await renderCompiled('<${input.tag} class="x"/>', {
      tag: "span",
    });
    expect(html).toBe('<span class="x"></span>');
  });

  it("renders a function target by calling it as a component", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
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
    const html = await renderCompiled(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
      "<div><${input.content}/></div>",
      { children: h("em", null) },
    );
    expect(html).toBe("<div><em></em></div>");
  });
});

describe("component aliases", () => {
  it("renames a lowercase component JSX would read as an element", () => {
    // JSX decides element-vs-component by case: emitted verbatim, a
    // `tags/`-discovered `<badge/>` rendered a literal `<badge>` element with
    // the props as attributes — a silently wrong render, not an error.
    const code = compile('import badge from "./badge.mx"\n<badge label="x"/>');
    expect(code).toContain("<MxBadge");
    expect(code).toContain("const MxBadge = badge;");
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
      'import { MxErrorBoundary } from "@mxlang/preact/runtime";',
    );
    expect(code).toContain(
      "<MxErrorBoundary fallback={(err) => <p>{err}</p>}>",
    );
  });

  it("passes a param-less `<@catch>` body as a plain fallback node", () => {
    expect(
      markup(
        'import Body from "./body.mx"\n<try><Body/><@catch><p>failed</p></@catch></try>',
      ),
    ).toContain("fallback={<p>failed</p>}");
  });

  it("lowers `<@placeholder>` to the suspense wrapper", () => {
    const code = compile(
      'import Body from "./body.mx"\n<try><Body/><@placeholder><p>loading</p></@placeholder></try>',
    );
    expect(code).toContain(
      'import { MxPlaceholder } from "@mxlang/preact/runtime";',
    );
    expect(code).toContain("<MxPlaceholder fallback={<p>loading</p>}>");
  });

  it("nests the placeholder inside the boundary when both are given", () => {
    const out = markup(
      'import Body from "./body.mx"\n<try><Body/><@catch><p>e</p></@catch><@placeholder><p>l</p></@placeholder></try>',
    );
    expect(out.indexOf("<MxErrorBoundary")).toBeLessThan(
      out.indexOf("<MxPlaceholder"),
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
      'import Panel from "./panel.marko"\n<Panel/>\n',
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
      'import panel from "./panel.marko"\n<panel/>\n',
      "/fixtures/test.mx",
      { customTags: { panel: marker } },
    ).code;
    expect(code).toContain("mx-marker");
  });
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

  it("returns { value, output } instead of markup alone", () => {
    const code = compilePreactMx(
      counterSource,
      "/fixtures/tags/counter.mx",
    ).code;

    expect(code).toContain("return { value: input.start + 1, output: (<>");
  });

  it("evaluates the call above the return and binds the /var", () => {
    const code = callerCode("<counter/n start=1/>\n<p>${n}</p>");

    // Invariant §7.5-4's sequence, in the one place this target has a
    // statement position: the call, then the binding, then the output where
    // the call stood.
    const call = code.indexOf("const $mx_ret0 = $mx_Counter1(");
    const bind = code.indexOf("const n = $mx_ret0.value;");
    const ret = code.indexOf("return (<>");
    expect(call).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(call);
    expect(ret).toBeGreaterThan(bind);
    expect(code).toContain("{$mx_ret0.output}");
    expect(code).toContain("<p>{n}</p>");
  });

  it("unwraps the output when the call binds no /var", () => {
    const code = callerCode("<counter start=1/>");

    expect(code).toContain('{$mx_Counter1({ "start": 1 }).output}');
    expect(code).not.toContain("$mx_ret");
  });

  it("gives each /var call site its own temp", () => {
    const code = callerCode(
      "<counter/a start=1/>\n<counter/b start=2/>\n<p>${a}${b}</p>",
    );

    expect(code).toContain("const a = $mx_ret0.value;");
    expect(code).toContain("const b = $mx_ret1.value;");
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
    // its output renders per row.
    const code = callerCode("<for|i| of=[1,2]><counter start=i/></for>");

    expect(code).toContain(".output}");
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
    expect(a).toBe("<button onDblclick={f}>x</button>");
    expect(a).toBe(b);
  });

  it("emits onDoubleClick as onDoubleclick without rewriting (no aliases)", () => {
    // Core warns (`onDoubleClick` is not a DOM event) but never rewrites;
    // the prop is recomposed from the DOM name exactly as written. The
    // warning itself is pinned in the core's lower tests.
    expect(markup("<button onDoubleClick=handler>x</button>")).toBe(
      "<button onDoubleclick={handler}>x</button>",
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

  it("rejects oncapture: with the capture explanation", () => {
    expect(errorOf("<div oncapture:click=fn>x</div>")).toContain(
      "MX has no capture spelling in the name",
    );
  });
});

describe("event name positions and plain-recomposition spellings", () => {
  it("recomposes multi-word DOM names with capitalize-first (onKeydown), unlike React", () => {
    // Preact/hono/solid lowercase the prop at bind time, so `onKeydown`
    // binds `keydown`; only the React target looks React's camelCase up.
    expect(markup("<input onKeyDown=handler>")).toBe(
      "<input onKeydown={handler} />",
    );
    expect(markup("<div onPointerDown=f>x</div>")).toBe(
      "<div onPointerdown={f}>x</div>",
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
