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
      code.indexOf("function Probe(input: Input): string {"),
    );
    expect(code).toContain("escape(S)");
  });

  // This host used to reject `<return>` outright, on the grounds that "a
  // module compiled to `(input) => string` has no parent to return to". That
  // was true only while a tag template was expanded into its caller. Under
  // the unit model (decision 95) every `.mx` file is a module and a caller
  // invokes it, so the tag has somewhere to return to — and a *page* is not
  // a special case: it is a module that returns a value nobody reads yet.
  it("accepts <return> in a page, with the same meaning as in a tag", () => {
    const { code } = compile(src("<p>x</p>\n<return=42/>"), file);

    expect(code).toContain("return { value: 42, output: out };");
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

  it("lowers a bare `${expr}` concise-position line the same way, since this host claims DYNAMIC_TAG for both shapes", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko concise-mode placeholder/dynamic-tag syntax in template source
    const { code } = compile(src("${input.tag}\n"), file);
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
    expect(code).toContain("function Probe(input: Input): string {");
    expect(code).toContain("export default Probe;");
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
      'import { escape } from "@mxlang/html";',
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
    expect(code).toContain("function classValue(value) {");
    expect(code).toContain(
      'Object.defineProperty(Probe, Symbol.for("mx.component"), { value: true });',
    );
    expect(code).toContain("export default Probe;");
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
    // Invariant §7.5-7: the render function is a named declaration, so the
    // recursive call resolves to it in this module's own scope. Importing the
    // file into itself works under ESM but is a module importing a binding it
    // already has.
    expect(code).not.toMatch(/import\s+\$mx_Tree\d+\s+from\s+"\.\/tree\.mx"/);
    expect(code).toContain("function Tree(");
    // The call site is the export's own name.
    expect(code).toMatch(/Tree\(\{/);
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

  it("returns { value, output } instead of the output alone", () => {
    const { code } = compile(counterSource, counterFile);

    expect(code).toContain("return { value: input.start + 1, output: out };");
    // Un-annotated, so the value's type is inferred from the expression —
    // that inference is what types the `/var` binding at the call site.
    expect(code).toContain("function Counter(input: Input) {");
    expect(code).not.toContain("function Counter(input: Input): string");
  });

  it("binds /var through a temp, then emits the output where the call stood", () => {
    const { code } = compile(
      src("<counter/n start=1/>\n<p>${n}</p>"),
      pageFile,
      {
        customTags: { counter },
      },
    );

    // Invariant §7.5-4's sequence: the call bound to a temp, the `/var` read
    // off it, then the output. The temp is what makes the call evaluate once
    // while both halves are read.
    const call = code.indexOf("const $mx_ret0 = ");
    const bind = code.indexOf("const n = $mx_ret0.value;");
    const out = code.indexOf("out += $mx_ret0.output;");
    expect(call).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(call);
    expect(out).toBeGreaterThan(bind);
    // And the binding is readable after the call.
    expect(code).toContain("escape(n)");
  });

  it("unwraps the output when the call binds no /var", () => {
    const { code } = compile(src("<counter start=1/>"), pageFile, {
      customTags: { counter },
    });

    expect(code).toContain(").output;");
    expect(code).not.toContain("$mx_ret");
  });

  it("gives each /var call site its own temp", () => {
    const { code } = compile(
      src("<counter/a start=1/>\n<counter/b start=2/>\n<p>${a}${b}</p>"),
      pageFile,
      { customTags: { counter } },
    );

    expect(code).toContain("const a = $mx_ret0.value;");
    expect(code).toContain("const b = $mx_ret1.value;");
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

    expect(code).toContain("const n = $mx_ret0.value;");
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

    expect(code).toContain("escape(n)");
  });

  it("allows a read from a block nested inside the declaring one", () => {
    const { code } = compile(
      src("<counter/n start=1/>\n<if=true><p>${n}</p></if>"),
      pageFile,
      { customTags: { counter } },
    );

    // Ordinary JS closure scoping: the binding is in scope for the block.
    expect(code).toContain("escape(n)");
  });
});

describe("event attributes (decision 101, phase B of dom-events)", () => {
  it("rejects an expression-valued event handler: a string render has no runtime", () => {
    const body = "<button onClick=handler>x</button>";
    expect(() => compile(src(body), file)).toThrow(
      "`onClick` is an event handler and requires a runtime; @mxlang/html renders once to a string",
    );
  });

  it("rejects a custom event name the same way", () => {
    const body = "<div on-my-event=fn>x</div>";
    expect(() => compile(src(body), file)).toThrow(
      "`on-my-event` is an event handler and requires a runtime; @mxlang/html renders once to a string",
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

  it("rejects on: with a fix-it naming on-<exact>", () => {
    const body = "<div on:click=fn>x</div>";
    expect(() => compile(src(body), file)).toThrow(
      "write `onClick=fn` for a DOM event or `on-click=fn` for a custom event name",
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
