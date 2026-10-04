import { describe, expect, it } from "vitest";
import {
  assertAngularParses,
  compileMx,
  emit,
  emitWithTags,
} from "./helpers.ts";

describe("Text", () => {
  it("protects Marko-normalized retained whitespace from Angular trimming (decision 141)", () => {
    const out = emit("<div> \t </div>");
    expect(out).toBe("<div>&ngsp;</div>");
    assertAngularParses(out);
    expect(emit("<div>\n  </div>")).toBe("<div></div>");
  });

  it("emits plain text unchanged", () => {
    const out = emit("-- Hello world");
    expect(out).toBe("Hello world");
    assertAngularParses(out);
  });

  it("escapes braces", () => {
    const out = emit("-- text { more");
    expect(out).toBe("text {{ '{' }} more");
    assertAngularParses(out);
  });

  it("escapes a bare closing brace", () => {
    const out = emit("-- text } more");
    expect(out).toBe("text {{ '}' }} more");
    assertAngularParses(out);
  });

  it("escapes a literal double brace", () => {
    const out = emit("-- {{ not an interpolation }}");
    expect(out).toBe(
      "{{ '{' }}{{ '{' }} not an interpolation {{ '}' }}{{ '}' }}",
    );
    assertAngularParses(out);
  });

  it("escapes braces in a static attribute value like in text (angular-attr-interpolation-literal)", () => {
    // Marko 6.3.51 renders `title="{{ x }}"` as the literal text `{{ x }}`
    // (probed: the whole tag compiles to one `_html(...)` string, braces
    // untouched), so a static value must be brace-escaped like static text.
    // The native-render proof lives in attr-interpolation-literal-render.test.ts.
    const out = emit('<div title="{{ x }}"></div>');
    expect(out).toBe(
      `<div title="{{ '{' }}{{ '{' }} x {{ '}' }}{{ '}' }}"></div>`,
    );
    assertAngularParses(out);
  });

  it("escapes a single brace in a static attribute value", () => {
    const out = emit('<div title="a { b"></div>');
    expect(out).toBe(`<div title="a {{ '{' }} b"></div>`);
    assertAngularParses(out);
  });

  it("does not escape @ in a static attribute value (rev F1)", () => {
    // The `@`-before-lowercase rule exists for *text*, where Angular lexes
    // `@` blocks; attribute values are never scanned for blocks, and the
    // entity would be double-escaped by esc (`&amp;#64;`) rendering as
    // the literal text `&#64;`. `@` must pass through like main.
    const mail = emit('<a href="mailto:me@example.com">x</a>');
    expect(mail).toBe('<a href="mailto:me@example.com">x</a>');
    assertAngularParses(mail);
    const handle = emit('<div title="@handle"></div>');
    expect(handle).toBe('<div title="@handle"></div>');
    assertAngularParses(handle);
  });

  it('escapes & and " in a static attribute value, keeping a literal &#64; (rev F1)', () => {
    // Marko does not decode entities in attribute values (probed: raw in,
    // raw out), so the emitter's value is the raw text and esc alone
    // round-trips it to the DOM.
    const out = emit("<div title='a \" b & c'>x</div>");
    expect(out).toBe('<div title="a &quot; b &amp; c">x</div>');
    assertAngularParses(out);
    const entity = emit('<div title="a &#64; b">x</div>');
    expect(entity).toBe('<div title="a &amp;#64; b">x</div>');
    assertAngularParses(entity);
  });

  it("does not escape @ in a static component input (rev F1)", () => {
    const out = emitWithTags('<MyComp title="@handle"/>', ["MyComp"]);
    expect(out).toBe('<mx-my-comp title="@handle"></mx-my-comp>');
    assertAngularParses(out);
  });

  it("emits a static class value with braces as an [attr.class] string binding (rev F2)", () => {
    // Angular's class pipeline re-tokenizes a static class, mangling
    // evaluated interpolation literals (`class="{{ x }}"` renders `x {{ }}`).
    // A property binding bypasses the pipeline; probed, Angular parses a
    // binding value as one expression with no interpolation splitting, so
    // the raw braces render exactly inside a string literal.
    const out = emit('<div class="{{ x }}"></div>');
    expect(out).toBe(`<div [attr.class]="'{{ x }}'"></div>`);
    assertAngularParses(out);
  });

  it("emits a static style value with braces as an [attr.style] string binding (rev F3)", () => {
    // Angular's style parser asserts on a static style holding braces;
    // [attr.style] bypasses it and renders the value exactly.
    const out = emit('<div style="{{ x }}"></div>');
    expect(out).toBe(`<div [attr.style]="'{{ x }}'"></div>`);
    assertAngularParses(out);
  });

  it("escapes quotes and backslashes inside the [attr.class] literal (rev F2)", () => {
    // Marko unescapes attribute values (`\c` -> `c`), so a real backslash
    // is written `\\` in source; the held value here is `a'b\c{x}`.
    const out = emit(`<div class="a'b\\\\c{x}"></div>`);
    expect(out).toBe(`<div [attr.class]="'a\\'b\\\\c{x}'"></div>`);
    assertAngularParses(out);
  });

  it("keeps a brace-free class/style value static (rev F2/F3)", () => {
    const out = emit('<div class="a b" style="color: red"></div>');
    expect(out).toBe('<div class="a b" style="color: red"></div>');
    assertAngularParses(out);
  });

  it("escapes @ before a lowercase identifier (@iffy)", () => {
    const out = emit("-- email me @iffy today");
    expect(out).toBe("email me &#64;iffy today");
    assertAngularParses(out);
  });

  it("escapes @if in prose", () => {
    const out = emit("-- try @if this fails");
    expect(out).toBe("try &#64;if this fails");
    assertAngularParses(out);
  });

  it("escapes @if even mid-word / non-boundary (design note A1, ruling R-a)", () => {
    // Probed against @angular/compiler 22.1.7: `(@if a)`, `[@for x]`,
    // `a-@if b`, `>@if<`, `.@let y` all fail unescaped — there is no
    // "boundary" that makes a block-keyword-prefixed `@` safe, so the host
    // escapes every `@` before a lowercase identifier, no exceptions.
    const out = emit("-- (@if a)");
    expect(out).toBe("(&#64;if a)");
    assertAngularParses(out);
  });

  it("does not escape @Component", () => {
    const out = emit("-- see @Component here");
    expect(out).toBe("see @Component here");
    assertAngularParses(out);
  });

  it("escapes @foo even though Angular itself would accept it unescaped (conservative superset)", () => {
    // `@foo` is not a block-keyword prefix and probes as `ok` unescaped, but
    // the host escapes every `@` + lowercase uniformly (R-a) rather than
    // encoding Angular's block-keyword list, which would drift on every new
    // Angular block release. Pinned so a future narrowing of the rule shows
    // up as a fixture change, per design note A6.
    const out = emit("-- @foo");
    expect(out).toBe("&#64;foo");
    assertAngularParses(out);
  });

  it("escapes @ in an email address too (R-a: no word-boundary exception)", () => {
    // Probed: `me&#64;example.com` parses and renders identically to
    // `me@example.com`, so escaping mid-identifier costs nothing and the
    // uniform rule needs no exception here.
    const out = emit("-- contact me@example.com please");
    expect(out).toBe("contact me&#64;example.com please");
    assertAngularParses(out);
  });
});

describe("Interpolation", () => {
  it("emits an escaped interpolation as {{ }}", () => {
    // Wrapped in a real element: a placeholder inside an HTML-syntax body
    // parses as a genuine `MarkoPlaceholder`, unlike a bare top-level
    // `${expr}` line, which is a dynamic-tag construct on every host since
    // core PR #103 (main 50877ea8) — see `component.test.ts`'s dynamic-tag
    // tests for that shape.
    const out = emit("<div>${user.name}</div>");
    expect(out).toBe("<div>{{ user.name }}</div>");
    assertAngularParses(out);
  });

  it("emits a raw interpolation as [innerHTML] with a warning naming the span caveat", () => {
    const { code, warnings } = compileMx("<div>$!{html}</div>");
    expect(code).toBe('<div><span [innerHTML]="html"></span></div>');
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "$!{…} has no exact Angular equivalent; emitted as [innerHTML] wrapped in a <span>, which Angular sanitizes. The wrapper is invalid inside <tbody>/<select>/<ul>, where only certain child elements are allowed — restructure those cases.",
    );
  });
});
