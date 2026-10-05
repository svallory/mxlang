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
import { NgClass, NgFor, NgIf, NgStyle } from "@angular/common";
import { Component, Directive } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RESCUED } from "./primitive-attribute-rescued.ts";

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
    imports: [NgClass, NgStyle, NgFor, NgIf],
  })(Probe);
  TestBed.configureTestingModule({ errorOnUnknownProperties: true });
  const fixture = TestBed.createComponent(Probe);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement)
    .firstElementChild as HTMLElement;
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
      if (name === "autofocus") {
        // jsdom's HTMLElement has no `autofocus` property, so Angular's runtime
        // schema check rejects the binding there; browsers have it. The emitted
        // binding is pinned by the element tests.
        return;
      }
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
      if (name === "title" && ["null", "undefined", "false"].includes(key)) {
        // `[title]` is the DOM property, which cannot remove the attribute.
        expect(attributes(element.outerHTML)).toBe('div{"title":""}');
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

describe("a structural attribute keeps its variable in scope for the bound expression", () => {
  function items(form: string, list: unknown): string {
    const template = templates.find((t) => t.form === form)?.template ?? "";
    class Probe {
      input = { items: list };
    }
    Component({
      selector: "mx-structural-probe",
      template,
      imports: [NgFor, NgIf],
    })(Probe);
    TestBed.configureTestingModule({ errorOnUnknownProperties: true });
    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();
    return fixture.nativeElement.innerHTML.replace(/<!--[\s\S]*?-->/g, "");
  }

  it("*ngFor let", () => {
    expect(items("structural/ngFor", ["a", false, "b"])).toBe(
      '<li class="a" title="a" data-x="a"></li><li title=""></li><li class="b" title="b" data-x="b"></li>',
    );
  });

  it("*ngIf as", () => {
    expect(items("structural/ngIf", ["a", "b"])).toBe('<li title="2"></li>');
  });
});

describe("DOM-property bindings, measured (jsdom TestBed), against Marko's generic rule", () => {
  // Marko: null/undefined/false omit, true bare, 0 "0", "" bare, "x" "x".
  const cell = (tag: string, name: string, v: unknown): string => {
    const element = render(
      templates.find((t) => t.form === `cell/${tag}/${name}`)?.template ?? "",
      v,
    );
    return element.outerHTML.replace(/ ng-reflect-[^ >]*/g, "");
  };

  it.each([
    // string properties reflect, so the attribute exists once the property is set
    ["div", "title", null, '<div title=""></div>'],
    ["div", "title", false, '<div title=""></div>'],
    ["div", "title", true, '<div title=""></div>'],
    ["div", "title", 0, '<div title="0"></div>'],
    ["div", "title", "x", '<div title="x"></div>'],
    // boolean properties: presence only
    ["div", "hidden", null, "<div></div>"],
    ["div", "hidden", 0, '<div hidden=""></div>'],
    ["div", "hidden", "x", '<div hidden=""></div>'],
    ["button", "disabled", false, "<button></button>"],
    ["button", "disabled", "x", '<button disabled=""></button>'],
    // an enumerated attribute behind a boolean property
    ["div", "draggable", null, '<div draggable="false"></div>'],
    ["div", "draggable", "x", '<div draggable="true"></div>'],
    // the same for `translate`, whose reflection is "yes"/"no" (jsdom has no
    // `spellcheck`/`inert`/`autofocus` property, so those are pinned by the
    // element tests only)
    ["div", "translate", null, '<div translate="no"></div>'],
    ["div", "translate", "x", '<div translate="yes"></div>'],
    // a number property
    ["div", "tabindex", null, '<div tabindex="0"></div>'],
    ["div", "tabindex", "x", '<div tabindex="0"></div>'],
    ["div", "tabindex", 0, '<div tabindex="0"></div>'],
    // a property that does not reflect to an attribute
    ["option", "selected", true, "<option></option>"],
  ])("%s %s=%j renders %s", (tag, name, v, html) => {
    expect(cell(tag, name, v)).toBe(html);
  });
});

describe("an attribute spelled differently from its IDL property binds [attr.name], as Marko prints it", () => {
  // Marko's rule for a plain attribute (the title/data-*/aria-* rows of the
  // matrix): null/undefined/false omit, true and "" bare, 0 "0", "x" "x".
  const marko: [unknown, string | null][] = [
    [null, null],
    [undefined, null],
    [false, null],
    [true, ""],
    [0, "0"],
    ["", ""],
    ["x", "x"],
  ];
  for (const [tag, name] of RESCUED) {
    it.each(marko)(`<${tag} ${name}=%j> renders ${name}=%j`, (v, printed) => {
      const template =
        templates.find((t) => t.form === `cell/${tag}/${name}`)?.template ?? "";
      expect(template).toContain(`[attr.${name}]`);
      const element = render(template, v);
      expect(element.localName).toBe(tag);
      expect(element.getAttribute(name)).toBe(printed);
    });
  }
});

describe("an interface-typed DOM property binds [attr.name] instead of throwing at render", () => {
  it.each([
    ["input", "files"],
    ["table", "caption"],
  ])("<%s %s=x>", (tag, name) => {
    const template =
      templates.find((t) => t.form === `cell/${tag}/${name}`)?.template ?? "";
    expect(template).toContain(`[attr.${name}]`);
    expect(render(template, "x").getAttribute(name)).toBe("x");
    TestBed.resetTestingModule();
    expect(render(template, false).hasAttribute(name)).toBe(false);
  });
});

describe("Angular refuses a bound iframe security attribute (NG0910), in any binding form", () => {
  it("<iframe allowfullscreen=x> binds [attr.allowfullscreen], which Angular rejects at render", () => {
    const template =
      templates.find((t) => t.form === "cell/iframe/allowfullscreen")
        ?.template ?? "";
    expect(template).toContain("[attr.allowfullscreen]");
    expect(() => render(template, "x")).toThrow(/NG0910/);
  });
});

describe("a name unknown to Angular's DOM schema keeps [name] (directive inputs, content projection)", () => {
  it("sets a lowercase directive input on a native element", () => {
    const seen: unknown[] = [];
    class Hi {
      set hi(value: unknown) {
        seen.push(value);
      }
    }
    Directive({ selector: "[hi]", inputs: ["hi"] })(Hi);
    class Probe {
      input = { v: "value" };
    }
    Component({
      selector: "mx-hi-probe",
      template: templates.find((t) => t.form === "cell/div/hi")?.template ?? "",
      imports: [Hi],
    })(Probe);
    TestBed.configureTestingModule({ errorOnUnknownProperties: true });
    TestBed.createComponent(Probe).detectChanges();
    expect(seen).toEqual(["value"]);
  });

  it('matches <ng-content select="[header]"> on a bound attribute', () => {
    class Child {}
    Component({
      selector: "app-child",
      template:
        '<b class="hdr"><ng-content select="[header]"></ng-content></b><i class="rest"><ng-content></ng-content></i>',
    })(Child);
    class Probe {
      input = { v: "h" };
    }
    Component({
      selector: "mx-slot-probe",
      template: templates.find((t) => t.form === "slot/header")?.template ?? "",
      imports: [Child],
    })(Probe);
    // `header` is no DOM property: the dev-mode unknown-property check is the
    // loud part, and an author who wants the slot writes it statically.
    TestBed.configureTestingModule({ errorOnUnknownProperties: false });
    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toMatch(/<b class="hdr"[^>]*><div[^>]*>H<\/div><\/b>/);
  });
});
