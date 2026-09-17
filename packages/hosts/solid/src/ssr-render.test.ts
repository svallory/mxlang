import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
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
function renderSolidMx(mxFragment: string, setup: string): string {
  const { code: forCode } = compileSolidMx(mxFragment, {
    filename: "fixture.solid.mx",
  });
  const jsxSource = `import { createSignal } from "solid-js";\nexport function App() {\n  ${setup}\n  return <ul>${forCode}</ul>;\n}\n`;

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
function renderApp(mxFragment: string, setup: string): string {
  const code = renderSolidMx(mxFragment, setup);
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
});
