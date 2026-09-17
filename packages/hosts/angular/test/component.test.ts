import { describe, expect, it } from "vitest";
import {
  angularAstSnapshot,
  assertAngularParses,
  compileMx,
  emit,
} from "./helpers.ts";

describe("Component name target", () => {
  it("emits mx- + kebab-cased selector, with a step-1 import warning", () => {
    const { code, warnings } = compileMx("<UserCard name=n/>");
    expect(code).toBe('<mx-user-card [name]="n"></mx-user-card>');
    assertAngularParses(code);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      'this template calls 1 MX tag(s): `UserCard`. In step 1, MX cannot edit your component\'s TypeScript. Add to x.ts: `import UserCard from "./tags/user-card";` and `imports: [UserCard]`.',
    );
    expect(angularAstSnapshot(code)).toMatchObject([{ name: "mx-user-card" }]);
  });

  it("names the compiled file's own .ts sibling, derived from the actual filename", () => {
    const { warnings } = compileMx(
      "<UserCard name=n/>",
      "src/foo.component.mx",
    );
    expect(warnings[0]?.message).toContain("Add to src/foo.component.ts:");
  });

  it("rejects /var on a component call (core's own message, not host code)", () => {
    // R-a: the "no syntax for this" claim in round 0 was wrong — core parses
    // and rejects it itself (packages/core/src/lower.ts, the tag-variable
    // guard), before this emitter ever sees the node. Nothing to implement
    // here; this pins the observed behavior.
    expect(() => emit("<UserCard/x name=n/>")).toThrow(
      "tag variable `/x` on `<UserCard>` is not supported in a standalone template",
    );
  });

  it("passes content through as element children", () => {
    const out = emit("<Card>body</Card>");
    expect(out).toBe("<mx-card>body</mx-card>");
    assertAngularParses(out);
  });

  it("rejects content with tag params, naming the real tag rather than a literal {Tag} placeholder", () => {
    expect(() => emit("<Card|row|>${row}</Card>")).toThrow(
      "`<Card|…|>` passes parameters to its content, which Angular's content projection cannot express. Declare the block as a `<define>` and pass it as an input the component renders with `ngTemplateOutlet`.",
    );
  });

  it("emits an attribute tag as ngProjectAs content projection", () => {
    const out = emit("<Card><@header>H</@header></Card>");
    expect(out).toBe(
      '<mx-card><ng-container ngProjectAs="[header]">H</ng-container></mx-card>',
    );
    assertAngularParses(out);
  });

  it("rejects an attribute tag with params, naming the component and the attribute tag", () => {
    expect(() => emit("<Card><@header|x|>${x}</@header></Card>")).toThrow(
      "`<Card><@header|…|>` passes parameters to its content, which Angular's content projection cannot express. Declare the block as a `<define>` and pass it as an input the component renders with `ngTemplateOutlet`.",
    );
  });

  it("warns once per file listing every tag, not once per call", () => {
    const { warnings } = compileMx("<UserCard name=a/><UserCard name=b/>");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("calls 1 MX tag(s): `UserCard`");
  });

  it("lists two different tags in the same single warning", () => {
    const { warnings } = compileMx("<UserCard name=a/><Badge label=b/>");
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

describe("Component dynamic target (via HostTag routing)", () => {
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
      /ngComponentOutletContent/,
    );
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

  it("treats a bare, attribute-less <${expr}/> as a plain interpolation", () => {
    // `<${Cmp}/>` with neither attributes nor a body parses through the
    // exact same core branch as a bare `${Cmp}` placeholder (`lower.ts`'s
    // `lowerTag`, the "A bare `${expr}`..." comment) — MX's own grammar has
    // no way to tell them apart, so this host treats it as the
    // interpolation it is indistinguishable from, not a component outlet.
    const out = emit("<${Cmp}/>");
    expect(out).toBe("{{ Cmp }}");
    assertAngularParses(out);
  });

  it("the bare-vs-attributed split is load-bearing: adding one attribute flips the shape", () => {
    // Same DYNAMIC_TAG claim, same core branch — the only difference between
    // these two inputs is whether any attribute is present. Asserted side
    // by side so a regression that makes both collapse to one shape (either
    // direction) fails visibly here, not just in the two separate tests
    // above.
    expect(emit("${Cmp}")).toBe("{{ Cmp }}");
    expect(emit("<${Cmp}/>")).toBe("{{ Cmp }}");
    expect(emit("<${Cmp} a=1/>")).toBe(
      '<ng-container [ngComponentOutlet]="Cmp" [ngComponentOutletInputs]="{ a: 1 }"></ng-container>',
    );
  });
});
