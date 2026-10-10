import { join, resolve } from "node:path";
import { compileNgMx } from "@mxlang/host-angular";
import { describe, expect, it } from "vitest";
import { createAngularChecker, diagnoseNgMx } from "./index.ts";

const projectDir = resolve(import.meta.dirname, "..");
const file = join(projectDir, "fix-hints.ng.mx");
const moduleFor = (
  template: string,
  body = "two(a: number, b: number) {}",
  head = "",
) =>
  [
    'import { Component, Directive, Input, input } from "@angular/core";',
    head,
    `@Component({ selector: "app-x", imports: [${template.includes("app-child") ? "ChildComponent" : ""}],`,
    `  template: ${template},`,
    "})",
    `export class XComponent { title = "hi"; ${body} }`,
  ].join("\n");
const child =
  '@Component({ selector: "app-child", template: "<i></i>" })\nexport class ChildComponent { @Input() label = ""; }';
// biome-ignore lint/suspicious/noControlCharactersInRegex: messages can carry ANSI colour
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
function diagnostics(source: string) {
  const compiled = compileNgMx(source, file);
  const checker = createAngularChecker({ projectDir });
  try {
    return diagnoseNgMx(compiled, checker, `${file}.ts`).map((d) => ({
      ...d,
      message: strip(d.message),
    }));
  } finally {
    checker.dispose();
  }
}
function clean(source: string) {
  const compiled = compileNgMx(source, file);
  const checker = createAngularChecker({ projectDir });
  try {
    expect(checker.check(`${file}.ts`, compiled.code)).toEqual([]);
  } finally {
    checker.dispose();
  }
}

describe("Angular fix hints (a12, a26)", () => {
  it("replaces numeric-handler assignability prose with the explicit-argument fix", () => {
    const source = moduleFor(
      "<button on-click=two>x</button>",
      undefined,
      child,
    );
    const out = diagnostics(source);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: 2345,
      category: "error",
      start: source.indexOf("=two") + 1,
      length: 3,
      mapped: "exact",
      message:
        "Handler `two` expects `(number, number)`; MX passes `(event, element)`. Use `on-click=(() => two(1, 2))`.",
    });
    clean(source.replace("on-click=two", "on-click=(() => two(1, 2))"));
  });
  it("suggests the uniquely nearest declared input at the authored attribute", () => {
    const source = moduleFor(
      "<div><app-child lable=title></app-child></div>",
      "",
      child,
    );
    const out = diagnostics(source);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: -998002,
      category: "error",
      start: source.indexOf("lable="),
      length: "lable=title".length,
      mapped: "node",
      message:
        "Can't bind to 'lable' since it isn't a known property of 'app-child'. Did you mean 'label'?",
    });
    clean(source.replace("lable=title", "label=title"));
  });
  it.each([
    ['@Input("label") caption = "";', "label"],
    ['label = input("");', "label"],
  ])("uses Angular metadata for %s", (declaration, name) => {
    const source = moduleFor(
      "<app-child lable=title/>",
      "",
      child.replace('@Input() label = "";', declaration),
    );
    expect(diagnostics(source)[0]?.message).toContain(
      `Did you mean '${name}'?`,
    );
    clean(source.replace("lable=title", `${name}=title`));
  });
  it("includes inherited inputs and the offered correction is clean", () => {
    const inherited =
      '@Directive() class Base { @Input() label = ""; }\n@Component({ selector: "app-child", template: "<i></i>" }) export class ChildComponent extends Base {}';
    const source = moduleFor("<app-child lable=title/>", "", inherited);
    expect(diagnostics(source)[0]?.message).toContain("Did you mean 'label'?");
    clean(source.replace("lable=title", "label=title"));
  });
  it("does not add tooling-mode errors for non-exported components", () => {
    const source = moduleFor("<app-child lable=title/>", "", child)
      .replace("export class ChildComponent", "class ChildComponent")
      .replace("export class XComponent", "class XComponent");
    const out = diagnostics(source);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain("Did you mean 'label'?");
    clean(source.replace("lable=title", "label=title"));
  });
  it("does not suggest when declared inputs tie", () => {
    const source = moduleFor(
      "<app-child lable=title/>",
      "",
      child.replace(
        '@Input() label = "";',
        '@Input() label = ""; @Input() ladle = "";',
      ),
    );
    expect(diagnostics(source)).toHaveLength(1);
    expect(diagnostics(source)[0]?.message).not.toContain("Did you mean");
  });
  it("does not suggest an unrelated component's input", () => {
    const source = moduleFor(
      "<app-child lable=title/>",
      "",
      `${child.replace('@Input() label = "";', '@Input() value = "";')}\n@Component({ selector: "app-other", template: "" }) class Other { @Input() label = ""; }`,
    );
    expect(diagnostics(source)[0]?.message).not.toContain("Did you mean");
  });
  it("leaves non-event and nonnumeric assignability diagnostics alone", () => {
    const source = moduleFor(
      "<button on-click=two>x</button>",
      "two(a: KeyboardEvent) {}",
      child,
    );
    expect(diagnostics(source)[0]?.message).toMatch(/^Argument of type/);
    expect(diagnostics(source)[0]?.message).not.toContain("two(1, 2)");
  });
});
