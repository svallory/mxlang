import { describe, expect, it } from "vitest";
import { assertAngularParses, compileMx, emit } from "./helpers.ts";

describe("Text", () => {
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
