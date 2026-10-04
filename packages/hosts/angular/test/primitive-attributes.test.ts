// @vitest-environment jsdom
import "@angular/compiler";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NgClass, NgComponentOutlet, NgStyle } from "@angular/common";
import { Component } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, expect, it } from "vitest";

interface Template {
  form: string;
  template?: string;
  error?: string;
}
let templates: Template[];
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
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});
afterEach(() => TestBed.resetTestingModule());

it("measures native Angular renders of the primitive attribute matrix", () => {
  const values = {
    null: null,
    undefined: undefined,
    false: false,
    true: true,
    zero: 0,
    empty: "",
    NaN: NaN,
  };
  const rows: {
    form: string;
    value: string;
    html?: string;
    error?: string;
    checked?: boolean;
  }[] = [];
  for (const { form, template, error } of templates)
    for (const [value, v] of Object.entries(values)) {
      if (error) {
        rows.push({ form, value, error });
        continue;
      }
      const name = form.slice(0, form.indexOf("/"));
      class Probe {
        input = {
          v,
          name,
          tag: name === "checked" ? "input" : "div",
          attrs: { [name]: v },
        };
      }
      try {
        Component({
          selector: "mx-primitive-probe",
          template,
          imports: [NgClass, NgComponentOutlet, NgStyle],
        })(Probe);
        TestBed.configureTestingModule({ errorOnUnknownProperties: true });
        const fixture = TestBed.createComponent(Probe);
        fixture.detectChanges();
        const element = fixture.nativeElement.querySelector(
          "div, input",
        ) as HTMLElement;
        rows.push({
          form,
          value,
          html: element.outerHTML,
          ...(name === "checked"
            ? { checked: (element as HTMLInputElement).checked }
            : {}),
        });
        fixture.destroy();
      } catch (caught) {
        rows.push({
          form,
          value,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      } finally {
        TestBed.resetTestingModule();
      }
    }
  expect(rows).toHaveLength(504);
  // A real DOM render, rather than accepting parseTemplate() as rendering proof.
  expect(
    rows.find((row) => row.form === "data-x/direct" && row.value === "null")
      ?.html,
  ).toBe("<div></div>");
  expect(
    rows.find((row) => row.form === "data-x/direct" && row.value === "false")
      ?.html,
  ).toBe('<div data-x="false"></div>');
  if (process.env.MX_PRIMITIVE_EVIDENCE)
    writeFileSync(
      process.env.MX_PRIMITIVE_EVIDENCE,
      JSON.stringify(rows, null, 2),
    );
});
