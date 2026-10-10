import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CustomTag, TemplateBackedTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";
import { brandRender } from "./translate.ts";

/**
 * Per-rule tests for the stock-Marko translator.
 *
 * Two things are pinned here that the fixtures cannot pin. The fixtures assert
 * rendered HTML for constructs that *work*; these assert the policy table of
 * decision 65 — which constructs are accepted with no output (inert), which
 * are errors because the target genuinely cannot express them, and the
 * conventions that differ from `@mxlang/target-html`'s dialect.
 *
 * The distinction the table turns on: a construct that only configures
 * behaviour after the first render is inert, and one that contributes output
 * bytes must lower. "My code cannot do this" is never a row.
 */

const src = (body: string) => (body.endsWith("\n") ? body : `${body}\n`);
const file = "/tmp/mx-translator-test/probe.marko";

async function renderModules(
  sources: Record<string, string>,
  entry: string,
  input: unknown = {},
  strictTypecheck = false,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mx-html-render-"));
  try {
    for (const [name, source] of Object.entries(sources)) {
      writeFileSync(join(dir, name), src(source));
    }
    const writeRuntime = (lean: boolean) =>
      writeFileSync(
        join(dir, "runtime.ts"),
        (lean
          ? [
              // tsc only needs signatures. Re-exporting from the real entry
              // points makes every strict run typecheck the whole host + core
              // graph (~220 files): ~3x the wall time, past vitest's 5 s
              // default under load. `fixtures/lean-runtime.check.ts` guards
              // the stub against drift from the real names.
              `export * from ${JSON.stringify(fileURLToPath(new URL("./fixtures/lean-runtime.ts", import.meta.url)))};`,
            ]
          : [
              // `escape.ts`, not core's index: the index's source graph
              // includes the MX front end and its vendored Babel (port PR 5),
              // whose first load passed vitest's 5 s under a full run.
              `export { escape } from ${JSON.stringify(fileURLToPath(new URL("../../../core/src/escape.ts", import.meta.url)))};`,
              `export { createBufferedOut, createOut } from ${JSON.stringify(fileURLToPath(new URL("./runtime.ts", import.meta.url)))};`,
              `export type { AttrTag } from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))};`,
            ]
        ).join("\n"),
      );
    writeRuntime(strictTypecheck);
    for (const [name, source] of Object.entries(sources)) {
      if (!name.endsWith(".mx")) continue;
      const path = join(dir, name);
      const code = compile(src(source), path)
        .code.replaceAll('from "@mxlang/target-html"', 'from "./runtime.ts"')
        .replace(/(from\s+")(\.[^"]+)\.mx(")/g, "$1$2.ts$3");
      writeFileSync(path.replace(/\.mx$/, ".ts"), code);
    }
    if (strictTypecheck) {
      try {
        execFileSync(
          fileURLToPath(
            new URL("../../../../node_modules/.bin/tsc", import.meta.url),
          ),
          [
            "--pretty",
            "false",
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--types",
            "node",
            "--typeRoots",
            fileURLToPath(
              new URL("../../../../node_modules/@types", import.meta.url),
            ),
            "--target",
            "ES2022",
            "--module",
            "ESNext",
            "--moduleResolution",
            "Bundler",
            "--allowImportingTsExtensions",
            join(dir, entry.replace(/\.mx$/, ".ts")),
          ],
          { cwd: dir, stdio: "pipe" },
        );
      } catch (error) {
        const failed = error as { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
          [failed.stdout?.toString(), failed.stderr?.toString()]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }
    if (strictTypecheck) writeRuntime(false);
    const module = (await import(
      `${pathToFileURL(join(dir, entry.replace(/\.mx$/, ".ts"))).href}?t=${Date.now()}`
    )) as { default: (value: unknown) => string };
    return module.default(input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("generated names do not shadow authored bindings", () => {
  it.each([
    ["escape", "<p>${input.text}</p>", "<p>&lt;x&gt;</p>"],
    ["classValue", "<p class=input.classes/>", '<p class="on"></p>'],
    ["styleValue", "<p style=input.styles/>", '<p style="color:red"></p>'],
    [
      "escapeComment",
      "<html-comment>${input.text}</html-comment>",
      "<!--<x&gt;-->",
    ],
    ["renderDynamic", "<${input.tag}>ok</>", "<p>ok</p>"],
    ["out", "<p>ok</p>", "<p>ok</p>"],
    ["value", "<p class=value/>", '<p class="1"></p>'],
    ["$for2", "<for|x| of=[$for2]><p>${x}</p></for>", "<p>1</p>"],
  ])("renders with an authored %s", async (name, markup, expected) => {
    expect(
      await renderModules(
        { "page.mx": `<const/${name}=1/>\n${markup}` },
        "page.mx",
        {
          text: "<x>",
          classes: { on: true },
          styles: { color: "red" },
          tag: "p",
        },
      ),
    ).toBe(expected);
  });
});

describe("reserved attribute writer after #294", () => {
  it("preserves direct, merged, spread and dynamic native behavior", async () => {
    const body = [
      '<const/text="on"/>',
      '<const/key="id"/>',
      '<const/value="safe"/>',
      '<const/attrs={ class: { [text]: true }, style: { color: "red" }, title: null }/>',
      '<const/target="input"/>',
      "<input title=null value=value checked=0/>",
      "<p class={ [text]: true } ...attrs id=value/>",
      "<p ...attrs/>",
      "<${target} ...attrs value=value checked=0/>",
    ].join("\n");
    expect(await renderModules({ "page.mx": body }, "page.mx")).toBe(
      '<input value="safe" checked><p id="safe" class="on" style="color:red"></p><p class="on" style="color:red"></p><input class="on" style="color:red" value="safe" checked="0">',
    );

    const { code } = compile(src(body), file);
    for (const name of [
      "__mxCapturedValue",
      "__mxKey",
      "__mxValue",
      "__mxText",
      "__mxRenderAttr",
      "__mxClassValue",
      "__mxStyleValue",
      "__mxRenderDynamic",
    ]) {
      expect(code).toContain(name);
    }
    expect(code).not.toMatch(/\bout\s*\+=|\bconst text\s*=\s*key/);
  });

  it("does not shadow an authored _error in a parameterless catch", async () => {
    expect(
      await renderModules(
        {
          "page.mx":
            '<const/_error="outer"/>\n<try><${input.fail}/><@catch><p>${_error}</p></@catch></try>',
        },
        "page.mx",
        {
          fail() {
            throw new Error("boom");
          },
        },
      ),
    ).toBe("<p>outer</p>");
  });
});

describe("an inert tag is inert only in its declared shape", () => {
  // Inert means the construct emits nothing — never that a body or an extra
  // attribute may be discarded. `<effect><div>x</div></effect>` compiled clean
  // with the `<div>` gone before this rule existed: a successful compile that
  // silently deleted authored markup, the S8 failure class the field guard
  // exists to close. Marko itself rejects both shapes.
  // `<effect>` is the tag that actually reaches this guard. `<log>`, `<debug>`,
  // `<id>` and `<lifecycle>` are `openTagOnly` in Marko's own definition, so a
  // body on those is a parse error before any translator runs — the guard
  // still declares `body: "none"` for them, for a taglib that omits that parse
  // option, but the reachable case to pin is this one.
  it("rejects a body on <effect>", () => {
    expect(() =>
      compile(src("<effect() { go() }><div>inside</div></effect>"), file),
    ).toThrow(/`<effect>` does not support body content/);
  });

  it("rejects an unexpected attribute on <effect>", () => {
    expect(() => compile(src('<effect foo="bar"/>'), file)).toThrow(
      /`<effect>` does not support the `foo` attribute/,
    );
  });

  it("accepts the attributes a tag's own definition allows", () => {
    // Per tag, not uniform, because Marko is: `<lifecycle foo="bar"/>`
    // compiles there while `<effect foo="bar"/>` does not — a lifecycle tag's
    // attributes are its configuration.
    const { code } = compile(
      src('<p>a</p>\n<lifecycle onMount() { } foo="bar"/>'),
      file,
    );
    expect(code).toContain('__mxOut.write("<p>a</p>")');
  });

  it("rejects a spread on an inert tag", () => {
    expect(() => compile(src("<effect ...input.attrs/>"), file)).toThrow(
      /spread attributes on `<effect>` are not supported/,
    );
  });

  it("still accepts <script>'s raw-text body, which Marko declares", () => {
    // `text: true` in Marko's own tag definition: the body is client script
    // source, genuinely consumed and genuinely emitting nothing.
    const { code } = compile(
      src("<script>console.log(1)</script>\n<p>a</p>"),
      file,
    );
    expect(code).toContain('__mxOut.write("<p>a</p>")');
    expect(code).not.toContain("console.log");
  });
});

describe("class:foo / style:foo modifiers", () => {
  // Marko 5.42.5 has no such modifier: its own parser rejects every form
  // ("`class:active` is not a valid attribute, did you mean
  // `class={ active: condition }`?"), so matching Marko means rejecting them.
  // The message must be this dialect's own — the shared core's fallback is
  // `@mxlang/target-html`'s "standalone template" wording, which is `.mx` vocabulary
  // leaking into a Marko-parity target.
  it.each([
    ["class:active", "<div class:active=input.on>a</div>"],
    ["style:color", '<div style:color="red">d</div>'],
  ])("rejects %s with Marko's own guidance", (_name, body) => {
    expect(() => compile(src(body), file)).toThrow(
      /is not a valid attribute, did you mean/,
    );
    expect(() => compile(src(body), file)).not.toThrow(/standalone template/);
  });
});

describe("bindings may not shadow the input parameter", () => {
  // The emitted module is `function (input: Input)`, so a `const input = …`
  // inside it makes the template's own input unreachable with no diagnostic.
  // Marko rejects the same thing ("Duplicate declaration of `input`").
  it.each([
    ["let", "<let/input=1/>"],
    ["const", "<const/input=1/>"],
  ])("rejects <%s> binding `input`", (_name, body) => {
    expect(() => compile(src(body), file)).toThrow(
      /collides with the template input parameter/,
    );
  });

  // A tag param is a *nested* scope — a `for (const … of …)` head, an arrow's
  // parameter list — so an ordinary JS shadow is correct there and the
  // template's own input stays reachable outside the loop. Marko draws the
  // same line: it renders `<for|input|>` and rejects `<let/input>`. Rejecting
  // the param form would be an implementation limit stated as a rule, which
  // decision 65 forbids.
  it.each([
    ["for", "<for|input| of=input.items><p>${input}</p></for>"],
    ["for with index", "<for|input, i| of=input.items><p>${input}</p></for>"],
    ["define", '<define/Row|input|><li>${input}</li></define>\n<Row("a")/>'],
  ])("shadows `input` in a %s tag param, as Marko does", (_name, body) => {
    expect(() => compile(src(body), file)).not.toThrow();
  });

  it("leaves any other binding name alone", () => {
    const { code } = compile(src("<for|item| of=[1,2]><p>y</p></for>"), file);
    expect(code).toContain("for (const item of");
  });

  it("emits a real function for <define>, not a stringified MappedCode object", () => {
    // `blockFunction()` returns a `{ code, mappings }` object; interpolating
    // it directly into a template string (`` `const ${node.name} = ${fn};` ``)
    // stringifies to `const Row = [object Object];` — syntactically valid JS,
    // so `compile()` does not throw and every `<define>` call breaks silently
    // at render time instead. Pins the actual emitted text so a recurrence
    // fails here rather than only in oracle:marko's HTML-rendering comparison.
    const { code } = compile(
      src('<define/Row|it|><li>${it}</li></define>\n<Row("a")/>'),
      file,
    );
    expect(code).not.toContain("[object Object]");
    expect(code).toMatch(/const Row = \(it\) => \{/);
  });

  it("carries an attribute tag through a `<define>` call instead of dropping it", async () => {
    // `<define>` has no declared `Input`, so decision 108's untyped-callee
    // fallback applies: `<@head>` carries no attributes, so `head` arrives
    // renderable (the body itself), read directly with `<${head}/>`. The call
    // passes one attribute object (decision 160), so the define destructures it.
    const html = await renderModules(
      {
        "entry.mx":
          '<define/Card|{ title, head }|><div>${title}<${head}/></div></define>\n<Card title="a"><@head>H</@head></Card>',
      },
      "entry.mx",
    );
    expect(html).toBe("<div>aH</div>");
  });

  it("accepts a `<define>` call mixing tag-argument form with an attribute tag (decision 109, Marko parity)", async () => {
    // `<Card('a')>` passes `title` positionally; `<@head>` rides along as
    // Marko's own "dynamic tag fallback content" — `assertAttributesOrArgs`
    // rejects only a plain attribute alongside args, not a body/attribute
    // tag. `title` is a define param bound positionally, so it does not
    // also appear as a named prop; `head` is the trailing props object.
    const html = await renderModules(
      {
        "entry.mx":
          "<define/Card|title, head|><div>${title}<${head}/></div></define>\n<Card('a')><@head>H</@head></Card>",
      },
      "entry.mx",
    );
    expect(html).toBe("<div>aH</div>");
  });

  it("accepts a `<define>` call mixing tag-argument form with a body (decision 109, Marko parity)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          "<define/Card|title, content|><div>${title}<${content}/></div></define>\n<Card('a')>body</Card>",
      },
      "entry.mx",
    );
    expect(html).toBe("<div>abody</div>");
  });

  it("still rejects a `<define>` call mixing tag-argument form with a plain attribute", () => {
    expect(() =>
      compile(
        src(
          "<define/Card|title|><div>${title}</div></define>\n<Card('a') foo=\"bar\"/>",
        ),
        file,
      ),
    ).toThrow("Tag does not support arguments when attributes present.");
  });
});

describe("<html-comment> lowers placeholders", () => {
  it("emits interpolated values rather than dropping them", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "<html-comment>build ${input.sha}</html-comment>";
    const { code } = compile(src(body), file);
    expect(code).toContain("__mxEscapeComment(input.sha, true)");
    expect(code).toContain("function __mxEscapeComment");
  });

  it("falls back to a space only when the comment has no static text", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const only = compile(
      src("<html-comment>${input.a}${input.b}</html-comment>"),
      file,
    ).code;
    expect(only).toContain(
      '(__mxEscapeComment(input.a, true) + __mxEscapeComment(input.b, true)) || " "',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const mixed = compile(
      src("<html-comment>a ${input.a}</html-comment>"),
      file,
    ).code;
    expect(mixed).not.toContain('|| " "');
  });

  it("passes the raw flag for $!{} so `>` stays unescaped", () => {
    const { code } = compile(
      src("<html-comment>$!{input.a}</html-comment>"),
      file,
    );
    expect(code).toContain("__mxEscapeComment(input.a, false)");
  });

  it("escapes only `>`, as Marko's own _escape_comment does", () => {
    const body = "<html-comment>a > b < c & d</html-comment>";
    const { code } = compile(src(body), file);
    expect(code).toContain("a &gt; b < c & d");
  });

  it("treats markup inside a comment as text, as Marko's taglib declares", () => {
    // `<html-comment>` is `text: true` in Marko's own definition, so a `<div>`
    // in there never becomes a tag — it is comment text, escaped by the same
    // `>`-only rule. The translator's "only text and placeholders" guard still
    // stands for a taglib that omits that parse option, but this is the
    // behaviour a stock `.marko` file actually gets.
    const body = "<html-comment>x<div>y</div></html-comment>";
    expect(compile(src(body), file).code).toContain(
      "<!--x<div&gt;y</div&gt;-->",
    );
  });
});

describe("inert constructs (decision 65): accepted, no output", () => {
  // Each was verified against Marko's own server render: the emitted HTML is
  // byte-identical with and without the construct. Rejecting them would be an
  // implementation limit dressed as a rule.
  it.each([
    ["effect", "<p>a</p>\n<effect() { go() }/>"],
    ["lifecycle", "<p>a</p>\n<lifecycle onMount() { }/>"],
    ["script", "<p>a</p>\n<script>console.log(1)</script>"],
    ["log", "<p>a</p>\n<log=1/>"],
    ["debug", "<p>a</p>\n<debug/>"],
  ])("accepts <%s> with no emitted output", (_name, body) => {
    const { code } = compile(src(body), file);
    expect(code).toContain('__mxOut.write("<p>a</p>")');
    expect(code).not.toContain("console.log");
  });

  it("accepts by= on <for> with no effect on the output", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const withBy = '<for|it| of=input.items by="id"><li>${it}</li></for>';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const without = "<for|it| of=input.items><li>${it}</li></for>";
    expect(compile(src(withBy), file).code).toBe(
      compile(src(without), file).code,
    );
  });

  it("rejects step= on <for>: the core carries it for Solid's <Repeat>, this host has no computed-array lowering", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "<for|i| from=0 to=3 step=2><p>${i}</p></for>";
    expect(() => compile(src(body), file)).toThrow(
      "`<for step=...>`: step is not supported; use a computed array",
    );
  });
});

describe("statement blocks", () => {
  it("runs a `server` block and hoists it, as Marko does", () => {
    // Verified against Marko: a server block runs during a server render and
    // its bindings are readable from the template. Classifying it as inert
    // would silently drop a binding the rest of the template reads.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "server const S = 41 + 1\n<p>${S}</p>";
    const { code } = compile(src(body), file);
    expect(code).toContain("const S = 41 + 1");
    expect(code.indexOf("const S = 41 + 1")).toBeLessThan(
      code.indexOf("function Probe(input: Input): string {"),
    );
    expect(code).toContain("__mxEscape(S)");
  });

  // This host used to reject `<return>` outright, on the grounds that "a
  // module compiled to `(input) => string` has no parent to return to". That
  // was true only while a tag template was expanded into its caller. Under
  // the unit model (decision 95) every `.mx` file is a module and a caller
  // invokes it, so the tag has somewhere to return to — and a *page* is not
  // a special case: it is a module that returns a value nobody reads yet.
  it("accepts <return> in a page, with the same meaning as in a tag", () => {
    const { code } = compile(src("<p>x</p>\n<return=42/>"), file);

    // Decision 155: the value is `render`'s return value; the output went
    // to the sink.
    expect(code).toContain("  return 42;\n}\nexport { __mxRender as render };");
  });
});

describe("evaluate-initial-value constructs (decision 65)", () => {
  it("<let> binds its initial value", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const { code } = compile(src("<let/count=5/>\n<p>${count}</p>"), file);
    expect(code).toContain("const count = 5;");
    expect(code).toContain("__mxEscape(count)");
  });

  it("<const> binds its value", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "<const/dbl=2 * 3/>\n<p>${dbl}</p>";
    expect(compile(src(body), file).code).toContain("const dbl = 2 * 3;");
  });

  it(":= binds to the initial value, with no update path", () => {
    const body = '<let/v="hi"/>\n<input value:=v>';
    const { code } = compile(src(body), file);
    expect(code).toContain('const v = "hi";');
    expect(code).toContain(`__mxRenderAttr("value", v, "input")`);
  });
});

describe("error constructs: the target genuinely cannot express them", () => {
  it("rejects <await>, naming why a synchronous render cannot", () => {
    const body = "<await|v| =input.p><p>${v}</p></await>";
    expect(() => compile(src(body), file)).toThrow(/`<await>` suspends/);
  });

  it("rejects <try> with a <@placeholder>", () => {
    const body =
      "<try><p>b</p><@placeholder><p>loading</p></@placeholder></try>";
    expect(() => compile(src(body), file)).toThrow(/second render pass/);
  });
});

describe("a type-only import does not resolve a tag (decision 114 parity)", () => {
  // `import type Widget from "./widget.mx"` binds no runtime value, so
  // `<Widget/>` must be Marko's own unresolved-tag error — matching
  // `@mxlang/tsx-bridge`'s `programBindings`, which already excludes type-only
  // bindings for the `.solid.mx` region path (see
  // `packages/hosts/solid/src/index.test.ts`, "still rejects a capitalized
  // tag bound only by a type-only import"). Before this fix, core's own
  // `importBindings` (whole-file `.mx`, every host) never checked
  // `importKind`, so a whole `import type` bound `Widget` the same as a
  // value import and `<Widget/>` silently compiled as a component call to a
  // name erased before the module runs (a runtime `ReferenceError`).
  it("errors on a whole `import type` used as a tag", () => {
    const body = `import type Widget from "./widget.mx"\n<Widget/>`;
    expect(() => compile(src(body), file)).toThrow(
      /Unable to find entry point for.*custom tag.*<Widget>/s,
    );
  });

  it("errors on an inline `{ type X }` specifier used as a tag", () => {
    const body = `import { type Widget } from "./widget.mx"\n<Widget/>`;
    expect(() => compile(src(body), file)).toThrow(
      /Unable to find entry point for.*custom tag.*<Widget>/s,
    );
  });

  it("still resolves an ordinary value import as a tag", async () => {
    const html = await renderModules(
      {
        "widget.mx": `<p>widget</p>`,
        "page.mx": `import Widget from "./widget.mx"\n<Widget/>`,
      },
      "page.mx",
    );
    expect(html).toBe("<p>widget</p>");
  });
});

/**
 * Decision 155, the Marko render model: a unit writes into its caller's sink
 * through `render(input, out)` and `<return>` is `render`'s return value, so a
 * caller that only holds the default export (a dynamic tag, a `.ts` barrel
 * re-export) still renders the body and can bind the value.
 */
describe("the render sink (decision 155)", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
  const counter = [
    "export interface Input { start: number }",
    "<span>${input.start}</span>",
    "<return value=input.start + 1/>",
  ].join("\n");
  const hello = [
    "export default function Hello(input: { name: string }): string {",
    '  return "<b>" + input.name + "</b>";',
    "}",
  ].join("\n");

  // TODO dynamic-tag-return-unit-object-object: this rendered
  // `<div>[object Object]</div>`. Marko 6.3.51 renders the body and drops the
  // value.
  it("renders a returning unit reached through a dynamic tag", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "page.mx":
          'import Counter from "./counter.mx"\n<div><${Counter} start=1/></div>',
      },
      "page.mx",
      {},
      true,
    );
    expect(html).toBe("<div><span>1</span></div>");
  });

  it("renders a returning unit passed in as input to a dynamic tag", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "page.mx": "<div><${input.tag} start=3/></div>",
        "probe.ts": [
          'import Counter from "./counter.ts";',
          'import Page from "./page.ts";',
          "export default () => Page({ tag: Counter });",
        ].join("\n"),
      },
      "probe.ts",
    );
    expect(html).toBe("<div><span>3</span></div>");
  });

  // TODO dynamic-tag-return-unit-object-object, barrel half: the resolver
  // does not follow a `.ts` re-export, so the call site cannot know the
  // callee's shape; `.render` is found at run time instead.
  it("renders a returning unit re-exported through a .ts barrel", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "barrel.ts": 'export { default as Counter } from "./counter.ts";',
        "page.mx":
          'import { Counter } from "./barrel.ts"\n<div><Counter start=4/></div>',
      },
      "page.mx",
      {},
      true,
    );
    expect(html).toBe("<div><span>4</span></div>");
  });

  // Binds since decision 155's sink; the TODO `dynamic-tag-var-silent-drop`
  // on html is closed here (the oracle fixture is
  // `fixtures-marko/dynamic-tag-var`).
  it("binds /var on a dynamic tag to the callee's render value", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "page.mx":
          'import Counter from "./counter.mx"\n<${Counter}/n start=1/><p>${n}</p>',
      },
      "page.mx",
      {},
      true,
    );
    expect(html).toBe("<span>1</span><p>2</p>");
  });

  it("binds /var on a dynamic tag whose callee has no render as undefined", async () => {
    const html = await renderModules(
      {
        "hello.ts": hello,
        "page.mx":
          'import Hello from "./hello.ts"\n<${Hello}/n name="x"/><p>${String(n)}</p>',
      },
      "page.mx",
    );
    expect(html).toBe("<b>x</b><p>undefined</p>");
  });

  it("keeps a hand-written .ts function tag string-returning", async () => {
    const html = await renderModules(
      {
        "hello.ts": hello,
        "page.mx":
          'import Hello from "./hello.ts"\n<div><Hello name="a"/><${Hello} name="b"/></div>',
      },
      "page.mx",
      {},
      true,
    );
    expect(html).toBe("<div><b>a</b><b>b</b></div>");
  });

  it("keeps the default export (input) => string and exposes render on it", async () => {
    const result = await renderModules(
      {
        "counter.mx": counter,
        "probe.ts": [
          'import Counter, { render } from "./counter.ts";',
          'import { createOut } from "./runtime.ts";',
          "export default () => {",
          "  const html = Counter({ start: 1 });",
          "  const out = createOut();",
          "  const value = Counter.render({ start: 5 }, out);",
          "  return JSON.stringify([typeof html, html, Counter.render === render, value, out.toString()]);",
          "};",
        ].join("\n"),
      },
      "probe.ts",
    );
    expect(JSON.parse(result)).toEqual([
      "string",
      "<span>1</span>",
      true,
      6,
      "<span>5</span>",
    ]);
  });

  // Measured with Marko 6.3.51: the body throws after writing `<b>before</b>`
  // and Marko renders `<div>caught</div>`. The body renders into a buffered
  // sub-sink that is dropped on a throw; before decision 155 this host kept
  // the partial body (`<div><b>before</b>caught</div>`).
  it("drops a <try> body's partial output when it throws", async () => {
    const html = await renderModules(
      {
        "page.mx":
          "<div><try><b>before</b>${input.missing.deep}<i>after</i><@catch|e|>caught</@catch></try></div>",
      },
      "page.mx",
    );
    expect(html).toBe("<div>caught</div>");
  });

  // Marko 6.3.51 rethrew from a `<try>` with no `<@catch>`, and this host
  // used to swallow it (`catch {}`). Marko 6.4 refuses the shape at compile
  // time ("without either it has no effect"), so a catch-less `<try>` can no
  // longer reach render; `<@placeholder>` is not supported on this host.
  it("refuses a <try> without <@catch> at compile time", () => {
    expect(() =>
      compile(src("<try><b>2</b>${input.missing.deep}</try>"), file),
    ).toThrowError("needs a `<@catch>`");
  });

  // Measured with Marko 6.3.51: `<${Counter}/n({start:2})/>` renders
  // `<span>2</span>` and binds `n` to 3. A template called with tag args
  // receives args[0] as its input.
  it("binds /var on a dynamic tag called with args", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "page.mx":
          'import Counter from "./counter.mx"\n<${Counter}/n({start:2})/><p>${n}</p>',
      },
      "page.mx",
    );
    expect(html).toBe("<span>2</span><p>3</p>");
  });

  it("commits a nested <try> into its enclosing <try>", async () => {
    const html = await renderModules(
      {
        "page.mx":
          "<try><a>1</a><try><b>2</b>${input.missing.deep}<@catch|e|><i>3</i></@catch></try><u>4</u><@catch|e|>outer</@catch></try>",
      },
      "page.mx",
    );
    expect(html).toBe("<a>1</a><i>3</i><u>4</u>");
  });
});

describe("an imported .mx tag that declares <return>", () => {
  const counter = [
    "export interface Input { start: number }",
    "<span>${input.start}</span>",
    "<return value=input.start + 1/>",
  ].join("\n");

  // Marko 6.3.51 renders the body and drops the value when the call binds no
  // `/var`. The call once concatenated the callee's former `{ value, output }`
  // pair as "[object Object]"; since decision 155 it renders into the sink.
  it("renders its body and drops the value without /var", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "page.mx":
          'import Counter from "./counter.mx"\n<div><Counter start=1/></div>',
      },
      "page.mx",
      {},
      true,
    );
    expect(html).toBe("<div><span>1</span></div>");
  });

  it("emits the same sink call a discovered tag gets", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-return-"));
    try {
      writeFileSync(join(dir, "counter.mx"), src(counter));
      const page = join(dir, "page.mx");
      const { code } = compile(
        src('import Counter from "./counter.mx"\n<Counter start=1/>'),
        page,
      );
      expect(code).toContain("Counter.render({ start: 1 }, __mxOut);");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders an imported tag without <return> through the runtime dispatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-plain-"));
    try {
      writeFileSync(join(dir, "plain.mx"), src("<b>x</b>"));
      const { code } = compile(
        src('import Plain from "./plain.mx"\n<Plain/>'),
        join(dir, "page.mx"),
      );
      // Its shape is not known statically, so `__mxRenderTag` picks
      // `.render` at run time.
      expect(code).toContain("__mxRenderTag(__mxOut, Plain)({  });");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Marko 6.3.51: `<Counter/n start=1/>` renders the body and `n` holds the
  // return value (`<div><span>1</span><p>2</p></div>`).
  it("binds /var to the returned value and renders the body", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "page.mx":
          'import Counter from "./counter.mx"\n<div><Counter/n start=1/><p>${n}</p></div>',
      },
      "page.mx",
      {},
      true,
    );
    expect(html).toBe("<div><span>1</span><p>2</p></div>");
  });

  it("binds each call's own /var", async () => {
    const html = await renderModules(
      {
        "counter.mx": counter,
        "page.mx":
          'import Counter from "./counter.mx"\n<Counter/a start=1/><Counter/b start=10/><i>${a}-${b}</i>',
      },
      "page.mx",
      {},
      true,
    );
    expect(html).toBe("<span>1</span><span>10</span><i>2-11</i>");
  });

  it("emits the same /var lowering a discovered tag gets", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-var-"));
    try {
      writeFileSync(join(dir, "counter.mx"), src(counter));
      const { code } = compile(
        src('import Counter from "./counter.mx"\n<Counter/n start=1/>'),
        join(dir, "page.mx"),
      );
      expect(code).toContain(
        "const n = Counter.render({ start: 1 }, __mxOut);",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a read of the /var before the call, positioned", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-var-early-"));
    try {
      writeFileSync(join(dir, "counter.mx"), src(counter));
      expect(() =>
        compile(
          src(
            'import Counter from "./counter.mx"\n<p>${n}</p>\n<Counter/n start=1/>',
          ),
          join(dir, "page.mx"),
        ),
      ).toThrow(/`n` is read before the `\/var` that binds it/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Marko `references.ts:556-560`: a call's own attributes and body cannot
  // read the `/var` it declares. Same positioned error as a discovered tag;
  // before, the imported form compiled to a TDZ crash at render.
  it("rejects a read of the /var in the call's own attribute, positioned", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-var-attr-"));
    try {
      writeFileSync(join(dir, "counter.mx"), src(counter));
      let error: (Error & { line?: number; column?: number }) | undefined;
      try {
        compile(
          src('import Counter from "./counter.mx"\n<Counter/n start=n/>'),
          join(dir, "page.mx"),
        );
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(
        /`n` is read before the `\/var` that binds it/,
      );
      expect(error?.line).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a read of the /var in the call's own body, positioned", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-var-body-"));
    try {
      writeFileSync(join(dir, "counter.mx"), src(counter));
      let error: (Error & { line?: number; column?: number }) | undefined;
      try {
        compile(
          src(
            'import Counter from "./counter.mx"\n<Counter/n start=1><b>${n}</b></Counter>',
          ),
          join(dir, "page.mx"),
        );
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(
        /`n` is read before the `\/var` that binds it/,
      );
      expect(error?.line).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the cause when /var is on a missing or non-compiling .mx import", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-var-broken-"));
    try {
      writeFileSync(join(dir, "broken.mx"), src("<if=>"));
      const failure = (source: string) => {
        try {
          compile(src(source), join(dir, "page.mx"));
        } catch (caught) {
          return caught as Error & { line?: number };
        }
        return undefined;
      };
      const missing = failure('import M from "./missing.mx"\n<M/n/>');
      expect(missing?.message).toMatch(
        /`\/n` on `<M>` can't bind: .*missing\.mx could not be resolved/,
      );
      expect(missing?.message).not.toContain("not supported");
      expect(missing?.line).toBe(2);
      const broken = failure('import B from "./broken.mx"\n<B/n/>');
      expect(broken?.message).toMatch(
        /`\/n` on `<B>` can't bind: .*broken\.mx does not compile/,
      );
      expect(broken?.line).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects /var on an imported tag that declares no <return>, at the call", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-var-none-"));
    try {
      writeFileSync(join(dir, "plain.mx"), src("<b>x</b>"));
      let error: (Error & { line?: number; column?: number }) | undefined;
      try {
        compile(
          src('import Plain from "./plain.mx"\n<Plain/n/>'),
          join(dir, "page.mx"),
        );
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(/`<Plain>` does not return a value/);
      expect(error?.line).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still rejects /var on an imported .ts component", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-imported-var-ts-"));
    try {
      writeFileSync(join(dir, "widget.ts"), "export default () => ({})");
      let error: (Error & { line?: number; column?: number }) | undefined;
      try {
        compile(
          src('import Widget from "./widget.ts"\n<Widget/n/>'),
          join(dir, "page.mx"),
        );
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(
        /tag variable `\/n` on `<Widget>` is not supported/,
      );
      // At the `/n` itself, not the tag (core's dynamic-tag-var-silent-drop
      // position change: `rejectUnsupportedFields` reports at `node.var`).
      expect({ line: error?.line, column: error?.column }).toEqual({
        line: 2,
        column: 8,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("<try> without a placeholder is a plain try/catch", () => {
  it("lowers the body and its <@catch>", () => {
    const body = "<try><p>b</p><@catch|e|><p>err</p></@catch></try>";
    const { code } = compile(src(body), file);
    expect(code).toContain("try {");
    expect(code).toContain("} catch (e) {");
  });

  // Round 1 item 1 regression: a whitespace-only `<try>` body must still
  // reach the emitter, matching `lowerDelegatedTag`'s old unconditional lowering
  // rather than being dropped by the `hasContent` gate an ordinary custom
  // tag's body uses.
  it("preserves a whitespace-only body", () => {
    const { code } = compile(src("<try>  <@catch|e|>x</@catch></try>"), file);
    expect(code).toContain('__mxTry0.write(" ");');
  });

  it("preserves markup mixed with text in the body", () => {
    const { code } = compile(
      src("<try>a <b>c</b><@catch|e|>x</@catch></try>"),
      file,
    );
    expect(code).toContain('__mxTry0.write("a <b>c</b>");');
  });
});

describe("class and style take Marko's structured values", () => {
  it.each([
    ["object", "<div class={a: true, b: false}>x</div>", "__mxClassValue({"],
    ["array", '<div class=["x", {y: true}]>z</div>', "__mxClassValue(["],
    ["style object", '<div style={color: "red"}>s</div>', "__mxStyleValue({"],
  ])("%s", (_name, body, expected) => {
    expect(compile(src(body), file).code).toContain(expected);
  });

  it("emits the helper only when something calls it", () => {
    const plain = compile(src("<p>a</p>"), file).code;
    expect(plain).not.toContain("function __mxClassValue");
    expect(plain).not.toContain("function __mxRenderDynamic");
  });
});

describe("attribute-tag v2 values (executed)", () => {
  it("renders declared data and renderable tags through their callee forms", async () => {
    const html = await renderModules(
      {
        "callee.mx": [
          "export interface Input {",
          '  head?: AttrTag<{ as: "renderable" }>;',
          "  row?: AttrTag<{ attrs: { label: string }; params: [suffix: string] }>;",
          "}",
          '<section><${input.head}/><if=input.row><b>${input.row.label}:<${input.row.content}("!")/></b></if></section>',
        ].join("\n"),
        "entry.mx": [
          'import Callee from "./callee.mx"',
          '<Callee><@head>H</@head><@row|suffix| label="R">${suffix}</@row></Callee>',
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<section>H<b>R:!</b></section>");
  });

  it("merges static, if/else and for occurrences into a real array", async () => {
    const html = await renderModules(
      {
        "list.ts": [
          "export interface Input { item: AttrTag<{ attrs: { id: number } }>[] }",
          "export default function List(input: Input): string {",
          '  return input.item.map((item) => `<i>${item.id}:${item.content?.()}</i>`).join("");',
          "}",
        ].join("\n"),
        "entry.mx": [
          'import List from "./list.ts"',
          "<List>",
          "  <@item id=0>S</@item>",
          "  <if=input.on><@item id=1>I</@item></if>",
          "  <else><@item id=2>E</@item></else>",
          "  <for|n| of=input.values><@item id=n>${n}</@item></for>",
          "</List>",
        ].join("\n"),
      },
      "entry.mx",
      { on: true, values: [3, 4] },
    );
    expect(html).toBe("<i>0:S</i><i>1:I</i><i>3:3</i><i>4:4</i>");
  });

  it("renders nothing for a nullish of=/in=, matching Marko, in content and attribute-tag loops", async () => {
    const html = await renderModules(
      {
        "list.ts": [
          "export interface Input { item: AttrTag<{ attrs: { id: number } }>[] }",
          "export default function List(input: Input): string {",
          '  return input.item.map((item) => `<i>${item.id}:${item.content?.()}</i>`).join("");',
          "}",
        ].join("\n"),
        "entry.mx": [
          'import List from "./list.ts"',
          "<for|x| of=input.list><b>${x}</b></for>",
          "<for|k, v| in=input.obj><b>${k}:${v}</b></for>",
          "<List>",
          "  <for|n| of=input.list><@item id=n>${n}</@item></for>",
          "  <for|k| in=input.obj><@item id=k/></for>",
          "</List>",
        ].join("\n"),
      },
      "entry.mx",
      { list: undefined, obj: null },
    );
    expect(html).toBe("");
  });

  it("renders nothing for a falsy (non-nullish) of=, matching Marko, in content and attribute-tag loops", async () => {
    for (const list of [0, false, Number.NaN, ""]) {
      const html = await renderModules(
        {
          "list.ts": [
            "export interface Input { item: AttrTag<{ attrs: { id: number } }>[] }",
            "export default function List(input: Input): string {",
            '  return input.item.map((item) => `<i>${item.id}:${item.content?.()}</i>`).join("");',
            "}",
          ].join("\n"),
          "entry.mx": [
            'import List from "./list.ts"',
            "<for|x| of=input.list><b>${x}</b></for>",
            "<List>",
            "  <for|n| of=input.list><@item id=n>${n}</@item></for>",
            "</List>",
          ].join("\n"),
        },
        "entry.mx",
        { list },
      );
      expect(html).toBe("");
    }
  });

  it("executes else-if, for-in, inclusive to, and exclusive until plans", async () => {
    const html = await renderModules(
      {
        "list.ts": [
          "export interface Input { item: AttrTag<{ attrs: { id: string | number } }>[] }",
          "export default function List(input: Input): string {",
          '  return input.item.map((item) => `<i>${item.id}</i>`).join("");',
          "}",
        ].join("\n"),
        "entry.mx": [
          'import List from "./list.ts"',
          "<List>",
          '  <if=input.mode === 0><@item id="if"/></if>',
          '  <else-if=input.mode === 1><@item id="else-if"/></else-if>',
          '  <else><@item id="else"/></else>',
          "  <for|key| in=input.entries><@item id=key/></for>",
          "  <for|n| from=1 to=2><@item id=n/></for>",
          "  <for|n| from=3 until=5><@item id=n/></for>",
          "</List>",
        ].join("\n"),
      },
      "entry.mx",
      { mode: 1, entries: { a: 10, b: 20 } },
    );
    expect(html).toBe(
      "<i>else-if</i><i>a</i><i>b</i><i>1</i><i>2</i><i>3</i><i>4</i>",
    );
  });

  it("does not shadow an outer value binding in content or attribute-tag for-in loops", async () => {
    const html = await renderModules(
      {
        "list.ts": [
          'export interface Input { item: AttrTag<{ as: "renderable" }>[] }',
          "export default function List(input: Input): string {",
          '  return input.item.map((item) => item()).join("");',
          "}",
        ].join("\n"),
        "entry.mx": [
          'import List from "./list.ts"',
          '<let/value="outer"/>',
          "<for|key| in=input.entries><b>${value}:${key}</b></for>",
          "<List><for|key| in=input.entries><@item>${value}:${key}</@item></for></List>",
        ].join("\n"),
      },
      "entry.mx",
      { entries: { a: 10, b: 20 } },
    );
    expect(html).toBe("<b>outer:a</b><b>outer:b</b>outer:aouter:b");
  });

  it("preserves declared param types through looped array emission under strict tsc", async () => {
    const html = await renderModules(
      {
        "callee.mx": [
          "export interface Input {",
          "  row: AttrTag<{ attrs: { id: number }; params: [suffix: string] }>[];",
          "}",
          '<for|row| of=input.row><p>${row.id}:<${row.content}("!")/></p></for>',
        ].join("\n"),
        "entry.mx": [
          'import Callee from "./callee.mx"',
          "export interface Input { rows: number[]; show: boolean }",
          "<Callee><if=input.show><@row|suffix| id=0>${suffix.toUpperCase()}</@row></if><for|n| of=input.rows><@row|suffix| id=n>${suffix.toUpperCase()}</@row></for></Callee>",
        ].join("\n"),
      },
      "entry.mx",
      { rows: [7], show: true },
      true,
    );
    expect(html).toBe("<p>0:!</p><p>7:!</p>");
    // A tsc subprocess over ~200 files (mostly @types/node): ~1 s alone,
    // 1.4-2.3 s in the root run after the lean runtime stub, but the sibling
    // tsc-backed tests in other packages reach 4-5 s under load. Scoped headroom.
  }, 15_000);

  it("passes an empty array when a declared repeated tag has no occurrences", async () => {
    const html = await renderModules(
      {
        "list.ts": [
          "export interface Input { item: AttrTag<{ attrs: { id: number } }>[] }",
          "export default function List(input: Input): string {",
          "  return `items:${input.item.length}`;",
          "}",
        ].join("\n"),
        "entry.mx": 'import List from "./list.ts"\n<List/>',
      },
      "entry.mx",
    );
    expect(html).toBe("items:0");
  });

  it("emits nested data tags recursively through two levels", async () => {
    const html = await renderModules(
      {
        "tree.mx": [
          "export interface Input {",
          "  group?: AttrTag<{ attrs: {",
          "    title: string;",
          "    item: AttrTag<{ attrs: {",
          "      label: string;",
          '      icon?: AttrTag<{ as: "renderable" }>;',
          "    } }>[];",
          "  } }>;",
          "}",
          "<if=input.group>",
          "  <h1>${input.group.title}</h1>",
          "  <for|item| of=input.group.item><p>${item.label}:<${item.icon}/></p></for>",
          "</if>",
        ].join("\n"),
        "entry.mx": [
          'import Tree from "./tree.mx"',
          '<Tree><@group title="G"><@item label="A"><@icon>I</@icon></@item><@item label="B"><@icon>J</@icon></@item></@group></Tree>',
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<h1>G</h1><p>A:I</p><p>B:J</p>");
  });

  it("unifies nested shape across conditional parent occurrences", async () => {
    const sources = {
      "row.mx":
        '<p>${typeof input.tab.icon}:${input.tab.icon.k || "-"}:<${input.tab.icon.content}/></p>',
      "entry.mx":
        'import Row from "./row.mx"\n<Row><if=input.pickBare><@tab><@icon>I</@icon></@tab></if><else><@tab><@icon k="K">J</@icon></@tab></else></Row>',
    };
    expect(await renderModules(sources, "entry.mx", { pickBare: true })).toBe(
      "<p>object:-:I</p>",
    );
    expect(await renderModules(sources, "entry.mx", { pickBare: false })).toBe(
      "<p>object:K:J</p>",
    );
  });

  it("unifies nested shape across repeated parent occurrences", async () => {
    const html = await renderModules(
      {
        "row.mx":
          '<for|tab| of=input.tab><p>${typeof tab.icon}:${tab.icon.k || "-"}:<${tab.icon.content}/></p></for>',
        "entry.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@tab><@icon k="K">J</@icon></@tab></Row>',
      },
      "entry.mx",
    );
    expect(html).toBe("<p>object:-:I</p><p>object:K:J</p>");
  });

  it("unifies nested one-versus-array cardinality", async () => {
    const html = await renderModules(
      {
        "row.mx":
          "<for|tab| of=input.tab><p>${Array.isArray(tab.icon)}:<for|icon| of=tab.icon><${icon}/></for></p></for>",
        "entry.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@tab><@icon>J</@icon><@icon>K</@icon></@tab></Row>',
      },
      "entry.mx",
    );
    expect(html).toBe("<p>true:I</p><p>true:JK</p>");
  });

  it("keeps nested fallback shape isolated between sibling parent names", async () => {
    const html = await renderModules(
      {
        "row.mx":
          "<p>${typeof input.tab.icon}|${typeof input.card.icon}:${input.card.icon.k}:<${input.tab.icon}/>:<${input.card.icon.content}/></p>",
        "entry.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@icon k="1">J</@icon></@card></Row>',
      },
      "entry.mx",
    );
    expect(html).toBe("<p>function|object:1:I:J</p>");
  });

  it("keeps nested fallback cardinality isolated between sibling parent names", async () => {
    const html = await renderModules(
      {
        "row.mx":
          "<p>${String(Array.isArray(input.tab.icon))}|${String(Array.isArray(input.card.icon))}:<${input.tab.icon}/>:<for|icon| of=input.card.icon><${icon}/></for></p>",
        "entry.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@icon>J</@icon><@icon>K</@icon></@card></Row>',
      },
      "entry.mx",
    );
    expect(html).toBe("<p>false|true:I:JK</p>");
  });

  it("keeps only each sibling parent's own nested props", async () => {
    const html = await renderModules(
      {
        "row.mx":
          "<p>${typeof input.tab.badge}|${typeof input.card.icon}:<${input.tab.icon}/>:<${input.card.badge}/></p>",
        "entry.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@badge>B</@badge></@card></Row>',
      },
      "entry.mx",
    );
    expect(html).toBe("<p>undefined|undefined:I:B</p>");
  });

  it("does not apply a declared sibling's nested shape to an undeclared parent", async () => {
    const html = await renderModules(
      {
        "row.mx": [
          'export interface Input { tab?: AttrTag<{ attrs: { icon?: AttrTag<{ as: "renderable" }> } }>; [key: string]: unknown }',
          "<const/card=(input.card as any)/>",
          "<p>${typeof card.icon}:${card.icon.k}:<${card.icon.content}/></p>",
        ].join("\n"),
        "entry.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@icon k="1">J</@icon></@card></Row>',
      },
      "entry.mx",
    );
    expect(html).toBe("<p>object:1:J</p>");
  });

  it("uses the data fallback for an untyped dynamic callee", async () => {
    const html = await renderModules(
      {
        "entry.mx": '<${input.callee}><@slot label="F">fallback</@slot></>',
      },
      "entry.mx",
      {
        callee: (props: { slot: { label: string; content?: () => string } }) =>
          `${props.slot.label}:${props.slot.content?.()}`,
      },
    );
    expect(html).toBe("F:fallback");
  });

  it("uses the data fallback for an untyped static callee", async () => {
    const html = await renderModules(
      {
        "panel.ts": [
          "export default function Panel(input: any): string {",
          "  return `${input.header.label}:${input.header.content?.()}`;",
          "}",
        ].join("\n"),
        "entry.mx": [
          'import Panel from "./panel.ts"',
          '<Panel><@header label="S">static</@header></Panel>',
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("S:static");
  });

  it("renders a body-only fallback through an untyped MX callee", async () => {
    const html = await renderModules(
      {
        "panel.mx": "<div><${input.header}/></div>",
        "entry.mx": [
          'import Panel from "./panel.mx"',
          "<Panel><@header>Hi</@header></Panel>",
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<div>Hi</div>");
  });

  it("passes a body-only fallback bare to an untyped TSX library component", async () => {
    const html = await renderModules(
      {
        "boundary.tsx": [
          "export default function Boundary(input: { fallback: () => string }): string {",
          "  return `<section>${input.fallback()}</section>`;",
          "}",
        ].join("\n"),
        "entry.mx": [
          'import Boundary from "./boundary.tsx"',
          "<Boundary><@fallback>ready</@fallback></Boundary>",
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<section>ready</section>");
  });

  it("positions a declared data tag's direct-render error at compile time", () => {
    expect(() =>
      compile(
        src("export interface Input { header?: AttrTag }\n<${input.header}/>"),
        file,
      ),
    ).toThrow(
      "`input.header` is a data attribute tag; render its body with `<${input.header.content}/>`",
    );
  });

  it("sets data content to undefined when the tag has no body", async () => {
    const html = await renderModules(
      {
        "callee.mx": [
          "export interface Input { badge?: AttrTag<{ attrs: { label: string } }> }",
          "<if=input.badge><p>${input.badge.label}:${String(input.badge.content)}</p></if>",
        ].join("\n"),
        "entry.mx": [
          'import Callee from "./callee.mx"',
          '<Callee><@badge label="empty"/></Callee>',
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<p>empty:undefined</p>");
  });

  it("imports the html-specialized AttrTag type when Input uses it", () => {
    const code = compile(
      src(
        'export interface Input { slot?: AttrTag<{ as: "renderable" }> }\n<div/>',
      ),
      file,
    ).code;
    expect(code).toContain(
      'import type { AttrTag } from "@mxlang/target-html";',
    );
  });

  it("names ordinary children `content`, the prop Marko's own tags read", () => {
    const body = 'import Panel from "./panel.mx"\n<Panel>body</Panel>';
    const { code } = compile(src(body), file);
    expect(code).toContain("content: (");
    expect(code).not.toContain("children:");
  });

  // Decision 109 relaxed only the dynamic-tag/`<define>` rule; a named
  // custom tag (an imported component reference) stays on Marko's strict
  // rule and must still reject args combined with a body or attribute tag.
  it.each([
    [
      "an attribute tag",
      'import Panel from "./panel.mx"\n<Panel("a")><@header>H</@header></Panel>',
    ],
    ["a body", 'import Panel from "./panel.mx"\n<Panel("a")>body</Panel>'],
  ])(
    "still rejects a named custom tag mixing tag-argument form with %s",
    (_case, body) => {
      expect(() => compile(src(body), file)).toThrow(
        "Tag does not support arguments when attributes or body present.",
      );
    },
  );
});

describe("dynamic tags", () => {
  it.each([
    ["input", "<input title>"],
    ["keygen", "<keygen title></keygen>"],
    ["menuitem", "<menuitem title></menuitem>"],
    ["INPUT", "<INPUT title></INPUT>"],
  ])(
    "uses Marko 6.3.51's exact dynamic void list for %s",
    async (tag, expected) => {
      // Measured with Marko 6.3.51: deprecated keygen/menuitem and uppercase
      // names are not matched by its case-sensitive voidElementsReg.
      const html = await renderModules(
        { "entry.mx": `<\${input.tag} title=input.v/>` },
        "entry.mx",
        { tag, v: true },
      );
      expect(html).toBe(expected);
    },
  );

  // Stock Marko 6.3.51 renders the body for every falsy tag name (false,
  // 0, "", null, undefined) and nothing for a self-closing dynamic tag —
  // measured on the stock toolchain, not from memory. MX previously threw
  // `__mxTarget is not a function` for false/0 and emitted `<>body</>` for "".
  it.each([
    ["false", false],
    ["0", 0],
    ['""', ""],
    ["null", null],
    ["undefined", undefined],
  ])(
    "renders the body when the dynamic tag name is %s (Marko parity)",
    async (_name, tag) => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
      const html = await renderModules(
        { "entry.mx": "<${input.tag}>body</>" },
        "entry.mx",
        { tag },
      );
      expect(html).toBe("body");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
      const selfClosing = await renderModules(
        { "entry.mx": "<${input.tag}/>" },
        "entry.mx",
        { tag },
      );
      expect(selfClosing).toBe("");
    },
  );

  it("rejects arguments combined with a plain attribute (Marko's own rule, MX's own wording)", () => {
    expect(() => compile(src('<${input.fn}("A") foo="bar"/>'), file)).toThrow(
      "Tag does not support arguments when attributes present.",
    );
  });

  it("lowers `<${expr}/>` through the runtime dispatcher", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
    const { code } = compile(src("<${input.tag}/>"), file);
    expect(code).toContain("__mxRenderDynamic(__mxOut, input.tag");
    expect(code).toContain("function __mxRenderDynamic");
  });

  it("lowers a bare `${expr}` concise-position line the same way, since this host claims DYNAMIC_TAG for both shapes", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko concise-mode placeholder/dynamic-tag syntax in template source
    const { code } = compile(src("${input.tag}\n"), file);
    expect(code).toContain("__mxRenderDynamic(__mxOut, input.tag");
    expect(code).toContain("function __mxRenderDynamic");
  });

  // attribute-tag-silent-drops B2: `renderDynamic` used to receive `{}` for
  // every attribute tag on a dynamic tag, silently dropping it (measured
  // against `marko` 6.3.51: attribute tags ARE forwarded to a dynamic tag's
  // resolved target). `apps/docs/docs/language/errors.md`'s claim that this
  // case "is reported as such" was also wrong — it compiled clean and lost
  // the content.
  it("forwards an attribute tag on a dynamic tag into the renderDynamic call, not `{}`", () => {
    const { code } = compile(
      src("<${input.comp}><@header>hi</@header></>"),
      file,
    );
    expect(code).toContain("__mxRenderDynamic(__mxOut, input.comp, { header:");
    expect(code).not.toContain("__mxRenderDynamic(__mxOut, input.comp, {  });");
  });

  it("accepts arguments combined with a body on a dynamic tag (decision 109, Marko parity)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { comp } from "./comp.ts"\n<${comp}("x", 2)>body</>',
        "comp.ts": [
          "export function comp(a: string, b: number, extra?: { content?: () => string }) {",
          '  return `[${a}-${b}-${extra?.content?.() ?? "none"}]`;',
          "}",
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("[x-2-body]");
  });

  it("accepts arguments combined with an attribute tag on a dynamic tag (decision 109, Marko parity)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { comp } from "./comp.ts"\n<${comp}("x", 2)><@head>H</@head></>',
        "comp.ts": [
          "export function comp(a: string, b: number, extra?: { head?: () => string }) {",
          '  return `[${a}-${b}-${extra?.head?.() ?? "none"}]`;',
          "}",
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("[x-2-H]");
  });

  it("still rejects arguments combined with a plain attribute", () => {
    expect(() => compile(src('<${input.fn}("A") foo="bar"/>'), file)).toThrow(
      "Tag does not support arguments when attributes present.",
    );
  });

  // decision 112: a string-target dynamic tag called with arguments uses
  // `args[0]` as its input (attributes), matching Marko's own
  // `runtime-tags/src/html/dynamic-tag.ts` `_dynamic_tag` (`typeof renderer
  // === "string"` branch: `const input = (inputIsArgs ? args[0] : ...) ||
  // {}`). Previously `renderDynamic` ignored `args` entirely for a string
  // target and rendered the call-site attributes/attribute tags instead.
  it("uses args[0] as attributes for a string-target dynamic tag called with arguments (decision 112)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { tagName } from "./comp.ts"\n<${tagName()}({ id: "x", class: "y" })/>',
        "comp.ts": ["export function tagName() {", '  return "div";', "}"].join(
          "\n",
        ),
      },
      "entry.mx",
    );
    expect(html).toBe('<div id="x" class="y"></div>');
  });

  it("ignores extra arguments beyond args[0] for a string-target dynamic tag (decision 112, Marko parity)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { tagName } from "./comp.ts"\n<${tagName()}({ id: "x" }, "unused", 123)/>',
        "comp.ts": ["export function tagName() {", '  return "div";', "}"].join(
          "\n",
        ),
      },
      "entry.mx",
    );
    expect(html).toBe('<div id="x"></div>');
  });

  it("treats a null/undefined args[0] as no attributes for a string-target dynamic tag (decision 112, Marko parity)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { tagName } from "./comp.ts"\n<${tagName()}(input.missing)/>',
        "comp.ts": ["export function tagName() {", '  return "div";', "}"].join(
          "\n",
        ),
      },
      "entry.mx",
    );
    expect(html).toBe("<div></div>");
  });

  // Marko's translator appends attribute tags/content as a trailing props
  // object AFTER the positional args (`renderer(...args, { content, ... })`),
  // so for a string target it lands at `args[N]`, N > 0 — never `args[0]` —
  // and `_dynamic_tag`'s string branch reads only `args[0]`. The trailing
  // object's attribute-tag values are therefore dropped from the rendered
  // attributes; content still renders through the separate `content` param
  // `_dynamic_tag` always threads independently of `input`.
  it("does not fold decision 109's trailing attribute-tag props object into args[0] for a string target, but content still renders (Marko parity)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { tagName } from "./comp.ts"\n<${tagName()}({ id: "x" })><@head>H</@head>body</>',
        "comp.ts": ["export function tagName() {", '  return "div";', "}"].join(
          "\n",
        ),
      },
      "entry.mx",
    );
    expect(html).toBe('<div id="x">body</div>');
  });
});

// Decision 116: a capitalized tag bound to a value import that is not a
// `.marko`/`.mx` default import lowers as a dynamic tag, matching Marko's
// own `_dynamic_tag` runtime dispatch for the six measured value kinds
// (`scratch/reports/value-import-as-tag-parity.md`). Each case here uses an
// ordinary `import X from "./target.ts"` (or `{ X }`) and an ordinary
// `<X>`/`<X/>` call — the routing itself, not the `<${expr}>` syntax already
// covered above.
describe("a component body with tag params (`<List|item, i|>`) binds them (executed)", () => {
  // The callee calls `input.content(item, i)`: the body is a params-taking
  // `content`, the shape Marko 6.3.51 emits and the JSX hosts settled on
  // (PR #371). A `${expr}` target dropped the params (`content: () => …`), so
  // `item`/`i` were unbound in the body with no warning.
  const list = [
    "export interface Input { items: string[]; content: (item: string, i: number) => unknown }",
    "<ul><for|item, i| of=input.items><li><${input.content}(item, i)/></li></for></ul>",
  ].join("\n");
  const expected = "<ul><li><b>a0</b></li><li><b>b1</b></li></ul>";
  const items = { items: ["a", "b"] };

  it.each([
    [
      "an imported component",
      'import List from "./list.mx"',
      "<List|item, i| items=input.items><b>${item}${i}</b></List>",
    ],
    [
      "a dynamic target (imported value)",
      'import List from "./list.mx"',
      "<${List}|item, i| items=input.items><b>${item}${i}</b></>",
    ],
    [
      "a dynamic target (explicit close)",
      'import List from "./list.mx"',
      "<${List}|item, i| items=input.items><b>${item}${i}</b></${List}>",
    ],
  ])("%s", async (_label, header, body) => {
    const html = await renderModules(
      {
        "list.mx": list,
        "entry.mx": [
          header,
          "export interface Input { items: string[] }",
          "<${List}|item, i| items=input.items><b>${item}${i}</b></>",
        ].join("\n"),
      },
      "entry.mx",
      items,
    );
    expect(html).toBe(expected);
  });

  it("a dynamic target taken from input emits the params", () => {
    const entry = compile(
      src(
        "export interface Input { L: any; items: string[] }\n<${input.L}|item, i| items=input.items><b>${item}${i}</b></>",
      ),
      "/tmp/mx-translator-test/entry.mx",
    ).code;
    expect(entry).toMatch(/content: \(\(item, i\) => \{/);
  });

  it("a dynamic call with args keeps the params", () => {
    const code = compile(
      src(
        "export interface Input { L: any }\n<${input.L}(1)|item| ><b>${item}</b></>",
      ),
      "/tmp/mx-translator-test/args.mx",
    ).code;
    expect(code).toMatch(/content: \(\(item\) => \{/);
  });

  // Measured against Marko 6.3.51 (renderStockMarko): `<${"div"}|x|>` is a
  // compile error; a string that arrives at run time renders the element and
  // the body called with no arguments (`<div><b></b></div>`); a null or absent
  // target renders the body alone (`<b></b>`).
  it("rejects a literal string target with a params body, as Marko does", () => {
    for (const target of ['"div"', "'div'", "`div`"]) {
      expect(() =>
        compile(
          src(`<\${${target}}|x|><b>\${x}</b></>`),
          "/tmp/mx-translator-test/str.mx",
        ),
      ).toThrow("Tag does not support parameters.");
    }
  });

  it("accepts a literal string target without params", () => {
    expect(() =>
      compile(src('<${"div"}><b>x</b></>'), "/tmp/mx-translator-test/ok.mx"),
    ).not.toThrow();
  });

  it.each([
    ["a run-time string", { tag: "div" }, "<div><b></b></div>"],
    ["null", { tag: null }, "<b></b>"],
    ["undefined", {}, "<b></b>"],
  ])(
    "renders %s target with a params body as Marko does",
    async (_label, input, html) => {
      expect(
        await renderModules(
          {
            "entry.mx": [
              "export interface Input { tag?: string | null }",
              "<${input.tag}|x|><b>${x}</b></>",
            ].join("\n"),
          },
          "entry.mx",
          input,
        ),
      ).toBe(html);
    },
  );

  it("a body without params is unchanged", () => {
    const code = compile(
      src("export interface Input { L: any }\n<${input.L}><b>x</b></>"),
      "/tmp/mx-translator-test/plain.mx",
    ).code;
    expect(code).toMatch(/content: \(\) => \{/);
  });

  // The imported row is left out: a callee declaring `content` also gets the
  // preamble's `content?: () => string` intersected into its `Input`, so strict
  // tsc rejects any params-taking body on a named call (TS2322, not this fix).
  it("type-checks a dynamic target under strict tsc", async () => {
    const html = await renderModules(
      {
        "list.mx": list,
        "entry.mx": [
          'import List from "./list.mx"',
          "export interface Input { items: string[] }",
          "<${List}|item, i| items=input.items><b>${item}${i}</b></>",
        ].join("\n"),
      },
      "entry.mx",
      items,
      true,
    );
    expect(html).toBe(expected);
  }, 15_000);
});

describe("decision 116: value import used as a tag", () => {
  it("a string value import renders as a real element", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { Tag } from "./target.ts"\n<Tag name="1">body</Tag>\n<Tag/>',
        "target.ts": 'export const Tag = "div";',
      },
      "entry.mx",
    );
    expect(html).toBe('<div name="1">body</div><div></div>');
  });

  it("a custom-element-named string value import renders as that element (Marko parity)", async () => {
    const html = await renderModules(
      {
        "entry.mx": 'import { Tag } from "./target.ts"\n<Tag/>',
        "target.ts": 'export const Tag = "my-el";',
      },
      "entry.mx",
    );
    expect(html).toBe("<my-el></my-el>");
  });

  it("a plain function value import is called as a host component (decision 116, intentional Marko divergence)", async () => {
    // Marko's own `_dynamic_tag` discards a plain function's return value
    // (only a real Marko-template-shaped renderer is invoked as a
    // component); MX calls it and keeps the output — an imported `.tsx`
    // component on react/preact/hono, and an MX component on html, IS a
    // plain function, so matching Marko byte-for-byte here would break
    // ordinary host interop. Recorded in the spec and divergences.md.
    const html = await renderModules(
      {
        "entry.mx":
          'import { Comp } from "./target.ts"\n<Comp name="1">body</Comp>',
        "target.ts": [
          "export function Comp(input: { name?: string }) {",
          '  return `<span>comp:${input.name ?? ""}</span>`;',
          "}",
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<span>comp:1</span>");
  });

  it("an object with a content property throws decision 106's data-attribute-tag guard", async () => {
    // Not a new divergence: `renderDynamic`'s object branch is the same
    // guard a `<${x}>` data attribute tag already hits (decision 106).
    // Marko itself would unwrap `.content` and find no real renderer there
    // either, silently rendering nothing — but MX's guard is deliberately
    // loud for this shape everywhere it's reachable, dynamic-tag or not.
    await expect(
      renderModules(
        {
          "entry.mx": 'import { Obj } from "./target.ts"\n<Obj/>',
          "target.ts": [
            "export const Obj = {",
            '  content: () => "x",',
            "};",
          ].join("\n"),
        },
        "entry.mx",
      ),
    ).rejects.toThrow(
      "MX: this value is a data attribute tag ({ ...attrs, content }); render its body with",
    );
  });

  it("undefined renders only the tag's body content, matching Marko (fixed: html used to drop the body entirely)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { Missing } from "./target.ts"\n<Missing name="1">body</Missing>',
        "target.ts": "export const Missing = undefined;",
      },
      "entry.mx",
    );
    expect(html).toBe("body");
  });

  it("undefined with no body renders nothing", async () => {
    const html = await renderModules(
      {
        "entry.mx": 'import { Missing } from "./target.ts"\n<Missing/>',
        "target.ts": "export const Missing = undefined;",
      },
      "entry.mx",
    );
    expect(html).toBe("");
  });

  it("null renders only the tag's body content, matching Marko (fixed: html used to drop the body entirely)", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'import { Nul } from "./target.ts"\n<Nul name="1">body</Nul>',
        "target.ts": "export const Nul = null;",
      },
      "entry.mx",
    );
    expect(html).toBe("body");
  });

  it("a .marko/.mx default import is unaffected: still a direct component call, no dynamic-tag guard", async () => {
    const html = await renderModules(
      {
        "entry.mx": 'import Comp from "./comp.mx"\n<Comp name="1"/>',
        "comp.mx": "<span>mxcomp:${input.name}</span>",
      },
      "entry.mx",
    );
    expect(html).toBe("<span>mxcomp:1</span>");
  });
});

// The local extension of decision 116 (firstmate's ruling under decision 116
// in `notes/decisions-2026-09-10.md`): a non-import PascalCase local
// (`static`, module-scope declarations, `<const>`, a tag param) whose value
// core cannot statically prove is a function/arrow/class also lowers as a
// dynamic tag; a plain `function Foo(){}`/`class Foo{}`/arrow-valued
// `static const`/`<const>` stays a direct call, unchanged.
describe("local-value-as-tag-parity: non-import local used as a tag", () => {
  it("a static const string is unknown and renders as a real element", async () => {
    const html = await renderModules(
      {
        "entry.mx": 'static const Tag = "div";\n<Tag name="1">body</Tag>',
      },
      "entry.mx",
    );
    expect(html).toBe('<div name="1">body</div>');
  });

  it("a static arrow-function const stays a direct component call", async () => {
    const html = await renderModules(
      {
        "entry.mx":
          'static const Comp = (input: { name?: string }) => `<span>comp:${input.name ?? ""}</span>`;\n<Comp name="1">body</Comp>',
      },
      "entry.mx",
    );
    expect(html).toBe("<span>comp:1</span>");
  });

  it("a static function declaration stays a direct component call", async () => {
    const html = await renderModules(
      {
        "entry.mx": [
          "static function Comp(input: { name?: string }) {",
          '  return `<span>comp:${input.name ?? ""}</span>`;',
          "}",
          '<Comp name="1">body</Comp>',
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<span>comp:1</span>");
  });

  it("a conditional string-or-component local is unknown and lowers as a dynamic tag", async () => {
    const html = await renderModules(
      {
        "entry.mx": [
          'static function A(input: { name?: string }) { return `<span>a:${input.name ?? ""}</span>`; }',
          'static function B(input: { name?: string }) { return `<span>b:${input.name ?? ""}</span>`; }',
          "static const useA = true;",
          "static const Tag = useA ? A : B;",
          '<Tag name="1">body</Tag>',
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<span>a:1</span>");
  });

  it("a <const> bound to a call result (unknown) lowers as a dynamic tag", async () => {
    const html = await renderModules(
      {
        "entry.mx": [
          'static function make() { return "div"; }',
          "<const/Tag=make()/>",
          '<Tag name="1">body</Tag>',
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe('<div name="1">body</div>');
  });

  it("a tag param is always unknown and lowers as a dynamic tag", async () => {
    const html = await renderModules(
      {
        "entry.mx": [
          'static const Tag = "div";',
          "<define/Wrapper|Row|>",
          "  <Row/>",
          "</define>",
          "<Wrapper(Tag)/>",
        ].join("\n"),
      },
      "entry.mx",
    );
    expect(html).toBe("<div></div>");
  });
});

describe("comments", () => {
  it("emits <html-comment> and strips a plain comment, as Marko does", () => {
    const body = "<html-comment>keep</html-comment>\n<!-- drop -->\n<p>x</p>";
    const { code } = compile(src(body), file);
    expect(code).toContain("<!--keep-->");
    expect(code).not.toContain("drop");
  });
});

describe("the eight-field guard", () => {
  // Marko's parser fills in more than any one path reads. Everything a path
  // does not lower is reported by name rather than dropped — the silent-drop
  // class S8 exists to close, and the reason a third-party translator is hard
  // to write correctly.
  it.each([
    ["tag params on an element", "<div|a|>x</div>", /tag params/],
    ["tag variable on an element", "<div/ref>x</div>", /tag variable/],
    [
      "an attribute tag on an element",
      "<div><@header>x</@header></div>",
      /attribute tag `@header`/,
    ],
  ])("rejects %s", (_what, body, message) => {
    expect(() => compile(src(body), file)).toThrow(message);
  });
});

describe("module shape", () => {
  it("imports the runtime and default-exports the renderer", () => {
    const { code } = compile(src("<p>hi</p>"), file);
    expect(code).toContain(
      'import { escape as __mxEscape, createOut as __mxCreateOut, type Out as __MxOut } from "@mxlang/target-html";',
    );
    expect(code).toContain("function Probe(input: Input): string {");
    // Typed as its signature, not left as `typeof Probe` (the declaration
    // plus its `.render` expando), so a diagnostic prints what a caller can
    // pass and get back.
    expect(code).toContain(
      "export default Probe as ((input: Input) => string) & { render: typeof __mxRender };",
    );
  });

  it("restates the content-reading signature on the typed default export", () => {
    const { code } = compile(src("<p>${input.content?.()}</p>"), file);
    expect(code).toContain(
      "export default Probe as ((input: Input & { content?: () => string }) => string) & { render: typeof __mxRender };",
    );
  });

  // Decision 155: two entries. The default export keeps `(input) => string`;
  // `render(input, out)` writes to a sink and is reachable from the default
  // export, so a caller holding only the default export can use it.
  it("emits the sink entry and reaches it from the default export", () => {
    const { code } = compile(src("<p>hi</p>"), file);
    expect(code).toContain(
      [
        "function Probe(input: Input): string {",
        "  const __mxOut = __mxCreateOut();",
        "  __mxRender(input, __mxOut);",
        "  return __mxOut.toString();",
        "}",
        "Probe.render = __mxRender;",
      ].join("\n"),
    );
    expect(code).toContain(
      [
        "function __mxRender(input: Input, __mxOut: __MxOut): void {",
        '  __mxOut.write("<p>hi</p>");',
        "}",
        "export { __mxRender as render };",
      ].join("\n"),
    );
  });

  it("brands the default export so a host's `check()` can recognize it", () => {
    // A framework host receives a component as an opaque value —
    // `@mxlang/host-astro`'s renderer gets `check(Component, props, slots)` and
    // nothing else — so the compiled function carries a marker rather than
    // being identified by name (which a minifier may rewrite) or by call
    // shape (which every `(props) => string` function shares).
    //
    // `Symbol.for`, through the global registry: the property is written here
    // and read from another package, possibly from a different copy of this
    // one on disk, so the two sides cannot agree by import identity.
    const { code } = compile(src("<p>hi</p>"), file);
    expect(code).toContain(
      'Object.defineProperty(Probe, Symbol.for("mx.component"), { value: true });',
    );
  });

  it("throws rather than silently skipping the brand when the export line drifts", () => {
    // The brand is injected by matching the emitted export line's *shape*, so
    // a change to it would otherwise make `brandRender` a no-op: the module
    // compiles, nothing reports a problem, and every `check()` in the Astro
    // host answers false — a whole host quietly failing to claim its own
    // components. Decision 61: fail loud at the seam that broke.
    //
    // Drifted in the parameter type, which the shape pins; the *name* is
    // deliberately not pinned, since it is derived from the filename now.
    const drifted = [
      'import { escape } from "@mxlang/target-html";',
      "",
      "export interface Input {}",
      "",
      "export default function Probe(props: Input): string {",
      '  return "";',
      "}",
      "",
    ].join("\n");

    expect(() => brandRender(drifted)).toThrow(
      /does not match the expected default export shape/,
    );
  });

  it("brands the default export when inline helpers are emitted too", () => {
    // The helper injection and the brand are two rewrites of the same emitted
    // line, so a template that triggers `classValue` exercises the path where
    // both apply — the one that would silently lose the brand if the rewrites
    // were ordered wrongly.
    const { code } = compile(src("<p class={a: true}>hi</p>"), file);
    expect(code).toContain(
      "function __mxClassValue(__mxValue: unknown): string {",
    );
    expect(code).toContain(
      'Object.defineProperty(Probe, Symbol.for("mx.component"), { value: true });',
    );
    expect(code).toContain("export default Probe as ");
  });

  it("hoists imports and static blocks above the render function", () => {
    const body = 'static const G = "hi"\n<p>x</p>';
    const { code } = compile(src(body), file);
    expect(code.indexOf('const G = "hi"')).toBeLessThan(
      code.indexOf("function Probe(input: Input): string {"),
    );
  });
});

describe("the strict policy (decision 68's fold): reactive tags error by name", () => {
  it.each([
    ["<let>", "<let/count=5/>\n<p>x</p>", /`<let>` is reactive state/],
    ["<effect>", "<effect() { go() }/>", /`<effect>` is a reactive effect/],
    [
      "<lifecycle>",
      "<lifecycle/>",
      /`<lifecycle>` is a reactive lifecycle hook/,
    ],
    [
      "<script>",
      "<script>go()</script>",
      /`<script>` as a Marko tag runs client code/,
    ],
    ["client block", "client\n  const x = 1", /`client` block is client-only/],
    ["<id>", "<id/x/>", /`<id>` allocates an identifier/],
    ["<log>", "<log=1/>", /`<log>` writes to the console/],
    ["<debug>", "<debug/>", /`<debug>` is a debugger hook/],
  ])("rejects %s under { strict: true }", (_name, body, message) => {
    expect(() => compile(src(body), file, { strict: true })).toThrow(message);
  });

  it.each([
    ["<let>", "<let/count=5/>\n<p>${count}</p>", "const count = 5;"],
    [
      "<effect>",
      "<effect() { go() }/>",
      "function Probe(input: Input): string {",
    ],
    [
      "<lifecycle>",
      "<lifecycle onCreate() { go() }/>",
      "function Probe(input: Input): string {",
    ],
    [
      "<script>",
      "<script>go()</script>",
      "function Probe(input: Input): string {",
    ],
    [
      "client block",
      "client\n  const x = 1",
      "function Probe(input: Input): string {",
    ],
    ["<id>", "<id/x/>", "function Probe(input: Input): string {"],
  ])(
    "the default policy still renders %s the same as before (unaffected by strict)",
    (_name, body, expectedSubstring) => {
      const { code } = compile(src(body), file);
      expect(code).toContain(expectedSubstring);
    },
  );

  it("still compiles ordinary stock Marko unchanged under { strict: true }", () => {
    const body = "<if=input.ok><p>yes</p></if><else><p>no</p></else>";
    const strictResult = compile(src(body), file, { strict: true });
    const defaultResult = compile(src(body), file);
    expect(strictResult.code).toBe(defaultResult.code);
  });

  it("input-shadowing is rejected under both the default and strict policies", () => {
    // <const>, not <let>: <let> is itself a STRICT_TAGS row, so under strict
    // it would error for being reactive before the input-shadow check ever
    // runs. <const> isn't reactive, so it isolates the shadow check.
    const body = "<const/input=1/>\n<p>x</p>";
    expect(() => compile(src(body), file)).toThrow(
      /collides with the template input parameter/,
    );
    expect(() => compile(src(body), file, { strict: true })).toThrow(
      /collides with the template input parameter/,
    );
  });
});

// Ref custom-tags-import-precedence: spec §4's precedence (explicit import >
// local tags/ > mx.tags) means a file-local binding wins over a registered
// custom tag — but only a PascalCase one, matching Marko's own rule that a
// lowercase local variable is never resolved as a component call.
describe("import precedence over registered custom tags", () => {
  const marker: CustomTag = {
    transform: (_call, ctx) => [ctx.build.element("mx-marker", [], [])],
  };

  it("resolves an imported PascalCase component over a registered custom tag of the same name", () => {
    const body = ['import Panel from "./panel.mx"', "<Panel/>"].join("\n");
    const { code } = compile(src(body), file, {
      customTags: { Panel: marker },
    });
    expect(code).not.toContain("mx-marker");
    expect(code).toContain("__mxRenderTag(__mxOut, Panel)(");
  });

  // Round 1 regression: `fileLocalBinding` had no casing guard, so a
  // *lowercase* import shadowed a registered custom tag of the same name —
  // even though Marko itself never resolves a lowercase local variable as a
  // component. Measured on main before this fix: this compiled clean and
  // expanded the custom tag; after the regression, it started throwing
  // "Local variables must be in a dynamic tag unless they are PascalCase."
  it("does not let a lowercase import shadow a registered custom tag of the same name", () => {
    const body = ['import panel from "./panel.mx"', "<panel/>"].join("\n");
    const { code } = compile(src(body), file, {
      customTags: { panel: marker },
    });
    expect(code).toContain("mx-marker");
  });

  // Same regression, against a host-claimed lowercase tag instead of a
  // registered custom tag: `<style>` is claimed by this host's own
  // `isDelegatedTag`, and an unrelated lowercase import of the same name must not
  // block that claim either.
  it("does not let a lowercase import shadow a host-claimed tag of the same name", () => {
    const body = [
      'import style from "./style.ts"',
      "<style>a { color: red; }</style>",
    ].join("\n");
    const { code } = compile(src(body), file);
    expect(code).toContain("a { color: red; }");
  });

  it("still resolves a registered custom tag over an unbound name (no import, no <define>)", () => {
    const { code } = compile(src("<Widget/>"), file, {
      customTags: { Widget: marker },
    });
    expect(code).toContain("mx-marker");
  });
});

// Ref custom-tags-local-bindings (decision 113): a file-local *scope*
// binding — `<const/Panel=…/>`, a `<for|Panel|>` param, a
// `<define/Box|Panel|>` param — shadows a registered custom tag of the same
// name too, scoped to where the binding is in effect. IR-level coverage
// lives in `packages/core/src/custom-tags.test.ts`; these are the executed
// renders the brief required, against the real `compile()` entry point and a
// real registered custom tag.
describe("local scope bindings shadow a registered custom tag (executed)", () => {
  const panel: CustomTag = {
    transform: (_call, ctx) => [ctx.build.element("mx-marker", [], [])],
  };

  async function renderWithCustomTag(body: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-local-binding-"));
    try {
      writeFileSync(
        join(dir, "local-panel.ts"),
        'export default function LocalPanel(): string { return "<span>local-panel</span>"; }\n',
      );
      const path = join(dir, "entry.mx");
      const code = compile(src(body), path, {
        customTags: { Panel: panel },
      }).code.replaceAll(
        'from "@mxlang/target-html"',
        `from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))}`,
      );
      writeFileSync(path.replace(/\.mx$/, ".ts"), code);
      const module = (await import(
        `${pathToFileURL(path.replace(/\.mx$/, ".ts")).href}?t=${Date.now()}`
      )) as { default: (value: unknown) => string };
      return module.default({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  // Round 2 (lead review): a `<const>` never restores its own shadow (by
  // design), so leak prevention comes entirely from the `<if>` branch's own
  // scope wrapper. Executed proof that the round-2 fix to `scopeBindings`
  // (core.ts) reverts `ctx.tagVarShadowed` too, not only `ctx.bindings`.
  it("a `<const/Panel=…/>` binding inside an `<if>` branch renders the registered custom tag immediately outside the branch", async () => {
    const html = await renderWithCustomTag(
      [
        'import LocalPanel from "./local-panel.ts"',
        "<if=true>",
        "<const/Panel=LocalPanel/>",
        "<Panel/>",
        "</if>",
        "<Panel/>",
      ].join("\n"),
    );
    expect(html).toBe("<span>local-panel</span><mx-marker></mx-marker>");
  });

  it("a `<const/Panel=…/>` binding inside an `<else>` branch renders the registered custom tag immediately outside the chain", async () => {
    const html = await renderWithCustomTag(
      [
        'import LocalPanel from "./local-panel.ts"',
        "<if=false>",
        "<p>a</p>",
        "</if>",
        "<else>",
        "<const/Panel=LocalPanel/>",
        "<Panel/>",
        "</else>",
        "<Panel/>",
      ].join("\n"),
    );
    expect(html).toBe("<span>local-panel</span><mx-marker></mx-marker>");
  });

  it("a `<const/Panel=…/>` binding inside an `<if>` nested in a `<for>` body renders the registered custom tag immediately outside both scopes", async () => {
    const html = await renderWithCustomTag(
      [
        'import LocalPanel from "./local-panel.ts"',
        "<for|x| of=[1]>",
        "<if=true>",
        "<const/Panel=LocalPanel/>",
        "<Panel/>",
        "</if>",
        "<Panel/>",
        "</for>",
        "<Panel/>",
      ].join("\n"),
    );
    expect(html).toBe(
      "<span>local-panel</span><mx-marker></mx-marker><mx-marker></mx-marker>",
    );
  });
});

// The emitter trusts the IR's `void` (decision 197), so a custom tag's
// `ctx.build.element("br")` is void because the builder defaults `void` from
// the target's native elements, not because the emitter re-reads a table
// (review 475 r3). An explicit `void` still wins.
describe("a custom tag's built void elements (executed)", () => {
  async function render(tag: CustomTag): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-built-void-"));
    try {
      const path = join(dir, "entry.mx");
      const code = compile(src("<built/>"), path, {
        customTags: { built: tag },
      }).code.replaceAll(
        'from "@mxlang/target-html"',
        `from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))}`,
      );
      writeFileSync(path.replace(/\.mx$/, ".ts"), code);
      const module = (await import(
        `${pathToFileURL(path.replace(/\.mx$/, ".ts")).href}?t=${Date.now()}`
      )) as { default: (value: unknown) => string };
      return module.default({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("renders a built `<br>` and `<img>` without a close tag", async () => {
    const html = await render({
      transform: (_call, ctx) => [
        ctx.build.element("p", [], [ctx.build.text("a")]),
        ctx.build.element("br"),
        ctx.build.element("img", [ctx.build.attr("src", "x")]),
      ],
    });
    expect(html).toBe('<p>a</p><br><img src="x">');
  });

  it("keeps an explicit `void` either way", async () => {
    const html = await render({
      transform: (_call, ctx) => [
        ctx.build.element("br", [], [], { void: false }),
        ctx.build.element("mx-icon", [], [], { void: true }),
      ],
    });
    expect(html).toBe("<br></br><mx-icon>");
  });
});

/**
 * A tag template is a compilation unit (decision 95), so these compile the
 * *unit itself* through this host rather than only its caller — the half a
 * caller-side test cannot reach, since the template's body never enters the
 * caller's module.
 */
describe("a tag template compiles as its own module", () => {
  const unitFile = "/tmp/mx-translator-test/tags/unit.mx";

  // A6. The augmentation is what makes an imported call passing `content`
  // typecheck; without a test, deleting it would fail nothing.
  it("augments Input with content when the template reads it", () => {
    const { code } = compile(
      src("<section><${input.content}/></section>"),
      unitFile,
    );
    expect(code).toContain(
      "function Unit(input: Input & { content?: () => string }): string",
    );
  });

  it("leaves Input alone when the template never reads content", () => {
    const { code } = compile(src("<section>fixed</section>"), unitFile);
    expect(code).toContain("function Unit(input: Input): string");
    expect(code).not.toContain("content?: () => string");
  });

  // A7. The old crash was `unexpected module-level node kind "Static" in the
  // body walk`, raised while lowering a template *into* its caller. Compiling
  // the unit is what actually exercises the path that used to crash: the
  // `static` has to resolve to this module's own scope.
  it("compiles a template containing static, at module scope", () => {
    const { code } = compile(
      src('static const LABEL = "ok"\n<span>${LABEL}</span>'),
      unitFile,
    );
    const statementLine = code.indexOf('const LABEL = "ok"');
    const renderLine = code.indexOf("function Unit(");
    expect(statementLine).toBeGreaterThan(-1);
    // Module scope means *before* the render function, not hoisted into it.
    expect(statementLine).toBeLessThan(renderLine);
    expect(code).toContain("__mxEscape(LABEL)");
  });

  // A8. A self-recursive tag: the unit imports itself, which is legal ESM.
  it("compiles a self-recursive template", () => {
    const source = src(
      "<li>${input.node.label}" +
        "<if=input.node.kids><ul><for|k| of=input.node.kids><tree node=k/></for></ul></if>" +
        "</li>",
    );
    const tree: TemplateBackedTag = {
      template: { filename: "/tmp/mx-translator-test/tags/tree.mx", source },
    };
    const { code } = compile(source, "/tmp/mx-translator-test/tags/tree.mx", {
      customTags: { tree },
    });
    // Invariant §7.5-7: the render function is a named declaration, so the
    // recursive call resolves to it in this module's own scope. Importing the
    // file into itself works under ESM but is a module importing a binding it
    // already has.
    expect(code).not.toMatch(/import\s+\$mx_Tree\d+\s+from\s+"\.\/tree\.mx"/);
    expect(code).toContain("function Tree(");
    // The call site is the export's own name.
    expect(code).toMatch(/Tree\.render\(\{/);
  });
});

/**
 * `<return>` and `/var` on this host (acceptance C3).
 *
 * The two halves have to be asserted together: the unit's export shape is
 * what the call site unwraps, so a test of either alone would pass against a
 * pair that does not fit.
 */
describe("a unit that returns a value", () => {
  const counterFile = "/tmp/mx-return-test/tags/counter.mx";
  const pageFile = "/tmp/mx-return-test/page.mx";

  const counterSource = src(
    [
      "export interface Input { start: number }",
      "<span>${input.start}</span>",
      "<return value=input.start + 1/>",
    ].join("\n"),
  );

  const counter: TemplateBackedTag = {
    template: { filename: counterFile, source: counterSource },
  };

  it("returns the value from render and keeps the default export a string", () => {
    const { code } = compile(counterSource, counterFile);

    expect(code).toContain("  return input.start + 1;\n}");
    // Un-annotated, so the value's type is inferred from the expression —
    // that inference is what types the `/var` binding at the call site.
    expect(code).toContain(
      "function __mxRender(input: Input, __mxOut: __MxOut) {",
    );
    expect(code).toContain("function Counter(input: Input): string {");
  });

  it("binds /var to the call's render value, writing into the caller's sink", () => {
    const { code } = compile(
      src("<counter/n start=1/>\n<p>${n}</p>"),
      pageFile,
      {
        customTags: { counter },
      },
    );

    // Invariant §7.5-4's sequence: the output lands where the call stood
    // and the `/var` binds the value, in one evaluation of the call.
    expect(code).toMatch(
      /const n = \$mx_\w+\.render\(\{ start: 1 \}, __mxOut\);/,
    );
    // And the binding is readable after the call.
    expect(code).toContain("__mxEscape(n)");
  });

  it("renders into the sink and drops the value when the call binds no /var", () => {
    const { code } = compile(src("<counter start=1/>"), pageFile, {
      customTags: { counter },
    });

    expect(code).toMatch(/\n {2}\$mx_\w+\.render\(\{ start: 1 \}, __mxOut\);/);
  });

  it("binds each /var call site to its own call", () => {
    const { code } = compile(
      src("<counter/a start=1/>\n<counter/b start=2/>\n<p>${a}${b}</p>"),
      pageFile,
      { customTags: { counter } },
    );

    expect(code).toMatch(
      /const a = \$mx_\w+\.render\(\{ start: 1 \}, __mxOut\);/,
    );
    expect(code).toMatch(
      /const b = \$mx_\w+\.render\(\{ start: 2 \}, __mxOut\);/,
    );
  });

  it("rejects /var on a tag whose template has no <return>", () => {
    const plain: TemplateBackedTag = {
      template: {
        filename: "/tmp/mx-return-test/tags/plain.mx",
        source: src("<span>x</span>"),
      },
    };

    expect(() =>
      compile(src("<plain/x/>"), pageFile, { customTags: { plain } }),
    ).toThrow(/`<plain>` does not return a value/);
  });

  // Ruling 7 / invariant §7.5-8. A `/var` is an ordinary `let` in the call
  // site's own scope; Marko instead hoists it into a getter, which changes
  // the binding's user-visible type. MX rejects the escape, and both of
  // these would otherwise reach the emitted JS as `undefined` or a run-time
  // TDZ rather than as a diagnostic.
  it("rejects a /var read outside its declaring block", () => {
    expect(() =>
      compile(
        src("<if=true><counter/n start=1/></if>\n<p>${n}</p>"),
        pageFile,
        { customTags: { counter } },
      ),
    ).toThrow(/`n` is a `\/var` bound inside a nested block/);
  });

  it("rejects a /var read before the call that binds it", () => {
    expect(() =>
      compile(src("<p>${n}</p>\n<counter/n start=1/>"), pageFile, {
        customTags: { counter },
      }),
    ).toThrow(/`n` is read before the `\/var` that binds it/);
  });

  // Both of these were rejected by the first implementation, which matched
  // the *printed* expression text against the bound name. They are the two
  // shapes a regex cannot tell from a real read, and each rejected a valid
  // program with an error its author could not act on.
  it("does not mistake a string literal's contents for a read", () => {
    const { code } = compile(
      src('<p>${"the letter n"}</p>\n<counter/n start=1/>\n<p>${n}</p>'),
      pageFile,
      { customTags: { counter } },
    );

    expect(code).toMatch(/const n = \$mx_\w+\.render\(/);
  });

  it("does not mistake a shadowing tag param for the /var", () => {
    // `n` inside the loop is the loop's own parameter — same spelling, a
    // different variable — so the `/var` bound in the `<if>` is not what
    // this body reads and its scope is irrelevant here.
    const { code } = compile(
      src(
        "<if=true><counter/n start=1/></if>\n<for|n| of=[1,2]><p>${n}</p></for>",
      ),
      pageFile,
      { customTags: { counter } },
    );

    expect(code).toContain("__mxEscape(n)");
  });

  it("allows a read from a block nested inside the declaring one", () => {
    const { code } = compile(
      src("<counter/n start=1/>\n<if=true><p>${n}</p></if>"),
      pageFile,
      { customTags: { counter } },
    );

    // Ordinary JS closure scoping: the binding is in scope for the block.
    expect(code).toContain("__mxEscape(n)");
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("rejects an expression-valued event handler: a string render has no runtime", () => {
    const body = "<button onClick=handler>x</button>";
    expect(() => compile(src(body), file)).toThrow(
      "`onClick` is an event handler and requires a runtime; @mxlang/target-html renders once to a string",
    );
  });

  it("rejects a custom event name the same way", () => {
    const body = "<div on-my-event=fn>x</div>";
    expect(() => compile(src(body), file)).toThrow(
      "`on-my-event` is an event handler and requires a runtime; @mxlang/target-html renders once to a string",
    );
  });

  it("emits a static inline handler string verbatim", () => {
    // Spec §4: a string-valued `onclick` stays an ordinary static attribute;
    // MX does not invent a policy against inline handler strings.
    const { code } = compile(
      src('<button onclick="alert(1)">x</button>'),
      file,
    );
    // The emitted module escapes the quotes for its own JS string, which is
    // what "verbatim" means at this layer — the rendered attribute is
    // `onclick="alert(1)"`.
    expect(code).toContain('onclick=\\"alert(1)\\"');
  });

  it("rejects on: with Marko's exact event-name fix-it", () => {
    const body = "<div on:click=fn>x</div>";
    expect(() => compile(src(body), file)).toThrow(
      "`on:click` is not a valid attribute, did you mean `onClick`?",
    );
  });
});

describe("event error positions", () => {
  it("positions the event error at the attribute name", () => {
    let error: unknown;
    try {
      compile(src("<div   onClick=fn>x</div>"), file);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ line: 1, column: 7 });
  });
});
