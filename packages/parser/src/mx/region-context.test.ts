import { describe, expect, it } from "vitest";
import type { PluginConfig } from "../babel/typings.d.ts";
import {
  computeMxRegionContext,
  type MxRegionContext,
  type MxRegionParentFrame,
} from "./region-context.ts";
import { parseSolid } from "./test-helpers.ts";

/**
 * Runs one `.solid.mx` decorator/property fixture and captures the
 * `MxRegionContext` the parser computed for its MX region, via a check that
 * always accepts but records what it saw — same shape as the Angular host's
 * own five-line check (see `notes/investigations/angular-ng-mx-spike.md`
 * §Q4), without asserting a specific host's policy.
 */
const DECORATOR_PLUGINS: PluginConfig[] = ["typescript", "jsx", "decorators"];

function captureContext(source: string): MxRegionContext {
  let captured: MxRegionContext | undefined;
  parseSolid(source, "test.solid.mx", {
    plugins: DECORATOR_PLUGINS,
    mxRegionPositionCheck: (context) => {
      captured = context;
      return { ok: true };
    },
  });
  if (!captured) throw new Error("mxRegionPositionCheck never ran");
  return captured;
}

describe("MxRegionContext", () => {
  it("reports the property key, decorator and directness for the canonical shape", () => {
    const context = captureContext(
      `@Component({ template: <div/> })\nclass X {}`,
    );
    expect(context).toEqual({
      propertyKey: "template",
      decoratorNames: ["Component"],
      enclosingDecoratorNames: [],
      isDirectPropertyValue: true,
      argumentIndex: 0,
    });
  });

  it("reports the argument index of the decorator-call argument that encloses the region", () => {
    const single = captureContext(
      `@Component({ template: <div/> })\nclass X {}`,
    );
    expect(single.argumentIndex).toBe(0);

    const second = captureContext(
      `@Component(opts, { template: <div/> })\nclass X {}`,
    );
    expect(second.argumentIndex).toBe(1);
    expect(second.propertyKey).toBe("template");
    expect(second.isDirectPropertyValue).toBe(true);

    const none = captureContext(`<div/>;`);
    expect(none.argumentIndex).toBeNull();
  });

  it("reports the innermost key but not direct when nested in another object", () => {
    const context = captureContext(
      `@Component({ x: { template: <div/> } })\nclass X {}`,
    );
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(false);
  });

  it("reports not direct when nested inside a call argument", () => {
    const context = captureContext(
      `@Component({ template: foo(<div/>) })\nclass X {}`,
    );
    expect(context.propertyKey).toBe("template");
    expect(context.decoratorNames).toEqual(["Component"]);
    expect(context.isDirectPropertyValue).toBe(false);
  });

  it("reports not direct when nested inside an array", () => {
    const context = captureContext(
      `@Component({ template: [<div/>] })\nclass X {}`,
    );
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(false);
  });

  describe("a boundary opened between the decorator and its argument object is never transparent", () => {
    // Each of these has a `template` property whose own value is an exact,
    // unwrapped match one level down — the bug (round 2, HIGH) was anchoring
    // on "the first property frame found anywhere in the stack", which
    // skipped straight past the wrapper below to that inner match. The fix
    // requires the *first* frame after the decorator to already be the
    // property, with nothing — not even a call, a ternary branch, or an
    // array — opened in between.
    const cases: Array<[label: string, source: string]> = [
      [
        "call wrapping the object",
        `@Component(wrap({ template: <div/> }))\nclass X {}`,
      ],
      [
        "ternary choosing the object",
        `@Component(c ? { template: <div/> } : y)\nclass X {}`,
      ],
      [
        "array holding the object",
        `@Component([{ template: <div/> }])\nclass X {}`,
      ],
      [
        "a plain call as the decorator's own argument",
        `@Outer(Inner({ t: <div/> }))\nclass X {}`,
      ],
    ];

    for (const [label, source] of cases) {
      it(`${label} → false`, () => {
        const context = captureContext(source);
        expect(context.isDirectPropertyValue).toBe(false);
      });
    }
  });

  it("reports a null property key and no decorators at expression-statement level", () => {
    const context = captureContext(`<div/>;`);
    expect(context).toEqual({
      propertyKey: null,
      decoratorNames: [],
      enclosingDecoratorNames: [],
      isDirectPropertyValue: false,
      argumentIndex: null,
    });
  });

  it("reports only the one decorator whose own argument encloses the region", () => {
    // A decorator attaches to a declaration, not to an arbitrary expression,
    // so JS syntax has no way to nest a second real `@decorator` inside a
    // first one's own call argument — `Inner(...)` below is an ordinary
    // call, not a decorator, and correctly contributes no decorator frame
    // (the no-host-knowledge test below covers that directly). A sibling
    // decorator on the same class is a *different* declaration's decorator
    // entirely and must not leak into this region's context either.
    const context = captureContext(
      `@Outer\n@Component({ template: <div/> })\nclass X {}`,
    );
    expect(context.decoratorNames).toEqual(["Component"]);
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(true);
  });

  it("scopes decoratorNames to the innermost decorator for a class expression nested in an outer decorator's argument", () => {
    // Nesting is possible: a class expression can sit inside an outer
    // decorator's own call argument and itself carry a decorator whose
    // argument encloses the region — decoratorNames must report only the
    // innermost (Component), with the outer (Directive) in
    // enclosingDecoratorNames, matching propertyKey/isDirectPropertyValue
    // which are scoped to Component's own argument.
    const context = captureContext(
      `@Directive({ x: class { @Component({ template: <div/> }) y() {} } })\nclass X {}`,
    );
    expect(context.decoratorNames).toEqual(["Component"]);
    expect(context.enclosingDecoratorNames).toEqual(["Directive"]);
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(true);
  });

  it("reports the reverse case: a region in the outer decorator's own arg, with an inner decorator on an unrelated class expression", () => {
    const context = captureContext(
      `@Directive({ template: <div/>, x: class { @Component({ y: 1 }) z() {} } })\nclass X {}`,
    );
    expect(context.decoratorNames).toEqual(["Directive"]);
    expect(context.enclosingDecoratorNames).toEqual([]);
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(true);
  });

  it("reports no decorator names for a plain (non-decorator) call — the no-host-knowledge guarantee", () => {
    const context = captureContext(`foo({ template: <div/> });`);
    expect(context.propertyKey).toBe("template");
    expect(context.decoratorNames).toEqual([]);
    // Not a decorator's own argument object, so nothing here claims a
    // decorator frame — packages/parser has no notion of "is this a
    // decorator-shaped call", only of an actual `@decorator` syntax node.
  });

  it("reports a string-literal key the same as an identifier key", () => {
    const context = captureContext(
      `@Component({ "template": <div/> })\nclass X {}`,
    );
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(true);
  });

  it("reports a null property key for a computed key", () => {
    const context = captureContext(
      `@Component({ [computedKey()]: <div/> })\nclass X {}`,
    );
    expect(context.propertyKey).toBeNull();
    expect(context.isDirectPropertyValue).toBe(false);
  });

  it("reports a null property key for a method-shorthand property", () => {
    // A method-shorthand key (`template() { ... }`) has no colon at all, so
    // it never reaches the property-frame push that only fires on `eat(colon)`
    // — an MX region cannot appear as a method's own key position anyway.
    const context = captureContext(
      `@Component({ template() { return <div/>; } })\nclass X {}`,
    );
    expect(context.propertyKey).toBeNull();
  });

  describe("isDirectPropertyValue is an exact-position test, not a shape heuristic", () => {
    const cases: Array<[label: string, source: string]> = [
      [
        "ternary branch",
        `@Component({ template: cond ? <div/> : <span/> })\nclass X {}`,
      ],
      [
        "template-literal interpolation",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: exercising ${...} inside an authored template literal, not this test file's own interpolation
        "@Component({ template: `${<div/>}` })\nclass X {}",
      ],
      ["arrow body", `@Component({ template: () => <div/> })\nclass X {}`],
      ["parenthesized", `@Component({ template: (<div/>) })\nclass X {}`],
      ["logical-or RHS", `@Component({ template: a || <div/> })\nclass X {}`],
      ["assignment RHS", `@Component({ template: (x = <div/>) })\nclass X {}`],
      [
        "sequence expression",
        `@Component({ template: (a, <div/>) })\nclass X {}`,
      ],
    ];

    for (const [label, source] of cases) {
      it(`${label} → false`, () => {
        const context = captureContext(source);
        expect(context.propertyKey).toBe("template");
        expect(context.isDirectPropertyValue).toBe(false);
      });
    }
  });

  it("reports not direct for a spread-wrapped object", () => {
    // `{ ...{ template: <div/> } }` is two nested object literals connected
    // by a spread, not a caller writing the property directly. The spread's
    // own operand pushes a keyless "property" frame (region-context.ts) so
    // the outermost-frame anchor sees this as one level deeper than
    // `{ template: <div/> }`, without any frame-kind counting.
    const context = captureContext(
      `@Component({ ...{ template: <div/> } })\nclass X {}`,
    );
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(false);
  });
});

describe("mxRegionPositionCheck rejection", () => {
  it("raises a positioned error at the region start on { ok: false }", () => {
    const source = `@Outer({ template: <div/> })\nclass X {}`;
    const regionStart = source.indexOf("<div/>");

    let error: unknown;
    try {
      parseSolid(source, "test.solid.mx", {
        plugins: DECORATOR_PLUGINS,
        mxRegionPositionCheck: () => ({
          ok: false,
          message: "not allowed here",
        }),
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SyntaxError);
    const err = error as SyntaxError & {
      loc?: { line: number; column: number; index: number };
    };
    expect(err.message).toContain("not allowed here");
    expect(err.loc).toBeTruthy();
    expect(err.loc?.index).toBe(regionStart);
    const before = source.slice(0, regionStart);
    const line = before.split("\n").length;
    const column = regionStart - before.lastIndexOf("\n") - 1;
    expect(err.loc?.line).toBe(line);
    expect(err.loc?.column).toBe(column);
  });
});

describe("computeMxRegionContext (unit)", () => {
  it("matches the Angular host's five-line check against the canonical direct shape", () => {
    const stack: MxRegionParentFrame[] = [
      { kind: "decorator", name: "Component" },
      { kind: "boundary", valueStart: 42, argumentIndex: 0 },
      { kind: "property", key: "template", valueStart: 42 },
    ];
    const context = computeMxRegionContext(stack, 42);
    // Mirrors notes/investigations/angular-ng-mx-spike.md §Q4's five-line
    // `ngMxPositionCheck`, plus `argumentIndex === 0` — Angular's own
    // `@Component({ template: ... })` decorator always takes exactly one
    // argument, so the real check pins that too, not just the shape.
    const ngMxPositionCheck = (ctx: MxRegionContext) =>
      ctx.propertyKey === "template" &&
      ctx.isDirectPropertyValue &&
      ctx.argumentIndex === 0 &&
      ctx.decoratorNames.includes("Component")
        ? { ok: true as const }
        : {
            ok: false as const,
            message:
              "an MX region in a `.ng.mx` file is only valid as the `template` property of an `@Component({ … })` decorator.",
          };
    expect(ngMxPositionCheck(context)).toEqual({ ok: true });
  });

  it("is false when the region start doesn't match the property's valueStart", () => {
    const stack: MxRegionParentFrame[] = [
      { kind: "decorator", name: "Component" },
      { kind: "property", key: "template", valueStart: 42 },
    ];
    // A region starting somewhere other than exactly 42 — e.g. nested a few
    // characters into the value expression.
    const context = computeMxRegionContext(stack, 50);
    expect(context.isDirectPropertyValue).toBe(false);
  });

  it("rejects a region with no enclosing decorator", () => {
    const context = computeMxRegionContext([], 0);
    expect(context).toEqual({
      propertyKey: null,
      decoratorNames: [],
      enclosingDecoratorNames: [],
      isDirectPropertyValue: false,
      argumentIndex: null,
    });
  });

  it("scopes decoratorNames to the innermost decorator, reporting the rest in enclosingDecoratorNames", () => {
    // A class expression nested inside an outer decorator's own argument can
    // carry its own inner decorator, e.g.
    // `@Directive({ x: class { @Component({ template: <div/> }) accessor y } })`.
    // decoratorNames/propertyKey/isDirectPropertyValue/argumentIndex are all
    // scoped to the innermost decorator (Component); the outer one
    // (Directive) is reported separately.
    const stack: MxRegionParentFrame[] = [
      { kind: "decorator", name: "Directive" },
      { kind: "boundary", valueStart: 0, argumentIndex: 0 },
      { kind: "property", key: "x", valueStart: 0 },
      { kind: "decorator", name: "Component" },
      { kind: "boundary", valueStart: 100, argumentIndex: 0 },
      { kind: "property", key: "template", valueStart: 100 },
    ];
    const context = computeMxRegionContext(stack, 100);
    expect(context.decoratorNames).toEqual(["Component"]);
    expect(context.enclosingDecoratorNames).toEqual(["Directive"]);
    expect(context.propertyKey).toBe("template");
    expect(context.isDirectPropertyValue).toBe(true);
    expect(context.argumentIndex).toBe(0);
  });
});

describe("MX region positioning: option absent leaves behavior unchanged", () => {
  it("parses the same shapes with no mxRegionPositionCheck set", () => {
    expect(() =>
      parseSolid(
        `@Component({ template: <div/> })\nclass X {}`,
        "test.solid.mx",
        { plugins: DECORATOR_PLUGINS },
      ),
    ).not.toThrow();
    expect(() =>
      parseSolid(
        `@Component({ x: { template: <div/> } })\nclass X {}`,
        "test.solid.mx",
        { plugins: DECORATOR_PLUGINS },
      ),
    ).not.toThrow();
    expect(() => parseSolid(`<div/>;`, "test.solid.mx")).not.toThrow();
  });
});
