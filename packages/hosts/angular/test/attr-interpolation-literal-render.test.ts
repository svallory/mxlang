// @vitest-environment jsdom
import { Component } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
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
