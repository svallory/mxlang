// @vitest-environment jsdom
import { Component } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// The native-render half of angular-attr-interpolation-literal: proves the
// escaped template Angular actually renders, byte for byte. No MX compile
// happens here (Marko's module resolution does not run under jsdom); the
// template strings are the emitter's output, copied by the node-env sibling
// test's golden — if the emitter's escaping changes, that golden fails
// first and this file is updated with it.

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

describe("native Angular render of an escaped interpolation-looking literal", () => {
  it("renders the attribute value and text as the literal `{{ x }}`", () => {
    class Probe {}
    Component({
      selector: "mx-attr-literal-probe",
      // `<div title="{{ x }}">body {{ y }} text</div>` after the emitter's
      // brace escaping (both halves of the Marko literal).
      template: `<div title="{{ '{' }}{{ '{' }} x {{ '}' }}{{ '}' }}">body {{ '{' }}{{ '{' }} y {{ '}' }}{{ '}' }} text</div>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();

    const div = fixture.nativeElement.querySelector("div");
    expect(div.getAttribute("title")).toBe("{{ x }}");
    expect(div.textContent).toBe("body {{ y }} text");
  });
});

describe("rev F1: @ in a static attribute value renders as @, not &#64;", () => {
  it("renders @ in href and title exactly", () => {
    class Probe {}
    Component({
      selector: "mx-f1-probe",
      // `<a href="mailto:me@example.com">x</a><div title="@handle"></div>` —
      // the `@` rule is text-only; attribute values pass `@` through.
      template: `<a href="mailto:me@example.com">x</a><div title="@handle"></div>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("a").getAttribute("href")).toBe(
      "mailto:me@example.com",
    );
    expect(
      fixture.nativeElement.querySelector("div").getAttribute("title"),
    ).toBe("@handle");
  });

  it("renders @ in a component input exactly", () => {
    class Child {
      title = "(unset)";
    }
    Component({
      selector: "mx-f1-child",
      template: "",
      inputs: ["title"],
      standalone: false,
    })(Child);
    class Host {}
    Component({
      selector: "mx-f1-host",
      standalone: false,
      // `<MyComp title="@handle"/>` → element with the static input.
      template: `<mx-f1-child title="@handle"></mx-f1-child>`,
    })(Host);

    TestBed.configureTestingModule({ declarations: [Host, Child] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const child = fixture.debugElement.query(By.directive(Child));
    expect(child.componentInstance.title).toBe("@handle");
  });

  it('round-trips &, " and a literal &#64; to the raw value', () => {
    class Probe {}
    Component({
      selector: "mx-f1-entities-probe",
      // `<div title='a " b & c'></div><div title="a &#64; b"></div>` — Marko
      // does not decode entities in attribute values; esc alone round-trips.
      template: `<div title="a &quot; b &amp; c"></div><div title="a &amp;#64; b"></div>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();

    const [quoted, entity] = fixture.nativeElement.querySelectorAll("div");
    expect(quoted.getAttribute("title")).toBe('a " b & c');
    expect(entity.getAttribute("title")).toBe("a &#64; b");
  });
});

describe("rev F2/F3: class/style with braces render exactly via [attr.*]", () => {
  it("renders class and style values holding {{ x }} exactly", () => {
    class Probe {}
    Component({
      selector: "mx-f2-probe",
      // `<div class="{{ x }}"></div><div style="{{ x }}"></div>` — the
      // class/style pipelines mangle or assert on a static value holding
      // braces; [attr.*] bindings parse as one expression and render the
      // raw value exactly.
      template: `<div [attr.class]="'{{ x }}'"></div><div [attr.style]="'{{ x }}'"></div>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();

    const [cls, style] = fixture.nativeElement.querySelectorAll("div");
    expect(cls.getAttribute("class")).toBe("{{ x }}");
    expect(style.getAttribute("style")).toBe("{{ x }}");
  });

  it("renders authored-uppercase CLASS and STYLE holding braces exactly", () => {
    class Probe {}
    Component({
      selector: "mx-f2-case-probe",
      // `<div CLASS="{{ x }}"></div><div STYLE="{{ x }}"></div>` — the
      // [attr.*] binding is emitted lowercase; Angular's HTML parser
      // lowercases the authored name anyway.
      template: `<div [attr.class]="'{{ x }}'"></div><div [attr.style]="'{{ x }}'"></div>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();

    const [cls, style] = fixture.nativeElement.querySelectorAll("div");
    expect(cls.getAttribute("class")).toBe("{{ x }}");
    expect(style.getAttribute("style")).toBe("{{ x }}");
  });

  it("renders a class literal with quotes and backslashes exactly", () => {
    class Probe {}
    Component({
      selector: "mx-f2-quote-probe",
      // `<div class="a'b\c{x}"></div>` — ' and \ are expression-escaped
      // inside the single-quoted literal before the HTML layer.
      template: `<div [attr.class]="'a\\'b\\\\c{x}'"></div>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector("div").getAttribute("class"),
    ).toBe("a'b\\c{x}");
  });
});
