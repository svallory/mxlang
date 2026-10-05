import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import type { TemplateBackedTag } from "@mxlang/core";
import { sourceBindings, unknownSourceBindings } from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

/**
 * Renders an MX `<for>` fragment through the real Solid 2 pipeline:
 * `compileSolidMx` -> Solid JSX text (this host's actual emitted output) ->
 * `@solidjs/babel-plugin` SSR codegen -> `@solidjs/web`'s `renderToString`,
 * run in a Bun subprocess. Unlike the emitter's own snapshot tests in
 * `index.test.ts`, this proves the emitted `<For>`/`<Repeat>` binding
 * actually renders row data under Solid, not just that it prints the
 * expected string.
 *
 * `compileSolidMx` (the fragment API this host actually exports) is used
 * directly rather than going through `@mxlang/parser`'s whole-file
 * `.solid.mx` `parse()`: that bridge has a separate, pre-existing bug
 * (unrelated to the `keyed` fix here, reproduced on `main`) triggered by a
 * parenthesized/multi-line `<for>` region regardless of `by=` — a two-param
 * multi-line `<for|p, i|>` is a hard parse error there too — that drops a
 * `<for>` param when splicing the lowered JSX back into a surrounding
 * TypeScript module. See the report for solid-for-accessor.
 */
function renderSolidMx(
  mxFragment: string,
  setup: string,
  options: Parameters<typeof compileSolidMx>[1] = {
    filename: "fixture.solid.mx",
  },
): string {
  const {
    code: forCode,
    hoistedImports,
    hoistedDefines,
  } = compileSolidMx(mxFragment, {
    ...options,
    // `setup` is spliced into the compiled runtime module at render time,
    // below, but never seen by `compileSolidMx` itself — so a name it
    // declares (e.g. a local `function Row(input) {...}`) must be supplied
    // here the same way a real caller's surrounding module would be.
    moduleBindings: sourceBindings(setup).bindings,
    // Local extension of decision 116: classified the same way a real
    // `.solid.mx` compile classifies its surrounding module, through
    // `@mxlang/parser`'s `unknownSourceBindings`.
    unknownModuleBindings: unknownSourceBindings(setup),
  });
  const imports = [...hoistedImports, ...hoistedDefines]
    .map((entry) => entry.code)
    .join("\n");
  const jsxSource = `${imports}\nimport { createSignal } from "solid-js";\nexport function App() {\n  ${setup}\n  return <ul>${forCode}</ul>;\n}\n`;

  const ssr = transformSync(jsxSource, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!ssr?.code)
    throw new Error("Solid babel plugin produced no code for fixture.tsx");
  return ssr.code;
}

/**
 * Runs the compiled Solid SSR module in a real Bun subprocess, rather than
 * `import()`ing it under vitest: vitest's own SSR module resolution does not
 * walk up to this workspace's bun-managed `node_modules/.bun`, so a dynamic
 * import of `@solidjs/web` from a plain tmp file fails to resolve its own
 * `seroval` dependency there. Bun run from inside this package resolves the
 * workspace's real dependency graph, which is also the graph a consumer's
 * own build would use.
 */
function renderApp(
  mxFragment: string,
  setup: string,
  options?: Parameters<typeof compileSolidMx>[1],
): string {
  const code = renderSolidMx(mxFragment, setup, options);
  const dir = mkdtempSync(join(packageRoot, ".ssr-render-tmp-"));
  const appPath = join(dir, "app.mjs");
  const runnerPath = join(dir, "run.mjs");
  writeFileSync(appPath, code);
  writeFileSync(
    runnerPath,
    `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
  );
  try {
    return execFileSync("bun", ["run", runnerPath], {
      cwd: packageRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Same real-Solid-pipeline rendering as `renderApp`, but for a *real import*
 * rather than a module-scope declaration — decision 116's routing is scoped
 * to import bindings, so `renderApp`'s `setup`-string approach (always a
 * local `const`/`function`, never an import) cannot exercise it at all.
 * Writes `targetSource` to a real sibling `.tsx` file (may contain JSX) and
 * imports it — a non-`.marko`/`.mx` extension either way, which is all
 * decision 116's routing checks.
 */
function renderAppWithImport(
  mxFragment: string,
  targetName: string,
  targetSource: string,
): string {
  const dir = mkdtempSync(join(packageRoot, ".ssr-render-import-tmp-"));
  try {
    // The imported target may itself contain JSX (the plain-function
    // divergence case), so it needs the same Solid transform the fixture
    // gets — writing `targetSource` verbatim as `.mjs` would leave real JSX
    // unparsed by plain Node/Bun.
    const targetSsr = transformSync(targetSource, {
      filename: "target.tsx",
      presets: [[typescriptPreset, {}]],
      plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
      babelrc: false,
      configFile: false,
    });
    if (!targetSsr?.code)
      throw new Error("Solid babel plugin produced no code for target.tsx");
    writeFileSync(join(dir, "target.mjs"), targetSsr.code);
    const {
      code: forCode,
      hoistedImports,
      hoistedDefines,
    } = compileSolidMx(mxFragment, {
      filename: join(dir, "fixture.solid.mx"),
      importSpecifiers: new Map([[targetName, "./target.tsx"]]),
    });
    const imports = [...hoistedImports, ...hoistedDefines]
      .map((entry) => entry.code)
      .join("\n");
    const jsxSource = `${imports}\nimport { ${targetName} } from "./target.tsx";\nexport function App() {\n  return <ul>${forCode}</ul>;\n}\n`;
    const ssr = transformSync(jsxSource, {
      filename: "fixture.tsx",
      presets: [[typescriptPreset, {}]],
      plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
      babelrc: false,
      configFile: false,
    });
    if (!ssr?.code)
      throw new Error("Solid babel plugin produced no code for fixture.tsx");
    const appPath = join(dir, "app.mjs");
    const runnerPath = join(dir, "run.mjs");
    writeFileSync(
      appPath,
      ssr.code.replace('"./target.tsx"', '"./target.mjs"'),
    );
    writeFileSync(
      runnerPath,
      `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    );
    return execFileSync("bun", ["run", runnerPath], {
      cwd: packageRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderDeclaredAttrTags(
  mxFragment: string,
  inputDeclaration: string,
  setup: string,
): string {
  const dir = mkdtempSync(join(packageRoot, ".attr-tag-types-"));
  const caller = join(dir, "caller.solid.mx");
  const callee = join(dir, "Row.tsx");
  writeFileSync(
    callee,
    `import type { AttrTag } from "@mxlang/solid";\nexport interface Input ${inputDeclaration}\n`,
  );
  try {
    return renderApp(mxFragment, setup, {
      filename: caller,
      importSpecifiers: new Map([["Row", "./Row.tsx"]]),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("generated names do not shadow authored bindings", () => {
  it.each(["$mxEscape", "$mxText", "$mxEscaped"])(
    "renders with an authored %s",
    (base) => {
      // The serial is process-wide: probe its next value instead of assuming 0.
      const probe = compileSolidMx(
        '<Row><@head kind="x">${value}</@head></Row>',
        {
          filename: "fixture.solid.mx",
          moduleBindings: new Set(["Row", "value"]),
        },
      ).code;
      const serial = Number(/(?:\$mx|__mx)Text(\d+)/.exec(probe)?.[1]) + 1;
      const name = base === "$mxEscape" ? base : `${base}${serial}`;
      expect(
        renderApp(
          `<Row><@head kind="x">\${${name}}</@head></Row>`,
          `const ${name} = "<x>"; function Row(input) { return <Dynamic component={input.head.content}/>; }`,
        ),
      ).toBe("<ul>&lt;x></ul>");
    },
  );
  it.each(["$mxDyn", "$mxDynValue"])("renders with an authored %s", (base) => {
    const probe = compileSolidMx("<${target}({})>ok</>", {
      filename: "fixture.solid.mx",
    }).code;
    const serial = Number(/(?:\$mx|__mx)Dyn(\d+)/.exec(probe)?.[1]) + 1;
    const name = `${base}${serial}`;
    const html = renderApp(
      `<\${${name}}${base === "$mxDynValue" ? "({})" : ""}>ok</>`,
      `const ${name} = "p";`,
    );
    expect(html.replace(/ _hk=[^>]* /g, "")).toBe("<ul><p>ok</p></ul>");
  });
  it("does not shadow an authored $mxV return binding", () => {
    expect(
      renderApp(
        "<div><counter/$mxV/><p>${$mxV}</p></div>",
        "let $mxV; function Row(props) { props.$mxReturn(42); return <i>ok</i>; }",
        {
          filename: "fixture.solid.mx",
          customTags: {
            counter: {
              template: {
                filename: "/tmp/reserved-counter.mx",
                source: "<return value=42/>",
              },
              transform(call) {
                return [
                  {
                    kind: "Component",
                    target: { kind: "name", name: "Row" },
                    nameSpan: null,
                    args: [],
                    attrs: [],
                    attributeTags: [],
                    attributeTagTree: [],
                    attrTagProps: [],
                    content: null,
                    returnsValue: true,
                    var: call.var ?? undefined,
                    loc: call.loc,
                  },
                ];
              },
            } as TemplateBackedTag,
          },
        },
      ),
    ).toBe("<ul><div><i>ok</i><p>42</p></div></ul>");
  });
});

describe("Solid SSR render: attribute-tag values", () => {
  it("executes fallback data values, arrays, bodyless content and Dynamic", () => {
    const html = renderApp(
      `<Row><@head kind="heading">H</@head><@item id=0>0</@item><@item id=2>2</@item><@empty present/></Row>`,
      `function Row(input) { return <section><Dynamic component={input.head.content}/><div>{input.head.content}{input.head.content}</div><For each={input.item}>{(item) => <i>{item.content}</i>}</For><u>{String(input.empty.content === undefined)}</u></section>; }`,
    );
    expect(html).toBe(
      "<ul><section>H<div>HH</div><i>0</i><i>2</i><u>true</u></section></ul>",
    );
  });

  it("executes declared shapes, params, control flow and nested tags", () => {
    const html = renderDeclaredAttrTags(
      `<Row><if=ok><@head tone="hot">A</@head></if><else><@head tone="cold">B</@head></else><@item id=0>S</@item><for|value| of=values><@item id=value>\${value}</@item></for><@slot>R</@slot><@render|label|><b>\${label}</b></@render><@tab title="T"><@icon label="star">I</@icon></@tab></Row>`,
      `{ head: AttrTag<{ attrs: { tone: string } }>; item: AttrTag<{ attrs: { id: number } }>[]; slot: AttrTag<{ as: "renderable" }>; render: AttrTag<{ as: "renderable"; params: [label: string] }>; tab: AttrTag<{ attrs: { title: string; icon: AttrTag<{ attrs: { label: string } }> } }> }`,
      `const ok = false; const values = [1, 2]; function Row(input) { return <article data-tone={input.head.tone}><Dynamic component={input.head.content}/><For each={input.item}>{(item) => <i data-id={item.id}>{item.content}</i>}</For><Dynamic component={input.slot}/><Dynamic component={input.render("P")}/><strong>{input.tab.title}:{input.tab.icon.label}:<Dynamic component={input.tab.icon.content}/></strong></article>; }`,
    );
    expect(html).toBe(
      '<ul><article data-tone="cold">B<i data-id="0">S</i><i data-id="1">1</i><i data-id="2">2</i>R<b>P</b><strong>T:star:I</strong></article></ul>',
    );
  });
});

describe("Solid SSR render: <for>", () => {
  it("renders row properties for the unkeyed (no by=) form", () => {
    const html = renderApp(
      `<for|p| of=people><li>\${p.name}</li></for>`,
      `const people = [{ name: "Ada" }, { name: "Grace" }];`,
    );
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  it("renders row properties for by=identity", () => {
    const html = renderApp(
      `<for|p| of=people by=identity><li>\${p.name}</li></for>`,
      `const people = [{ name: "Ada" }, { name: "Grace" }];`,
    );
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  // An earlier round recorded this as "blocked on a Solid 2 rc.7 SSR
  // keyed-fn bug" and skipped it. That diagnosis was wrong, and re-measured
  // here: `<For each keyed={x => x.id}>{(p, i) => p().name}</For>` renders
  // correctly under `@solidjs/web`'s own `renderToString`. The empty render
  // came from the body reading `p.name` on a *function* — the very bug these
  // rewrites fix — not from Solid.
  it('renders row properties for by="field"', () => {
    const html = renderApp(
      `<for|p| of=people by="id"><li>\${p.name}</li></for>`,
      `const people = [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }];`,
    );
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  it("renders row properties for by=<expr>", () => {
    const html = renderApp(
      `<for|p| of=people by=myKey><li>\${p.name}</li></for>`,
      `const myKey = (p) => p.id;\n  const people = [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }];`,
    );
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  it("renders the index for the default two-param form", () => {
    // The default `<For>` hands the row as a value but the index as an
    // accessor, so `${i}` alone would render a function's source text.
    const html = renderApp(
      `<for|p, i| of=people><li>\${i}:\${p.name}</li></for>`,
      `const people = [{ name: "Ada" }, { name: "Grace" }];`,
    );
    expect(html).toContain("0:Ada");
    expect(html).toContain("1:Grace");
    expect(html).not.toContain("=>");
  });

  it('renders row and index for by="field" with two params', () => {
    const html = renderApp(
      `<for|p, i| of=people by="id"><li>\${i}:\${p.name}</li></for>`,
      `const people = [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }];`,
    );
    expect(html).toContain("0:Ada");
    expect(html).toContain("1:Grace");
  });

  it("renders key and value for the for-in form", () => {
    const html = renderApp(
      `<for|k, v| in=record><li>\${k}=\${v}</li></for>`,
      `const record = { a: 1, b: 2 };`,
    );
    expect(html).toContain("a=1");
    expect(html).toContain("b=2");
  });

  it("renders a destructured row under by=", () => {
    const html = renderApp(
      `<for|{ name, id }| of=people by="id"><li>\${id}:\${name}</li></for>`,
      `const people = [{ id: 7, name: "Ada" }, { id: 9, name: "Grace" }];`,
    );
    expect(html).toContain("7:Ada");
    expect(html).toContain("9:Grace");
  });

  it("reads the row inside the body rather than snapshotting it once", () => {
    // The reactivity claim behind rewriting reads rather than snapshotting.
    // A `const p = p$()` at the callback top would render identically here
    // but go stale when Solid replaces a same-key row in place, so what is
    // asserted is the emitted shape: each read is its own call, inside the
    // expression, and no snapshot binding is introduced.
    const { code } = compileSolidMx(
      `<for|p| of=people by="id"><li>\${p.name} \${p.age}</li></for>`,
      { filename: "fixture.solid.mx" },
    );
    expect(code).toContain("p().name");
    expect(code).toContain("p().age");
    expect(code).not.toMatch(/const\s+p\s*=/);
  });

  it("leaves a nested binding that shadows the row alone", () => {
    // The inner arrow's own `p` is that arrow's parameter, not the row, so
    // rewriting it to `p()` would call a string.
    const html = renderApp(
      `<for|p| of=people by="id"><li>\${p.tags.map(p => p + "!").join(",")}</li></for>`,
      `const people = [{ id: 1, tags: ["x", "y"] }];`,
    );
    expect(html).toContain("x!,y!");
  });
});

describe("Solid <for>: destructured params and nesting", () => {
  const mx = (source: string) =>
    compileSolidMx(source, { filename: "fixture.solid.mx" }).code;

  // Round 1 item 1: the `in=` branch used to emit the params verbatim, so a
  // destructured half was dropped from the parameter list and its names were
  // left as free references that still compiled.
  it("resolves a destructured for-in key through the entry accessor", () => {
    expect(mx(`<for|{ a }, v| in=obj><li>\${a}\${v}</li></for>`)).toContain(
      "{mxEntry()[0].a}{mxEntry()[1]}",
    );
  });

  it("resolves an array-destructured for-in key", () => {
    expect(mx(`<for|[a], v| in=obj><li>\${a}\${v}</li></for>`)).toContain(
      "{mxEntry()[0][0]}{mxEntry()[1]}",
    );
  });

  it("resolves a destructured for-in value", () => {
    expect(mx(`<for|k, { n }| in=obj><li>\${k}\${n}</li></for>`)).toContain(
      "{mxEntry()[0]}{mxEntry()[1].n}",
    );
  });

  it("rejects a rest element in a for-in param, as it does for of=", () => {
    expect(() =>
      mx(`<for|k, { ...r }| in=obj><li>\${k}\${r}</li></for>`),
    ).toThrow(/cannot be bound on this host/);
  });

  // Round 1 item 2: collecting names for the gensym used to *emit* the
  // subtree, which ran every nested `<for>`'s own rewrite as a side effect;
  // the body was then emitted again and rewritten twice.
  it("rewrites a nested <for> row exactly once", () => {
    const code = mx(
      `<for|{ a }| of=xs by="id"><for|q| of=ys by="id"><li>\${a}\${q.z}</li></for></for>`,
    );
    expect(code).toContain("{mxRow().a}");
    expect(code).toContain("{q().z}");
    expect(code).not.toContain("q()()");
  });

  it("gives each nested destructured row its own bound gensym", () => {
    const code = mx(
      `<for|{ a }| of=xs by="id"><for|{ b }| of=ys by="id"><li>\${a}\${b}</li></for></for>`,
    );
    // Every gensym read must be a parameter the emitted code actually binds.
    for (const name of new Set(
      [...code.matchAll(/\b(mxRow\d*)\(\)/g)].map((m) => m[1]),
    )) {
      expect(code).toContain(`{(${name})`);
    }
  });

  it("keeps plain-identifier nesting working (regression guard)", () => {
    const code = mx(
      `<for|p| of=xs by="id"><for|q| of=ys by="id"><li>\${p.a}\${q.z}</li></for></for>`,
    );
    expect(code).toContain("{p().a}{q().z}");
    expect(code).not.toContain("()()");
  });
});

describe("Solid <for>: accessor-backed params are not assignable", () => {
  it("rejects assigning an accessor-backed row", () => {
    expect(() =>
      compileSolidMx(`<for|p| of=people by="id"><li>\${(p = 1)}</li></for>`, {
        filename: "fixture.solid.mx",
      }),
    ).toThrow(/cannot be assigned/);
  });

  it("rejects updating an accessor-backed index", () => {
    expect(() =>
      compileSolidMx(`<for|p, i| of=people><li>\${i++}</li></for>`, {
        filename: "fixture.solid.mx",
      }),
    ).toThrow(/cannot be assigned/);
  });

  // Round 1 item 3: a pattern target binds the name just as `p = x` does.
  it("rejects an array-pattern assignment to an accessor-backed row", () => {
    expect(() =>
      compileSolidMx(
        `<for|p| of=people by="id"><li>\${([p] = arr)}</li></for>`,
        {
          filename: "fixture.solid.mx",
        },
      ),
    ).toThrow(/cannot be assigned/);
  });

  it("rejects an object-pattern assignment to an accessor-backed row", () => {
    expect(() =>
      compileSolidMx(
        `<for|p| of=people by="id"><li>\${({ p } = o)}</li></for>`,
        {
          filename: "fixture.solid.mx",
        },
      ),
    ).toThrow(/cannot be assigned/);
  });

  // Round 1 item 4: these used to hit a Babel assertion rather than a
  // diagnostic, because the loop target was rewritten into a call.
  it("rejects a for-of loop assigning to an accessor-backed row", () => {
    expect(() =>
      compileSolidMx(
        `<for|p| of=people by="id"><li>\${(() => { for (p of arr) {} })()}</li></for>`,
        { filename: "fixture.solid.mx" },
      ),
    ).toThrow(/cannot be assigned/);
  });

  it("rejects a for-in loop assigning to an accessor-backed row", () => {
    expect(() =>
      compileSolidMx(
        `<for|p| of=people by="id"><li>\${(() => { for (p in o) {} })()}</li></for>`,
        { filename: "fixture.solid.mx" },
      ),
    ).toThrow(/cannot be assigned/);
  });

  it("allows a for-of declaring its own binding over the row", () => {
    expect(() =>
      compileSolidMx(
        `<for|p| of=people by="id"><li>\${(() => { for (const q of p.xs) {} })()}</li></for>`,
        { filename: "fixture.solid.mx" },
      ),
    ).not.toThrow();
  });

  it("allows assigning through an accessor-backed row", () => {
    // `p.count = 1` mutates the row object, which is not an assignment to the
    // binding and stays legal.
    expect(() =>
      compileSolidMx(
        `<for|p| of=people by="id"><li>\${(p.count = 1)}</li></for>`,
        { filename: "fixture.solid.mx" },
      ),
    ).not.toThrow();
  });

  it("renders a stepped range", () => {
    const html = renderApp(
      `<for|n| from=0 to=6 step=2><li>value \${n}</li></for>`,
      "",
    );
    expect(html).toContain("value 0");
    expect(html).toContain("value 2");
    expect(html).toContain("value 4");
    expect(html).toContain("value 6");
  });
});

/**
 * A dynamic tag's target is polymorphic at run time (a tag-name string, a
 * component function, or already-rendered content passed straight through)
 * — the same guard `@mxlang/html`'s `renderDynamic` and `@mxlang/preact`'s
 * inlined `mxDynamic` apply, since Solid's own `<Dynamic component=…>` only
 * accepts a string or a component and throws on a rendered node.
 */
describe("Solid SSR render: dynamic tag", () => {
  it("renders a string target as an element with that tag name", () => {
    const html = renderApp(
      `<\${input.tag} class="x">hi</>`,
      `const input = { tag: "span" };`,
    );
    expect(html).toContain('class="x"');
    expect(html).toContain("<span");
    expect(html).toContain(">hi</span>");
  });

  it("renders a function target as a component", () => {
    const html = renderApp(
      `<\${input.tag} n=1/>`,
      `function Comp(props) { return <em>{props.n}</em>; }\nconst input = { tag: Comp };`,
    );
    expect(html).toContain("<em>1</em>");
  });

  it("passes already-rendered content straight through, rather than treating it as a component", () => {
    const html = renderApp(
      `<div><\${input.content}/></div>`,
      `const input = { content: <em>already rendered</em> };`,
    );
    expect(html).toContain("<div><em>already rendered</em></div>");
  });

  // Decision 109, Marko parity: args now combine with a body/attribute tag
  // (`assertAttributesOrArgs`; `rejectArgsWithProps`, core). Solid's own
  // design already keeps args and attrs/tags/content orthogonal — args only
  // resolve the value handed to `<Dynamic component=…>`, while attrs/tags/
  // content render on that element regardless of args — so this needs no
  // emitter change, only core's relaxed guard.
  it("accepts arguments combined with a body (decision 109, Marko parity)", () => {
    // Solid's `<Dynamic component={…}>body</Dynamic>` forwards a JSX body as
    // the resolved component's ordinary `children` prop, not a `content`
    // callback — unlike html/preact's `content: () => …` convention.
    const html = renderApp(
      `<\${input.render}("x", 2)>body</>`,
      `const input = { render: (a: string, b: number) => (props: { children?: unknown }) => <em>{a}-{b}-{props.children}</em> };`,
    );
    expect(html).toContain("x-2-body");
  });

  it("accepts arguments combined with an attribute tag (decision 109, Marko parity)", () => {
    const html = renderApp(
      `<\${input.render}("x", 2)><@head>H</@head></>`,
      `const input = { render: (a: string, b: number) => (extra?: { head?: unknown }) => <em>{a}-{b}-{extra?.head as never}</em> };`,
    );
    expect(html).toContain("x-2-H");
  });

  it("still rejects arguments combined with a plain attribute", () => {
    expect(() =>
      renderApp(
        `<\${input.render}("x") foo="bar"/>`,
        `const input = { render: (a: string) => () => <em>{a}</em> };`,
      ),
    ).toThrow();
  });

  // Decision 112 (lead ruling 2026-09-28): disjoint from decision 109, which
  // governs only a function/component target. A *string* target called with
  // arguments uses args[0] as its element attributes, matching Marko's own
  // `_dynamic_tag` (`runtime-tags/src/html/dynamic-tag.ts`) and the fix
  // already applied to html's `renderDynamic` and the shared JSX `mxDynamic`.
  describe("string target with arguments (decision 112, Marko parity)", () => {
    it("uses args[0] as the element's attributes", () => {
      const html = renderApp(
        `<\${input.tag}({ id: "x", class: "y" })/>`,
        `const input = { tag: "span" };`,
      );
      expect(html).toContain('id="x"');
      expect(html).toContain('class="y"');
      expect(html).toContain("<span");
    });

    it("ignores extra arguments beyond args[0]", () => {
      const html = renderApp(
        `<\${input.tag}({ id: "x" }, "unused", 123)/>`,
        `const input = { tag: "span" };`,
      );
      expect(html).toContain('id="x"');
      expect(html).not.toContain("unused");
    });

    it("treats a null/undefined args[0] as no attributes", () => {
      const html = renderApp(
        `<\${input.tag}(input.missing)/>`,
        `const input = { tag: "span", missing: undefined };`,
      );
      expect(html).toMatch(/<span[^>]*><\/span>/);
      expect(html).not.toContain('id="');
    });

    it("does not fold decision 109's attribute-tag props into args[0], but content still renders", () => {
      // Attribute tags are dropped as attributes (Marko never reads them as
      // args[0] here — see spec §15 item 11), but content renders regardless,
      // since Marko threads it independently of the input.
      const html = renderApp(
        `<\${input.tag}({ id: "x" })><@head>H</@head>body</>`,
        `const input = { tag: "span" };`,
      );
      expect(html).toContain('id="x"');
      expect(html).toContain(">body</span>");
      expect(html).not.toContain("H");
    });

    it("still calls a function target positionally, unaffected by the string-target rule", () => {
      const html = renderApp(
        `<\${input.render}("x", 2)/>`,
        `const input = { render: (a: string, b: number) => () => <em>{a}-{b}</em> };`,
      );
      expect(html).toContain("x-2");
    });
  });

  // Decision 116: a capitalized tag bound to a value import that is not a
  // `.marko`/`.mx` default import lowers as a dynamic tag — the same
  // `<Dynamic>` dispatch the authored `<${expr}>` tests above exercise,
  // reached instead through an ordinary `import { X } from "./x.ts"` and
  // an ordinary `<X>`/`<X/>` call. Executed through the same real Solid
  // SSR pipeline (`renderApp` -> `@solidjs/babel-plugin` -> `@solidjs/web`
  // `renderToString`), proving the routing dispatches the way `<Dynamic>`
  // actually resolves a value at runtime.
  describe("value import used as a tag (decision 116)", () => {
    // Decision 116 is scoped to *import* bindings — a module-scope
    // declaration (`const Tag = "div"`, a local `function`) is never an
    // import, so every case here uses `renderAppWithImport`, a real
    // sibling `.ts` file and a real `import`, not `renderApp`'s
    // `setup`-string (module-scope) shape. See `index.test.ts`'s "a
    // module-scope local function ... still compiles to a direct JSX
    // call" for the unaffected case.
    it("a string value import renders as a real element", () => {
      const html = renderAppWithImport(
        '<Tag name="1">body</Tag>\n<Tag/>',
        "Tag",
        'export const Tag = "div";',
      );
      // Solid's SSR output carries its own hydration-key attribute
      // (`_hk=`), unrelated to this assertion — checked structurally
      // rather than by exact string.
      expect(html).toMatch(/<div[^>]* name="1"[^>]*>body<\/div>/);
      expect(html).toMatch(/<div[^>]*><\/div>/);
    });

    it("a plain function value import is called as a host component (intentional Marko divergence)", () => {
      const html = renderAppWithImport(
        '<Comp name="1"/>',
        "Comp",
        "export function Comp(props: { name?: string }) { return <em>{props.name}</em>; }",
      );
      expect(html).toContain("<em>1</em>");
    });

    it("undefined renders only the tag's body content, matching Marko", () => {
      const html = renderAppWithImport(
        '<Missing name="1">body</Missing>',
        "Missing",
        "export const Missing = undefined;",
      );
      expect(html).toBe("<ul>body</ul>");
    });

    it("null renders only the tag's body content, matching Marko", () => {
      const html = renderAppWithImport(
        '<Nul name="1">body</Nul>',
        "Nul",
        "export const Nul = null;",
      );
      expect(html).toBe("<ul>body</ul>");
    });
  });

  // Firstmate's extension of decision 116 (`notes/decisions-2026-09-10.md`):
  // a non-import local (a module-scope `const`/`function`/`class`, or a tag
  // param) whose value core cannot statically prove is a function/arrow/
  // class also lowers through `<Dynamic>`. `renderApp`'s `setup` string is
  // always module-scope, never an import, so it is the right vehicle for
  // this — unlike decision 116's own import-scoped tests above, which need
  // `renderAppWithImport`.
  describe("local-value-as-tag-parity: non-import local used as a tag", () => {
    it("a module-scope const string is unknown and renders as a real element", () => {
      const html = renderApp('<Tag name="1">body</Tag>', 'const Tag = "div";');
      expect(html).toMatch(/<div[^>]* name="1"[^>]*>body<\/div>/);
    });

    it("a module-scope arrow-function const stays a direct component call", () => {
      const html = renderApp(
        "<Comp n=1/>",
        "const Comp = (props: { n: number }) => <em>{props.n}</em>;",
      );
      expect(html).toContain("<em");
      expect(html).toContain("1");
    });

    it("a conditional string-or-component local is unknown and routes through Dynamic", () => {
      const html = renderApp(
        "<Tag/>",
        [
          "function A() { return <span>a</span>; }",
          "function B() { return <span>b</span>; }",
          "const useA = true;",
          "const Tag = useA ? A : B;",
        ].join("\n"),
      );
      expect(html).toContain("<span");
      expect(html).toContain(">a<");
    });

    it("a module-scope const bound to a call result (unknown) routes through Dynamic", () => {
      // A Solid *region* rejects `<const>` unconditionally — it is a JSX
      // expression with no statement position, so `<const>` can never be
      // emitted there regardless of decision 116 (a pre-existing,
      // Solid-only limitation; see `SolidEmitter.constant`). The
      // module-scope form exercises the identical classification: `Tag`'s
      // value is a call result, "unknown" whichever binding site declares
      // it.
      const html = renderApp(
        '<Tag name="1">body</Tag>',
        'function make() { return "div"; }\nconst Tag = make();',
      );
      expect(html).toMatch(/<div[^>]* name="1"[^>]*>body<\/div>/);
    });

    // Firstmate's follow-up on decision 116: Solid's own `lazy(...)` returns
    // a real FUNCTION (measured, `typeof lazy(...) === "function"`), unlike
    // React's `memo`/`forwardRef` (see `@mxlang/react`'s sibling suite,
    // which needed a fix for those). A `lazy(...)` call is a
    // `CallExpression`, always classified "unknown" by `isFunctionLikeValue`,
    // so it already routes through `<Dynamic>` — and Solid's own `<Dynamic
    // component={...}>` accepts any callable component reference
    // generically, with no `typeof` gate of its own the way
    // `@mxlang/preact`'s `mxDynamic` needed widening. No fix required on
    // this host. Not covered by an executed SSR test here: real
    // `renderToString` of a `lazy(...)` component needs a `<Suspense>`
    // boundary to resolve the async loader, which `renderApp`'s helper does
    // not currently wire up — out of scope for this "if cheap" follow-up
    // (confirmed cheap only for the `typeof` fact above, not for full
    // Suspense-aware SSR test infra).
  });
});

/**
 * JSX-significant characters in authored text (the `jsx-text-lt-unescaped`
 * bug): the emitter must escape `<`, `>`, and braces so the *generated* JSX
 * parses, and the real Solid SSR render must produce the same DOM text
 * Marko does (`a < b` is text in Marko; the pre-fix emitter copied it
 * verbatim into the JSX, which failed downstream parsing).
 */
describe("Solid SSR render: JSX-significant text characters", () => {
  it("renders a bare `<` in text as text, like Marko", () => {
    // Solid's serializer escapes the decoded `<` numerically; parse5-decoded
    // (the oracle's comparison), both forms equal Marko's `a < b`.
    expect(renderApp("<li>a < b</li>", "")).toBe("<ul><li>a &#60; b</li></ul>");
  });

  it("renders `>`, braces, and a literal ampersand like Marko", () => {
    expect(renderApp("<li>a > b</li>", "")).toBe("<ul><li>a &#62; b</li></ul>");
    expect(renderApp("<li>a {b} c</li>", "")).toBe(
      "<ul><li>a &#123;b&#125; c</li></ul>",
    );
    expect(renderApp("<li>a & b</li>", "")).toBe("<ul><li>a & b</li></ul>");
  });

  it("renders authored entities as the decoded character, like Marko's browser parse", () => {
    expect(renderApp("<li>&lt;a&gt; &amp; b</li>", "")).toBe(
      "<ul><li>&lt;a&gt; &amp; b</li></ul>",
    );
  });
});
