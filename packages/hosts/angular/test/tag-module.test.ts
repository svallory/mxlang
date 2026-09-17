/**
 * Task 1.7: a `.mx` tag file compiles to a standalone Angular component.
 *
 * Every emitted module is asserted **byte-exact**, and its `template:` string
 * is additionally parsed with the real `@angular/compiler` — the two catch
 * different things. A byte assertion pins the module shape (decorator fields,
 * `@Input()` declarations, import lines); `parseTemplate` proves the template
 * inside it is syntax Angular accepts, which a string golden cannot show.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomTags } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileTagModule } from "../src/tag-module.ts";
import { assertAngularParses, assertModuleTypechecks } from "./helpers.ts";

/** Compiles a tag file's source, with tag discovery rooted at a real dir. */
function compileTag(
  source: string,
  filename = "icon.mx",
  siblings: Record<string, string> = {},
  tagSelectorPrefix?: string,
): { code: string; selector: string; className: string } {
  const dir = mkdtempSync(join(tmpdir(), "mx-angular-tag-"));
  mkdirSync(join(dir, "tags"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
  for (const [name, content] of Object.entries(siblings)) {
    writeFileSync(join(dir, "tags", name), content);
  }
  const path = join(dir, "tags", filename);
  writeFileSync(path, source);
  const result = compileTagModule(source, path, {
    customTags: getCustomTags(path) as never,
    tagSelectorPrefix,
  });
  return {
    code: result.code,
    selector: result.selector,
    className: result.className,
  };
}

/** The `template: "…"` string of an emitted module, unescaped. */
function templateOf(code: string): string {
  const match = code.match(/^ {2}template: (".*"),$/m);
  if (!match) throw new Error(`no template line in:\n${code}`);
  return JSON.parse(match[1] as string);
}

describe("compileTagModule: inputs", () => {
  it("emits one @Input() per `export interface Input` property, required when not optional", () => {
    const { code } = compileTag(
      "export interface Input { name: string; size?: number }\n<span>${input.name}</span>\n",
    );

    expect(code).toBe(
      `import { Component, Input as NgInput } from "@angular/core";

export interface Input { name: string; size?: number }

@Component({
  selector: "mx-icon",
  standalone: true,
  imports: [],
  template: "<span>{{ name }}</span>",
})
export class Icon {
  @NgInput({ required: true }) name!: string;
  @NgInput() size?: number;
}
export default Icon;
`,
    );
    assertAngularParses(templateOf(code));
    assertModuleTypechecks(code);
  });

  it("emits no inputs, and no `Input` import, when the tag declares no interface", () => {
    const { code } = compileTag("<span>hi</span>\n");

    expect(code).toBe(
      `import { Component } from "@angular/core";

@Component({
  selector: "mx-icon",
  standalone: true,
  imports: [],
  template: "<span>hi</span>",
})
export class Icon {
}
export default Icon;
`,
    );
    assertAngularParses(templateOf(code));
  });

  it("copies the TypeScript type verbatim, including a function type (no @Output() inference)", () => {
    // RULED 2026-09-16: a function-typed property is a plain `@Input()`, so a
    // caller passes a callback as an ordinary dynamic attribute on every host.
    const { code } = compileTag(
      "export interface Input { onSelect: (e: MouseEvent) => void }\n<button>x</button>\n",
    );

    expect(code).toContain(
      "@NgInput({ required: true }) onSelect!: (e: MouseEvent) => void;",
    );
    expect(code).not.toContain("@Output");
    expect(code).not.toContain("EventEmitter");
  });

  it("reads `input.x` as the class property `x`, never as a member of an `input` object", () => {
    // Angular resolves a template expression against the component instance,
    // so `{{ input.name }}` would look up `name` on a property named `input`
    // and render empty — it parses cleanly, so only this assertion catches it.
    const { code } = compileTag(
      "export interface Input { name: string }\n<span>${input.name}</span>\n",
    );

    expect(templateOf(code)).toBe("<span>{{ name }}</span>");
    expect(templateOf(code)).not.toContain("input.");
  });

  it("does not rewrite a read of a `<for>` param that shadows `input`", () => {
    const { code } = compileTag(
      "export interface Input { rows: string[] }\n<for|input| of=input.rows><li>${input}</li></for>\n",
    );

    // The iterable is the tag's own input (rewritten); the row read is the
    // param, which shadows it and must stay as written.
    expect(templateOf(code)).toBe(
      "@for (input of rows; track $index) { <li>{{ input }}</li> }",
    );
    assertAngularParses(templateOf(code));
  });
});

describe("compileTagModule: typechecks the emitted module for real", () => {
  // `parseTemplate` (used throughout this file) only proves the
  // `template:` string is syntax Angular accepts — it never sees the
  // surrounding module, so a real `TS2440` (the emitted
  // `import { Component, Input } from "@angular/core"` colliding with the
  // tag's own `export interface Input`) compiled clean and every existing
  // test still passed. This is the real `tsc` pass that catches it.
  it("a tag with a required and an optional input typechecks with tsc", () => {
    const { code } = compileTag(
      "export interface Input { name: string; size?: number }\n<span>${input.name}</span>\n",
    );

    assertModuleTypechecks(code);
  });

  it("a tag with no inputs at all still typechecks", () => {
    const { code } = compileTag("<span>hi</span>\n");

    assertModuleTypechecks(code);
  });
});

describe("compileTagModule: content projection", () => {
  it("emits <ng-content> for a body read of `input.content()`", () => {
    const { code } = compileTag("<div>${input.content()}</div>\n");

    expect(templateOf(code)).toBe("<div><ng-content></ng-content></div>");
    assertAngularParses(templateOf(code));
  });

  it('emits <ng-content select="[header]"> for a named attribute tag read', () => {
    const { code } = compileTag(
      "<div>${input.header()}${input.content()}</div>\n",
    );

    expect(templateOf(code)).toBe(
      '<div><ng-content select="[header]"></ng-content><ng-content></ng-content></div>',
    );
    assertAngularParses(templateOf(code));
  });

  it("errors on a repeated attribute tag, which Angular projects only once", () => {
    expect(() =>
      compileTag("<div>${input.item()}${input.item()}</div>\n"),
    ).toThrow(
      "a repeated attribute tag cannot be emitted as Angular content projection, which matches each selector once. Take the items as an input array and render them with `<for>`.",
    );
  });

  it("does not mistake a plain input read for an attribute-tag slot", () => {
    // Core's own `tagMetadata.attributeTags` lists `title` here (its
    // `inputMember` matches a bare `input.x`), so deriving projection from
    // that field would emit an `<ng-content select="[title]">` for what is an
    // ordinary string input. The slot signal is a *call*.
    const { code } = compileTag(
      "export interface Input { title: string }\n<h2>${input.title}</h2>\n",
    );

    expect(templateOf(code)).toBe("<h2>{{ title }}</h2>");
    expect(code).not.toContain("ng-content");
  });
});

describe("compileTagModule: selector", () => {
  it("derives `mx-` plus the kebab-cased file basename", () => {
    expect(compileTag("<i>x</i>\n", "user-card.mx").selector).toBe(
      "mx-user-card",
    );
    // A tag's name is its filename, case included, and both spellings of one
    // name give the same selector (design note's single rule).
    expect(compileTag("<i>x</i>\n", "UserCard.mx").selector).toBe(
      "mx-user-card",
    );
  });

  it("uses `export const selector` verbatim when the tag declares one, and does not re-export it", () => {
    const { code, selector } = compileTag(
      'export const selector = "liuna-user-card";\n<i>x</i>\n',
    );

    expect(selector).toBe("liuna-user-card");
    expect(code).toContain('selector: "liuna-user-card"');
    // Consumed as the decorator's value rather than passed through, so the
    // emitted module has no stray module-level `selector` binding.
    expect(code).not.toContain("export const selector");
  });
});

describe("compileTagModule: module-level statements", () => {
  it("places the tag's own `import` and `static` at module scope (tag-unit §1.5)", () => {
    const { code } = compileTag(
      'import { fmt } from "./util.ts";\nstatic const PREFIX = "#";\n<i>${PREFIX}${fmt(1)}</i>\n',
    );

    expect(code).toContain('import { fmt } from "./util.ts";');
    expect(code).toContain('const PREFIX = "#";');
    // Module statements precede the decorator they are used from.
    expect(code.indexOf("import { fmt }")).toBeLessThan(
      code.indexOf("@Component("),
    );
  });

  it("passes other exports through", () => {
    const { code } = compileTag("export const SIZES = [1, 2];\n<i>x</i>\n");

    expect(code).toContain("export const SIZES = [1, 2];");
  });
});

describe("compileTagModule: calling another tag", () => {
  it("imports the called tag's module and lists it in `imports:`", () => {
    const { code } = compileTag("<div><badge/></div>\n", "card.mx", {
      "badge.mx": "<b>!</b>\n",
    });

    // A discovered tag reaches the emitter under a gensym'd binding, so both
    // the selector and this import line prove the resolution back to the file.
    // The author wrote `./badge.mx`, so the emitted module keeps that
    // relative path with the extension swapped — it is the *emitted
    // module's* path, never the author's `.mx` one.
    expect(code).toContain('import Badge from "./badge";');
    expect(code).toContain("imports: [Badge]");
    expect(templateOf(code)).toBe("<div><mx-badge></mx-badge></div>");
    assertAngularParses(templateOf(code));
  });
});

describe("compileTagModule: Angular directive imports", () => {
  it("adds NgClass when the template binds a class object", () => {
    const { code } = compileTag(
      "export interface Input { on: boolean }\n<div class={active: input.on}>x</div>\n",
    );

    expect(code).toContain('import { NgClass } from "@angular/common";');
    expect(code).toContain("imports: [NgClass]");
    assertAngularParses(templateOf(code));
  });

  it("adds KeyValuePipe for `<for in=>`", () => {
    const { code } = compileTag(
      "export interface Input { map: Record<string, string> }\n<for|k, v| in=input.map><i>${k}${v}</i></for>\n",
    );

    expect(code).toContain('import { KeyValuePipe } from "@angular/common";');
    expect(code).toContain("imports: [KeyValuePipe]");
    assertAngularParses(templateOf(code));
  });
});

describe("compileTagModule: `Input` parsing (R-a)", () => {
  it("reads newline-separated properties, with no `;` or `,`", () => {
    const { code } = compileTag(
      "export interface Input {\n  name: string\n  size: number\n}\n<i>x</i>\n",
    );

    expect(code).toContain("@NgInput({ required: true }) name!: string;");
    expect(code).toContain("@NgInput({ required: true }) size!: number;");
  });

  it("reads through `//` and `/* */` comments", () => {
    const { code } = compileTag(
      "export interface Input {\n  // the label\n  a: string\n  /* block */\n  b: number\n}\n<i>x</i>\n",
    );

    expect(code).toContain("@NgInput({ required: true }) a!: string;");
    expect(code).toContain("@NgInput({ required: true }) b!: number;");
  });

  it("slices a function type verbatim, with another property on the same line", () => {
    // The text scan this replaced mis-sliced here: `=>`'s `>` closed the
    // depth `(` had opened, so the split landed mid-type.
    const { code } = compileTag(
      "export interface Input { onSel: (e: X) => void; size: number }\n<i>x</i>\n",
    );

    expect(code).toContain(
      "@NgInput({ required: true }) onSel!: (e: X) => void;",
    );
    expect(code).toContain("@NgInput({ required: true }) size!: number;");
  });

  it("keeps a union, an object type with `;` inside, and a template-literal type verbatim", () => {
    const { code } = compileTag(
      'export interface Input { u: "a" | "b"; o: { a: 1; b: 2 }; t: `x-${string}` }\n<i>x</i>\n',
    );

    expect(code).toContain('@NgInput({ required: true }) u!: "a" | "b";');
    expect(code).toContain("@NgInput({ required: true }) o!: { a: 1; b: 2 };");
    expect(code).toContain("@NgInput({ required: true }) t!: `x-${string}`;");
  });

  it("errors on a member that is not a property", () => {
    expect(() =>
      compileTag(
        "export interface Input { [key: string]: unknown }\n<i>x</i>\n",
      ),
    ).toThrow("`Input` may only declare properties on Angular");
    expect(() =>
      compileTag("export interface Input { go(): void }\n<i>x</i>\n"),
    ).toThrow("`Input` may only declare properties on Angular");
  });
});

describe("compileTagModule: input read shapes (R-b)", () => {
  it.each([
    ["input.x", "<i>${input.x}</i>\n", "<i>{{ x }}</i>"],
    ["input?.x", "<i>${input?.x}</i>\n", "<i>{{ x }}</i>"],
    ['input["x"]', '<i>${input["x"]}</i>\n', "<i>{{ x }}</i>"],
    ["input.a.b", "<i>${input.a.b}</i>\n", "<i>{{ a.b }}</i>"],
    [
      "inside an arrow body",
      "<i>${[1].map(n => input.x + n)}</i>\n",
      "<i>{{ [1].map(n => x + n) }}</i>",
    ],
  ])("rewrites %s", (_label, source, expected) => {
    expect(templateOf(compileTag(source).code)).toBe(expected);
  });

  it.each([
    [
      "a `<for|input|>` param",
      "<for|input| of=input.rows><i>${input.x}</i></for>\n",
      "@for (input of rows; track $index) { <i>{{ input.x }}</i> }",
    ],
    [
      "a `<const/input=…>` binding",
      "<const/input={x: 1}/><i>${input.x}</i>\n",
      "@let input = {x: 1};<i>{{ input.x }}</i>",
    ],
    [
      "an arrow parameter",
      "<i>${[1].map(input => input.x)}</i>\n",
      "<i>{{ [1].map(input => input.x) }}</i>",
    ],
    [
      "a destructuring parameter",
      "<i>${[1].map(({input}) => input.x)}</i>\n",
      "<i>{{ [1].map(({input}) => input.x) }}</i>",
    ],
  ])("leaves a read shadowed by %s alone", (_label, source, expected) => {
    expect(templateOf(compileTag(source).code)).toBe(expected);
  });

  it.each([
    [
      "a `<define>` param",
      "<define/Row|input|>${input.label}</define>\n",
      "<ng-template #Row let-input> {{ input.label }} </ng-template>",
    ],
    [
      "a destructured `<define>` param",
      "<define/Row|{input}|>${input.label}</define>\n",
      "<ng-template #Row let-{input}> {{ input.label }} </ng-template>",
    ],
  ])("leaves a read shadowed by %s alone", (_label, source, expected) => {
    // `Define` carries no `bindings` field the way `For` does (`ir.ts`:
    // name/params/children), so reading one returned `undefined` and this
    // body was rewritten to `{{ label }}` — reading the component while the
    // emitted `let-input` bound the param. Shadowing is computed from
    // `Define.params` instead.
    expect(templateOf(compileTag(source).code)).toBe(expected);
  });

  it("still rewrites inside a `<define>` that binds another name", () => {
    const { code } = compileTag(
      "<define/Row|row|>${row.label}${input.title}</define>\n",
    );

    expect(templateOf(code)).toBe(
      "<ng-template #Row let-row> {{ row.label }}{{ title }} </ng-template>",
    );
  });

  it("errors on a computed non-literal input read", () => {
    expect(() => compileTag('<const/k="a"/><i>${input[k]}</i>\n')).toThrow(
      "dynamic input access is not supported on Angular",
    );
  });
});

describe("compileTagModule: slot misuse (R-c)", () => {
  it("errors when a name is read both as a slot and bare", () => {
    expect(() => compileTag("<i>${input.x}${input.x()}</i>\n")).toThrow(
      /read both as content .* and as a value/,
    );
  });

  it("errors when a slot is called with arguments", () => {
    expect(() => compileTag("<i>${input.header(1)}</i>\n")).toThrow(
      /passes arguments to content/,
    );
  });

  it("errors when a slot is passed through as an attribute", () => {
    expect(() =>
      compileTag("<div><badge header=input.header/></div>\n", "card.mx", {
        "badge.mx": "<b>${input.header()}</b>\n",
      }),
    ).toThrow(/`header` is content on `<badge>`/);
  });

  it("allows a plain input to be passed through", () => {
    const { code } = compileTag(
      "<div><badge label=input.label/></div>\n",
      "card.mx",
      { "badge.mx": "<b>${input.label}</b>\n" },
    );

    expect(templateOf(code)).toBe(
      '<div><mx-badge [label]="label"></mx-badge></div>',
    );
  });
});

describe("compileTagModule: authored tag import", () => {
  it("emits one import for an explicitly imported tag, not two", () => {
    const { code } = compileTag(
      'import Badge from "./badge.mx";\n<div><Badge/></div>\n',
      "card.mx",
      { "badge.mx": "<b>!</b>\n" },
    );

    // The author's own line is dropped: the call site re-emits it under the
    // component class's name, so passing both through was a duplicate
    // identifier (and the wrong path, from inside `tags/`).
    expect(code).not.toContain('from "./badge.mx"');
    expect(code.match(/import Badge from/g)).toHaveLength(1);
    expect(code).toContain('import Badge from "./badge";');
    expect(code).toContain("imports: [Badge]");
  });
});

describe("compileTagModule: tagSelectorPrefix (R-d)", () => {
  it("uses a configured prefix for the tag's own selector and its call sites", () => {
    const { code, selector } = compileTag(
      "<div><badge/></div>\n",
      "card.mx",
      { "badge.mx": "<b>!</b>\n" },
      "liuna-",
    );

    expect(selector).toBe("liuna-card");
    expect(templateOf(code)).toBe("<div><liuna-badge></liuna-badge></div>");
  });
});
