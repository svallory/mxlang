// @vitest-environment jsdom
/**
 * Primitive attribute values on native elements render as Marko 6.3.51's html
 * output does (decision 149), compared as parsed DOM against a live Marko
 * render of the same source (`scripts/attribute-value-probe.ts marko
 * --parity`, direct form: Angular rejects spreads). Real Angular renders in
 * TestBed/jsdom with unknown-property errors enabled.
 *
 * Documented divergence, pinned below: `style` strings are parsed as CSS by
 * Angular, so a non-declaration (`x`, `true`) renders no attribute.
 *
 * `<input value=v>` and `<input checked=v>` bind the live DOM property, so the
 * property is compared with what Marko prints as the attribute.
 */
import "@angular/compiler";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { NgClass, NgStyle } from "@angular/common";
import { Component } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface Template {
  form: string;
  template?: string;
  error?: string;
}
interface Row {
  form: string;
  value: string;
  html?: string;
  error?: string;
}

const values: Record<string, unknown> = {
  null: null,
  undefined: undefined,
  false: false,
  true: true,
  zero: 0,
  empty: "",
  x: "x",
};

let templates: Template[] = [];
let marko: Row[] = [];
beforeAll(() => {
  templates = JSON.parse(
    execFileSync(
      "bun",
      [
        "run",
        "--tsconfig-override=tsconfig.build.json",
        join(import.meta.dirname, "primitive-attribute-fixture.ts"),
      ],
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
    ),
  );
  marko = JSON.parse(
    execFileSync(
      "bun",
      [
        join(
          import.meta.dirname,
          "../../../../scripts/attribute-value-probe.ts",
        ),
        "marko",
        "--parity",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
}, 120_000);
afterEach(() => TestBed.resetTestingModule());

/** The first element's attributes, sorted, as canonical JSON. */
function attributes(html: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = html.replace(/<!--M_\$[\s\S]*?<\/script>\s*/g, "");
  const element = holder.firstElementChild as Element;
  const attrs = Object.fromEntries(
    [...element.attributes]
      .map((attr): [string, string] => [attr.name, attr.value])
      // Angular adds its own `ng-reflect-*`/`ng-version` markers.
      .filter(([name]) => !name.startsWith("ng-"))
      .sort(),
  );
  return `${element.localName}${JSON.stringify(attrs)}`;
}

function render(template: string, v: unknown): HTMLElement {
  class Probe {
    input = { v };
  }
  Component({
    selector: "mx-primitive-probe",
    template,
    imports: [NgClass, NgStyle],
  })(Probe);
  TestBed.configureTestingModule({ errorOnUnknownProperties: true });
  const fixture = TestBed.createComponent(Probe);
  fixture.detectChanges();
  return fixture.nativeElement.querySelector("div, input") as HTMLElement;
}

const forms = [
  "title",
  "data-x",
  "aria-x",
  "class",
  "style",
  "disabled",
  "checked",
  "value",
  "autofocus",
  "readonly",
  "selected",
  "required",
  "open",
  "allowfullscreen",
  "checked@div",
];

describe("angular primitive attribute values (real renders, Marko 6.3.51)", () => {
  for (const name of forms)
    it.each(Object.keys(values))(`${name} direct %s`, (key) => {
      const form = `${name}/direct`;
      const entry = templates.find((t) => t.form === form);
      expect(entry?.error, form).toBeUndefined();
      const expected = marko.find((r) => r.form === form && r.value === key);
      const element = render(entry?.template ?? "", values[key]);
      if (form === "checked/direct") {
        // The property mirrors Marko's presence-only attribute.
        expect((element as HTMLInputElement).checked).toBe(
          expected !== undefined &&
            attributes(expected.html ?? "").includes('"checked"'),
        );
        return;
      }
      if (form === "value/direct") {
        const printed = JSON.parse(
          attributes(expected?.html ?? "").replace(/^input/, ""),
        ) as { value?: string };
        expect((element as HTMLInputElement).value).toBe(printed.value ?? "");
        return;
      }
      if (name === "style" && (key === "true" || key === "x")) {
        // Angular parses a `style` string as CSS declarations: text that is no
        // declaration (`x`, `true`) renders no attribute. Marko prints it.
        expect(attributes(element.outerHTML)).toBe("div{}");
        return;
      }
      expect(attributes(element.outerHTML)).toBe(
        attributes(expected?.html ?? ""),
      );
    });
});
