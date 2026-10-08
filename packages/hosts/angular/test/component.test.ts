import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  angularAstSnapshot,
  assertAngularParses,
  compileMx,
  compileWithTags,
  emit,
  emitWithTags,
} from "./helpers.ts";

describe("Component name target", () => {
  it("emits mx- + kebab-cased selector, with a step-1 import warning", () => {
    const { code, warnings, dir } = compileWithTags("<UserCard name=n/>", [
      "UserCard",
    ]);
    expect(code).toBe('<mx-user-card [name]="n"></mx-user-card>');
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      `this template calls 1 MX tag(s): \`UserCard\`. In step 1, MX cannot edit your component's TypeScript. Add to ${join(dir, "x.ts")}: \`import UserCard from "./tags/UserCard";\` and \`imports: [UserCard]\`.`,
    );
    expect(angularAstSnapshot(code)).toMatchObject([{ name: "mx-user-card" }]);
  });

  it("names the compiled file's own .ts sibling, derived from the actual filename", () => {
    const { warnings, dir } = compileWithTags(
      "<UserCard name=n/>",
      ["UserCard"],
      "src/foo.component.mx",
    );
    expect(warnings[0]?.message).toContain(
      `Add to ${join(dir, "src/foo.component.ts")}:`,
    );
  });

  it("rejects /var on a component call (core's own message, not host code)", () => {
    // R-a: the "no syntax for this" claim in round 0 was wrong — core parses
    // and rejects it itself (packages/core/src/lower.ts), before this
    // emitter ever sees the node. Nothing to implement here; this pins the
    // observed behavior. The tag resolves through a discovered unit, so
    // core's current wording is the `<return>` one: a unit that declares no
    // `<return>` has no value for `/var` to bind.
    expect(() => emitWithTags("<UserCard/x name=n/>", ["UserCard"])).toThrow(
      "`<UserCard>` does not return a value; add `<return value=…/>`",
    );
  });

  it("passes content through as element children", () => {
    const out = emitWithTags("<Card>body</Card>", ["Card"]);
    expect(out).toBe("<mx-card>body</mx-card>");
    assertAngularParses(out);
  });

  it("rejects content with tag params, naming the real tag rather than a literal {Tag} placeholder", () => {
    expect(() => emitWithTags("<Card|row|>${row}</Card>", ["Card"])).toThrow(
      "`<Card|…|>` passes parameters to its content, which Angular's content projection cannot express. Declare the block as a `<define>` and pass it as an input the component renders with `ngTemplateOutlet`.",
    );
  });

  it("emits an attribute tag as ngProjectAs content projection", () => {
    const out = emitWithTags("<Card><@header>H</@header></Card>", ["Card"]);
    expect(out).toBe(
      '<mx-card><ng-container ngProjectAs="[header]">H</ng-container></mx-card>',
    );
    assertAngularParses(out);
  });

  it("emits mutually exclusive conditional tags as conditional projections", () => {
    const out = emitWithTags(
      "<Card><if=primary><@header>A</@header></if><else if=secondary><@header>B</@header></else><else><@header>C</@header></else></Card>",
      ["Card"],
    );
    expect(out).toBe(
      '<mx-card>@if (primary) { <ng-container ngProjectAs="[header]">A</ng-container> } @else if (secondary) { <ng-container ngProjectAs="[header]">B</ng-container> } @else { <ng-container ngProjectAs="[header]">C</ng-container> }</mx-card>',
    );
    assertAngularParses(out);
  });

  it("rejects an attribute tag with params, naming the component and the attribute tag", () => {
    try {
      emitWithTags("<Card>\n<@header|x|>${x}</@header>\n</Card>", ["Card"]);
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "params on `<@header>` aren't supported by @mxlang/angular",
      );
      expect((error as { line?: number }).line).toBe(2);
    }
  });

  it("rejects attributes on a projection with a positioned host error", () => {
    try {
      emitWithTags('<Card>\n<@header tone="loud">H</@header>\n</Card>', [
        "Card",
      ]);
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "attributes on `<@header>` aren't supported by @mxlang/angular",
      );
      expect((error as { line?: number }).line).toBe(2);
    }
  });

  it("rejects nested projections with a positioned host error", () => {
    try {
      emitWithTags("<Card>\n<@header><@icon>I</@icon></@header>\n</Card>", [
        "Card",
      ]);
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "nested attribute tags inside `<@header>` aren't supported by @mxlang/angular",
      );
      expect((error as { line?: number }).line).toBe(2);
    }
  });

  it("rejects repeated and looped tags as array projections", () => {
    try {
      emitWithTags("<Card>\n<@item>A</@item>\n<@item>B</@item>\n</Card>", [
        "Card",
      ]);
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "array attribute tag `<@item>` isn't supported by @mxlang/angular",
      );
      expect((error as { line?: number }).line).toBe(3);
    }
    try {
      emitWithTags(
        "<Card>\n<for|item| of=items>\n<@row>${item}</@row>\n</for>\n</Card>",
        ["Card"],
      );
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "array attribute tag `<@row>` isn't supported by @mxlang/angular",
      );
      expect((error as { line?: number }).line).toBe(3);
    }
  });

  it("rejects a bodiless projection", () => {
    try {
      emitWithTags("<Card>\n<@header/>\n</Card>", ["Card"]);
      throw new Error("expected compile to fail");
    } catch (error) {
      expect((error as Error).message).toContain(
        "<@header/> has no body; @mxlang/angular projects attribute-tag bodies by name",
      );
      expect((error as { line?: number }).line).toBe(2);
    }
  });

  it("warns once per file listing every tag, not once per call", () => {
    const { warnings } = compileWithTags(
      "<UserCard name=a/><UserCard name=b/>",
      ["UserCard"],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("calls 1 MX tag(s): `UserCard`");
  });

  it("lists two different tags in the same single warning", () => {
    const { warnings } = compileWithTags("<UserCard name=a/><Badge label=b/>", [
      "UserCard",
      "Badge",
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(
      "calls 2 MX tag(s): `UserCard`, `Badge`",
    );
  });
});

describe("Component define target", () => {
  it("maps args onto declared params by position, $implicit first", () => {
    const out = emit("<define/Row|a, b|>${a}${b}</define><Row(1, x)/>");
    expect(out).toContain(
      '<ng-container [ngTemplateOutlet]="Row" [ngTemplateOutletContext]="{ $implicit: 1, b: x }"></ng-container>',
    );
    assertAngularParses(out);
  });

  it("rejects a call with fewer arguments than the define declares", () => {
    expect(() => emit("<define/Row|a, b|>${a}${b}</define><Row(1)/>")).toThrow(
      "`<Row>` expects 2 argument(s), got 1",
    );
  });

  it("rejects a call with more arguments than the define declares", () => {
    expect(() => emit("<define/Row|a|>${a}</define><Row(1, 2)/>")).toThrow(
      "`<Row>` expects 1 argument(s), got 2",
    );
  });
});

describe("Component dynamic target (via DelegatedTag routing)", () => {
  it("emits ngComponentOutlet with a warning", () => {
    const { code, warnings } = compileMx("<${Cmp} a=1/>");
    expect(code).toBe(
      '<ng-container [ngComponentOutlet]="Cmp" [ngComponentOutletInputs]="{ a: 1 }"></ng-container>',
    );
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "this template uses [ngComponentOutlet]; add NgComponentOutlet to the component's imports.",
    );
    expect(angularAstSnapshot(code)).toMatchObject([
      {
        inputs: [
          { name: "ngComponentOutlet" },
          { name: "ngComponentOutletInputs" },
        ],
      },
    ]);
  });

  it("rejects content on a dynamic component", () => {
    expect(() => emit("<${Cmp}>body</${Cmp}>")).toThrow(
      /isn't supported by @mxlang\/angular: `ngComponentOutlet`/,
    );
  });

  // attribute-tag-silent-drops round 2: an attribute-tag-only body (no
  // ordinary children) used to slip past the `hasContent` check — measured,
  // `<${Cmp}><@header>hi</@header></>` compiled clean to a bare
  // `[ngComponentOutlet]="Cmp"` with the attribute tag silently gone, no
  // warning. `ngComponentOutlet` has no content-projection mechanism at all
  // (same limit the ordinary-content case already reports), so this is the
  // same error, not a new one.
  it("rejects an attribute-tag-only body on a dynamic component the same way", () => {
    expect(() => emit("<${Cmp}><@header>hi</@header></>")).toThrow(
      /isn't supported by @mxlang\/angular: `ngComponentOutlet`/,
    );
  });

  it("rejects tag arguments on a dynamic component: ngComponentOutlet has no positional-argument channel", () => {
    // `<${Cmp}("x", 2)/>`: `ngComponentOutlet` only binds a component's
    // `@Input()`s through `ngComponentOutletInputs`, never positional
    // constructor arguments — genuinely inexpressible here, so this must be
    // a positioned compile error naming the construct, not a silent drop.
    expect(() => emit('<${Cmp}("x", 2)/>')).toThrow(
      /tag arguments aren't supported by @mxlang\/angular: `ngComponentOutlet`/,
    );
  });

  // dynamic-tag-var-silent-drop: a `/var` on a dynamic tag used to compile
  // clean and silently drop the binding (`ngComponentOutlet` has no position
  // to hand a returned value to). Marko 6.3.51 binds the dynamic tag's return
  // value; this host cannot, so it must refuse — never a silent drop.
  it("rejects a /var on a dynamic component, positioned at the /var", () => {
    const fail = (source: string) => {
      try {
        emit(source);
      } catch (caught) {
        return caught as Error & { line?: number; column?: number };
      }
      return undefined;
    };
    const error = fail("<${Cmp} a=1/>\n<${Cmp}/n a=1/>");
    expect(error?.message).toMatch(
      /tag variable `\/n` on a dynamic tag .* isn't supported by @mxlang\/angular/,
    );
    // The `/n` is the second character pair of line 2 (`<${Cmp}/n …>`), so
    // the caret lands on the binding, not on the tag's `<`.
    expect(error?.line).toBe(2);
    expect(error?.column).toBe(8);
  });

  it("names the authored variable in the refusal, not a hardcoded /n", () => {
    let error: (Error & { line?: number; column?: number }) | undefined;
    try {
      emit("<${Cmp}/count a=1/>");
    } catch (caught) {
      error = caught as Error & { line?: number; column?: number };
    }
    expect(error?.message).toMatch(
      /tag variable `\/count` on a dynamic tag \(`<\$\{…}\/count\/>`\) isn't supported/,
    );
    expect(error?.message).not.toContain("/n");
    // `<${Cmp}/count …>`: `count` starts right after the `/`, at column 8.
    expect(error?.line).toBe(1);
    expect(error?.column).toBe(8);
  });

  it("escapes a quote in a static input without corrupting the outlet binding", () => {
    // A plain `"${attr.value}"` (no JS-layer escaping) let an unescaped `"`
    // in the attribute value close the JS object literal early, corrupting
    // [ngComponentOutletInputs]. JSON.stringify handles the JS layer,
    // esc() the surrounding HTML attribute layer. Single-quoted MX syntax
    // is what gets a real `"` character into `attr.value` (a double-quoted
    // `&quot;` would just be the six literal characters `&quot;`, not the
    // one-character value this is testing).
    const out = emit(`<\${Cmp} title='he said "hi"'/>`);
    assertAngularParses(out);
    expect(out).toContain("title: &quot;he said \\&quot;hi\\&quot;&quot;");
  });

  it("escapes a literal backslash in a static input", () => {
    // Marko itself reads `\\` inside an attribute value as one literal
    // backslash (`a\\c` -> the value `a\c`), so this uses a doubled
    // backslash in the MX source to get one real backslash character into
    // `attr.value` — JSON.stringify then re-escapes that one character back
    // to the two-character `\\` a JS string literal needs.
    const out = emit("<${Cmp} title='a\\\\c'/>");
    assertAngularParses(out);
    expect(out).toContain("title: &quot;a\\\\c&quot;");
  });

  it("treats a bare, attribute-less <${expr}/> as a dynamic component, same as the tagged form", () => {
    // core PR #103 (main 50877ea8): a bare `${Cmp}` placeholder and
    // `<${Cmp}/>` are the identical dynamic-tag construct on every host now
    // (Marko's own grammar has no way to tell them apart, and Marko itself
    // treats both as a dynamic tag — AGENTS.md's "four Marko facts"). This
    // host no longer draws its own bare/tagged split; both emit
    // `ngComponentOutlet`.
    const out = emit("<${Cmp}/>");
    expect(out).toBe('<ng-container [ngComponentOutlet]="Cmp"></ng-container>');
    assertAngularParses(out);
  });

  it("a bare ${expr} placeholder emits ngComponentOutlet exactly like the tagged form", () => {
    // Asserted side by side so a regression reintroducing the old
    // bare-vs-tagged split fails visibly here, not just in the fixture
    // above.
    expect(emit("${Cmp}")).toBe(
      '<ng-container [ngComponentOutlet]="Cmp"></ng-container>',
    );
    expect(emit("<${Cmp}/>")).toBe(
      '<ng-container [ngComponentOutlet]="Cmp"></ng-container>',
    );
    expect(emit("<${Cmp} a=1/>")).toBe(
      '<ng-container [ngComponentOutlet]="Cmp" [ngComponentOutletInputs]="{ a: 1 }"></ng-container>',
    );
  });
});
