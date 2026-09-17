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
 * conventions that differ from `@mxlang/html`'s dialect.
 *
 * The distinction the table turns on: a construct that only configures
 * behaviour after the first render is inert, and one that contributes output
 * bytes must lower. "My code cannot do this" is never a row.
 */

const src = (body: string) => (body.endsWith("\n") ? body : `${body}\n`);
const file = "/tmp/mx-translator-test/probe.marko";

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
    expect(code).toContain('out += "<p>a</p>"');
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
    expect(code).toContain('out += "<p>a</p>"');
    expect(code).not.toContain("console.log");
  });
});

describe("class:foo / style:foo modifiers", () => {
  // Marko 5.42.5 has no such modifier: its own parser rejects every form
  // ("`class:active` is not a valid attribute, did you mean
  // `class={ active: condition }`?"), so matching Marko means rejecting them.
  // The message must be this dialect's own — the shared core's fallback is
  // `@mxlang/html`'s "standalone template" wording, which is `.mx` vocabulary
  // leaking into a Marko-parity target.
  it.each([
    ["class:active", "<div class:active=input.on>a</div>"],
    ["style:color", '<div style:color="red">d</div>'],
  ])("rejects %s with Marko's own guidance", (_name, body) => {
    expect(() => compile(src(body), file)).toThrow(
      /is not a valid attribute; Marko rejects this form too/,
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
});

describe("<html-comment> lowers placeholders", () => {
  it("emits interpolated values rather than dropping them", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const body = "<html-comment>build ${input.sha}</html-comment>";
    const { code } = compile(src(body), file);
    expect(code).toContain("escapeComment(input.sha)");
    expect(code).toContain("function escapeComment");
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
    expect(code).toContain('out += "<p>a</p>"');
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
      code.indexOf("function render(input: Input): string {"),
    );
    expect(code).toContain("escape(S)");
  });

  it("rejects <return>, naming the parent template it cannot reach", () => {
    expect(() => compile(src("<return=42/>"), file)).toThrow(
      /`<return>` provides a value to the \*parent\* template/,
    );
  });
});

describe("evaluate-initial-value constructs (decision 65)", () => {
  it("<let> binds its initial value", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const { code } = compile(src("<let/count=5/>\n<p>${count}</p>"), file);
    expect(code).toContain("const count = 5;");
    expect(code).toContain("escape(count)");
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
    expect(code).toContain("escape(v)");
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

describe("<try> without a placeholder is a plain try/catch", () => {
  it("lowers the body and its <@catch>", () => {
    const body = "<try><p>b</p><@catch|e|><p>err</p></@catch></try>";
    const { code } = compile(src(body), file);
    expect(code).toContain("try {");
    expect(code).toContain("} catch (e) {");
  });

  // Round 1 item 1 regression: a whitespace-only `<try>` body must still
  // reach the emitter, matching `lowerHostTag`'s old unconditional lowering
  // rather than being dropped by the `hasContent` gate an ordinary custom
  // tag's body uses.
  it("preserves a whitespace-only body", () => {
    const { code } = compile(src("<try>  </try>"), file);
    expect(code).toContain('out += " ";');
  });

  it("preserves markup mixed with text in the body", () => {
    const { code } = compile(src("<try>a <b>c</b></try>"), file);
    expect(code).toContain('out += "a <b>c</b>";');
  });
});

describe("class and style take Marko's structured values", () => {
  it.each([
    ["object", "<div class={a: true, b: false}>x</div>", "classValue({"],
    ["array", '<div class=["x", {y: true}]>z</div>', "classValue(["],
    ["style object", '<div style={color: "red"}>s</div>', "styleValue({"],
  ])("%s", (_name, body, expected) => {
    expect(compile(src(body), file).code).toContain(expected);
  });

  it("emits the helper only when something calls it", () => {
    const plain = compile(src("<p>a</p>"), file).code;
    expect(plain).not.toContain("function classValue");
    expect(plain).not.toContain("function renderDynamic");
  });
});

describe("attribute tags are renderables, Marko's convention", () => {
  // `@mxlang/html` passes callable function props (S3); Marko passes
  // renderables read with `<${input.header}/>`, and a repeated attribute tag
  // is an array. The two conventions are incompatible, which is exactly why
  // this is a separate package rather than a flag.
  it("passes a single attribute tag as a named prop", () => {
    const body =
      'import Panel from "./panel.marko"\n<Panel><@header>H</@header></Panel>';
    expect(compile(src(body), file).code).toContain("header: (");
  });

  it("passes a repeated attribute tag as an array", () => {
    const body =
      'import List from "./list.marko"\n<List><@item>a</@item><@item>b</@item></List>';
    const { code } = compile(src(body), file);
    expect(code).toMatch(/item: \[\(/);
  });

  it("names ordinary children `content`, the prop Marko's own tags read", () => {
    const body = 'import Panel from "./panel.marko"\n<Panel>body</Panel>';
    const { code } = compile(src(body), file);
    expect(code).toContain("content: (");
    expect(code).not.toContain("children:");
  });
});

describe("dynamic tags", () => {
  it("lowers `<${expr}/>` through the runtime dispatcher", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko dynamic-tag syntax in template source
    const { code } = compile(src("<${input.tag}/>"), file);
    expect(code).toContain("renderDynamic(input.tag");
    expect(code).toContain("function renderDynamic");
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
  it("imports escape and default-exports the renderer", () => {
    const { code } = compile(src("<p>hi</p>"), file);
    expect(code).toContain('import { escape } from "@mxlang/html";');
    expect(code).toContain("function render(input: Input): string {");
    expect(code).toContain("export default render;");
  });

  it("brands the default export so a host's `check()` can recognize it", () => {
    // A framework host receives a component as an opaque value —
    // `@mxlang/astro`'s renderer gets `check(Component, props, slots)` and
    // nothing else — so the compiled function carries a marker rather than
    // being identified by name (which a minifier may rewrite) or by call
    // shape (which every `(props) => string` function shares).
    //
    // `Symbol.for`, through the global registry: the property is written here
    // and read from another package, possibly from a different copy of this
    // one on disk, so the two sides cannot agree by import identity.
    const { code } = compile(src("<p>hi</p>"), file);
    expect(code).toContain(
      'Object.defineProperty(render, Symbol.for("mx.component"), { value: true });',
    );
  });

  it("throws rather than silently skipping the brand when the export line drifts", () => {
    // The brand is injected by matching a literal, so a change to the core's
    // emitted export line would otherwise make `brandRender` a no-op: the
    // module compiles, nothing reports a problem, and every `check()` in the
    // Astro host answers false — a whole host quietly failing to claim its own
    // components. Decision 61: fail loud at the seam that broke.
    const drifted = [
      'import { escape } from "@mxlang/html";',
      "",
      "export interface Input {}",
      "",
      "export default function render(input: Input): string {",
      '  return "";',
      "}",
      "",
    ].join("\n");

    expect(() => brandRender(drifted)).toThrow(
      /does not contain the expected default export line/,
    );
  });

  it("brands the default export when inline helpers are emitted too", () => {
    // The helper injection and the brand are two rewrites of the same emitted
    // line, so a template that triggers `classValue` exercises the path where
    // both apply — the one that would silently lose the brand if the rewrites
    // were ordered wrongly.
    const { code } = compile(src("<p class={a: true}>hi</p>"), file);
    expect(code).toContain("function classValue(value) {");
    expect(code).toContain(
      'Object.defineProperty(render, Symbol.for("mx.component"), { value: true });',
    );
    expect(code).toContain("export default render;");
  });

  it("hoists imports and static blocks above the render function", () => {
    const body = 'static const G = "hi"\n<p>x</p>';
    const { code } = compile(src(body), file);
    expect(code.indexOf('const G = "hi"')).toBeLessThan(
      code.indexOf("function render(input: Input): string {"),
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
  ])("rejects %s under { strict: true }", (_name, body, message) => {
    expect(() => compile(src(body), file, { strict: true })).toThrow(message);
  });

  it.each([
    ["<let>", "<let/count=5/>\n<p>${count}</p>", "const count = 5;"],
    [
      "<effect>",
      "<effect() { go() }/>",
      "function render(input: Input): string {",
    ],
    [
      "<lifecycle>",
      "<lifecycle onCreate() { go() }/>",
      "function render(input: Input): string {",
    ],
    [
      "<script>",
      "<script>go()</script>",
      "function render(input: Input): string {",
    ],
    [
      "client block",
      "client\n  const x = 1",
      "function render(input: Input): string {",
    ],
    ["<id>", "<id/x/>", "function render(input: Input): string {"],
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
    const body = ['import Panel from "./panel.marko"', "<Panel/>"].join("\n");
    const { code } = compile(src(body), file, {
      customTags: { Panel: marker },
    });
    expect(code).not.toContain("mx-marker");
    expect(code).toContain("Panel(");
  });

  // Round 1 regression: `fileLocalBinding` had no casing guard, so a
  // *lowercase* import shadowed a registered custom tag of the same name —
  // even though Marko itself never resolves a lowercase local variable as a
  // component. Measured on main before this fix: this compiled clean and
  // expanded the custom tag; after the regression, it started throwing
  // "Local variables must be in a dynamic tag unless they are PascalCase."
  it("does not let a lowercase import shadow a registered custom tag of the same name", () => {
    const body = ['import panel from "./panel.marko"', "<panel/>"].join("\n");
    const { code } = compile(src(body), file, {
      customTags: { panel: marker },
    });
    expect(code).toContain("mx-marker");
  });

  // Same regression, against a host-claimed lowercase tag instead of a
  // registered custom tag: `<style>` is claimed by this host's own
  // `claimsTag`, and an unrelated lowercase import of the same name must not
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
      "function render(input: Input & { content?: () => string }): string",
    );
  });

  it("leaves Input alone when the template never reads content", () => {
    const { code } = compile(src("<section>fixed</section>"), unitFile);
    expect(code).toContain("function render(input: Input): string");
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
    const renderLine = code.indexOf("function render(");
    expect(statementLine).toBeGreaterThan(-1);
    // Module scope means *before* the render function, not hoisted into it.
    expect(statementLine).toBeLessThan(renderLine);
    expect(code).toContain("escape(LABEL)");
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
    expect(code).toMatch(/import\s+\$mx_Tree\d+\s+from\s+"\.\/tree\.mx"/);
    expect(code).toContain("function render(");
  });
});
