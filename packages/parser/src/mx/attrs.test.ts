import { describe, expect, it } from "vitest";
import { parseSolid } from "./test-helpers.ts";

/** Walks the AST collecting every node of a given type. */
function collect(node: unknown, type: string, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, type, out);
    return out;
  }
  const record = node as Record<string, unknown>;
  if (record.type === type) out.push(record);
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "extra") continue;
    collect(record[key], type, out);
  }
  return out;
}

const parseMx = (source: string) => parseSolid(source);

const attrsOf = (source: string) => {
  const file = parseMx(source);
  const element = collect(file, "JSXElement")[0] as {
    openingElement: { attributes: Record<string, unknown>[] };
  };
  return element.openingElement.attributes;
};

function expectSyntaxError(fn: () => void, expected: string) {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SyntaxError);
  expect((error as Error).message).toContain(expected);
}

describe("spread attributes", () => {
  it("lowers `...expr` to a JSXSpreadAttribute", () => {
    const attrs = attrsOf(`const el = <div ...props>x</div>;`);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]?.type).toBe("JSXSpreadAttribute");
    const argument = attrs[0]?.argument as { type: string; name: string };
    expect(argument.type).toBe("Identifier");
    expect(argument.name).toBe("props");
  });

  it("preserves order relative to other attributes", () => {
    const attrs = attrsOf(`const el = <div a="1" ...rest b="2">x</div>;`);
    expect(attrs.map((a) => a.type)).toEqual([
      "JSXAttribute",
      "JSXSpreadAttribute",
      "JSXAttribute",
    ]);
    expect((attrs[0] as { name: { name: string } }).name.name).toBe("a");
    expect((attrs[2] as { name: { name: string } }).name.name).toBe("b");
  });
});

describe("class shorthand", () => {
  it("lowers `.class.big` to a static class attribute", () => {
    const attrs = attrsOf(`const el = <div.card.big>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { type: string; value: string };
    };
    expect(attr.name.name).toBe("class");
    expect(attr.value.type).toBe("StringLiteral");
    expect(attr.value.value).toBe("card big");
  });

  it("merges shorthand with an explicit string class, shorthand first", () => {
    const attrs = attrsOf(`const el = <div.card class="x">y</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as { value: { value: string } };
    expect(attr.value.value).toBe("card x");
  });

  it("is a parse error combined with a non-string class expression", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div.card class=someObj>y</div>;`),
      "combine shorthand with a string class or use class={...}",
    );
  });

  it("folds a static class into the array's string entry, emitting class once", () => {
    // `<div.card class="x" class={c: on()}>` must be a single
    // `class={["card x", {c: on()}]}`. Emitting both `class="card x"` and
    // `class={[...]}` puts the name twice on one element and every backend
    // keeps only the last, silently dropping the other half.
    const attrs = attrsOf(
      `const el = <div.card class="x" class={c: on()}>y</div>;`,
    );
    const classAttrs = (attrs as { name: { name: string } }[]).filter(
      (a) => a.name.name === "class",
    );
    expect(classAttrs).toHaveLength(1);
    const attr = classAttrs[0] as unknown as {
      value: {
        expression: {
          type: string;
          elements: [{ type: string; value: string }, { type: string }];
        };
      };
    };
    expect(attr.value.expression.type).toBe("ArrayExpression");
    expect(attr.value.expression.elements[0].value).toBe("card x");
    expect(attr.value.expression.elements[1].type).toBe("ObjectExpression");
  });

  it("folds a static class into the array even without shorthand", () => {
    const attrs = attrsOf(`const el = <div class="x" class={c: on()}>y</div>;`);
    const classAttrs = (attrs as { name: { name: string } }[]).filter(
      (a) => a.name.name === "class",
    );
    expect(classAttrs).toHaveLength(1);
    const attr = classAttrs[0] as unknown as {
      value: { expression: { type: string; elements: [{ value: string }] } };
    };
    expect(attr.value.expression.type).toBe("ArrayExpression");
    expect(attr.value.expression.elements[0].value).toBe("x");
  });

  it("merges shorthand with an object class into the array form", () => {
    // Solid 2's `class` accepts a recursive array, so shorthand plus an
    // object is a merge rather than the conflict it was against 1.x's
    // separate `classList` prop.
    const attrs = attrsOf(`const el = <div.card.big class={a: on()}>y</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: {
        expression: {
          type: string;
          elements: [{ type: string; value: string }, { type: string }];
        };
      };
    };
    expect(attr.name.name).toBe("class");
    expect(attr.value.expression.type).toBe("ArrayExpression");
    // Shorthand first: later array entries win, so the object must be able to
    // toggle a class the shorthand set.
    expect(attr.value.expression.elements[0].type).toBe("StringLiteral");
    expect(attr.value.expression.elements[0].value).toBe("card big");
    expect(attr.value.expression.elements[1].type).toBe("ObjectExpression");
  });
});

describe("id shorthand", () => {
  it("lowers `#main` to a static id attribute", () => {
    const attrs = attrsOf(`const el = <div#main>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { type: string; value: string };
    };
    expect(attr.name.name).toBe("id");
    expect(attr.value.type).toBe("StringLiteral");
    expect(attr.value.value).toBe("main");
  });

  it("is a parse error combined with an explicit id= attribute", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div#main id="other">x</div>;`),
      "Cannot have shorthand id and id attribute",
    );
  });
});

describe("class={} object stays on class (no classList in Solid 2)", () => {
  it("keeps an object-literal class value on `class`", () => {
    const attrs = attrsOf(`const el = <div class={a: on(), b: true}>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: {
        type: string;
        expression: { type: string; properties: unknown[] };
      };
    };
    // Solid 2 removed `classList`: one `class` prop takes a string, an object,
    // or a recursive array of either.
    expect(attr.name.name).toBe("class");
    expect(attr.value.type).toBe("JSXExpressionContainer");
    expect(attr.value.expression.type).toBe("ObjectExpression");
    expect(attr.value.expression.properties).toHaveLength(2);
  });

  it("never emits a classList attribute", () => {
    for (const source of [
      `const el = <div class={a: on()}>x</div>;`,
      `const el = <div.card class={a: on()}>x</div>;`,
      `const el = <div class=someObj>x</div>;`,
    ]) {
      const attrs = attrsOf(source) as { name: { name: string } }[];
      expect(attrs.map((a) => a.name.name)).not.toContain("classList");
    }
  });

  it("keeps class=someObj as class={someObj}", () => {
    const attrs = attrsOf(`const el = <div class=someObj>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { expression: { type: string; name: string } };
    };
    expect(attr.name.name).toBe("class");
    expect(attr.value.expression.type).toBe("Identifier");
    expect(attr.value.expression.name).toBe("someObj");
  });
});

describe("style={} object container", () => {
  it("wraps an object-literal style value in a double-brace container", () => {
    const attrs = attrsOf(`const el = <div style={color: c()}>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { expression: { type: string; properties: unknown[] } };
    };
    expect(attr.name.name).toBe("style");
    expect(attr.value.expression.type).toBe("ObjectExpression");
    expect(attr.value.expression.properties).toHaveLength(1);
  });

  it("is a parse error for a non-object style value", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div style=c()>x</div>;`),
      "non-object value",
    );
  });
});

describe("namespaced attributes", () => {
  it("passes `prop:` through as a JSXNamespacedName (the one surviving namespace)", () => {
    const attrs = attrsOf(`const el = <div prop:value=v>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: {
        type: string;
        namespace: { name: string };
        name: { name: string };
      };
    };
    expect(attr.name.type).toBe("JSXNamespacedName");
    expect(attr.name.namespace.name).toBe("prop");
    expect(attr.name.name.name).toBe("value");
  });

  it("passes the `prop:` attr-method form through as a block-body arrow", () => {
    const attrs = attrsOf(`const el = <div prop:onx(e) { go(e) }>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { type: string; namespace: { name: string } };
      value: {
        expression: { type: string; params: unknown[]; body: { type: string } };
      };
    };
    expect(attr.name.type).toBe("JSXNamespacedName");
    expect(attr.name.namespace.name).toBe("prop");
    expect(attr.value.expression.type).toBe("ArrowFunctionExpression");
    expect(attr.value.expression.body.type).toBe("BlockStatement");
  });

  // Solid 2 removed these namespaces outright — they are absent from
  // `@solidjs/web`'s `jsx.d.ts`, so passing them through would emit props the
  // compiler ignores. Each parse error names the replacement (decision 10).
  const removed: [string, string][] = [
    ["on:scroll=fn", "onX=fn"],
    ["oncapture:click=fn", "capture: true"],
    ["attr:title=t", "use the plain attribute"],
    ["bool:open=o", "use the plain attribute"],
    ["use:tooltip=opts", "ref=foo(opts)"],
  ];

  for (const [attr, hint] of removed) {
    it(`rejects \`${attr}\` with its fix-it hint`, () => {
      expectSyntaxError(
        () => parseMx(`const el = <div ${attr}>x</div>;`),
        hint,
      );
    });

    it(`rejects \`${attr}\` naming the removal`, () => {
      expectSyntaxError(
        () => parseMx(`const el = <div ${attr}>x</div>;`),
        "removed in Solid 2",
      );
    });
  }

  it("rejects the removed namespaces in attr-method form too", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div on:scroll(e) { go(e) }>x</div>;`),
      "removed in Solid 2",
    );
  });
});

describe("ref", () => {
  it("lowers `ref=el` to `ref={el}`", () => {
    const attrs = attrsOf(`const el = <div ref=target>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { type: string; expression: { type: string; name: string } };
    };
    expect(attr.name.name).toBe("ref");
    expect(attr.value.type).toBe("JSXExpressionContainer");
    expect(attr.value.expression.type).toBe("Identifier");
    expect(attr.value.expression.name).toBe("target");
  });

  it("lowers the attr-method form `ref(el) { ... }` to a block-body arrow", () => {
    const attrs = attrsOf(`const el = <div ref(node) { save(node) }>x</div>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: {
        expression: { type: string; params: unknown[]; body: { type: string } };
      };
    };
    expect(attr.name.name).toBe("ref");
    expect(attr.value.expression.type).toBe("ArrowFunctionExpression");
    expect(attr.value.expression.params).toHaveLength(1);
    expect(attr.value.expression.body.type).toBe("BlockStatement");
  });
});

describe("data-* and aria-* pass-through", () => {
  it("keeps hyphenated names as a plain JSXIdentifier", () => {
    const attrs = attrsOf(
      `const el = <div data-count=n() aria-label="x">y</div>;`,
    );
    expect(attrs).toHaveLength(2);
    const [dataAttr, ariaAttr] = attrs as {
      name: { type: string; name: string };
    }[];
    expect(dataAttr?.name.type).toBe("JSXIdentifier");
    expect(dataAttr?.name.name).toBe("data-count");
    expect(ariaAttr?.name.type).toBe("JSXIdentifier");
    expect(ariaAttr?.name.name).toBe("aria-label");
  });
});

describe("boolean attribute", () => {
  it("lowers `disabled` to `disabled={true}`", () => {
    const attrs = attrsOf(`const el = <input disabled>;`);
    expect(attrs).toHaveLength(1);
    const attr = attrs[0] as {
      name: { name: string };
      value: { expression: { type: string; value: boolean } };
    };
    expect(attr.name.name).toBe("disabled");
    expect(attr.value.expression.type).toBe("BooleanLiteral");
    expect(attr.value.expression.value).toBe(true);
  });
});

describe("static string values keep their value", () => {
  it("keeps double quotes", () => {
    const attrs = attrsOf(`const el = <div title="hi">x</div>;`);
    const attr = attrs[0] as { value: { extra: { raw: string } } };
    expect(attr.value.extra.raw).toBe('"hi"');
  });

  it("canonicalizes single quotes without changing the value", () => {
    const attrs = attrsOf(`const el = <div title='hi'>x</div>;`);
    const attr = attrs[0] as { value: { extra: { raw: string } } };
    expect(attr.value.extra.raw).toBe('"hi"');
  });
});

describe("raw placeholder ($!{}) as innerHTML", () => {
  it("lowers a sole $!{} child to an innerHTML attribute with no children", () => {
    const file = parseMx(`const el = <div>$!{html}</div>;`);
    const element = collect(file, "JSXElement")[0] as {
      openingElement: { attributes: { name: { name: string } }[] };
      children: unknown[];
    };
    expect(element.children).toHaveLength(0);
    expect(element.openingElement.attributes).toHaveLength(1);
    expect(element.openingElement.attributes[0]?.name.name).toBe("innerHTML");
  });

  it("is a parse error when $!{} is mixed with other children", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div>x$!{html}</div>;`),
      "raw placeholder must be the only child",
    );
  });

  it("allows whitespace and comments alongside the sole raw placeholder", () => {
    const file = parseMx(`const el = <div>\n  <!-- c -->$!{html}\n</div>;`);
    const element = collect(file, "JSXElement")[0] as {
      openingElement: { attributes: { name: { name: string } }[] };
      children: unknown[];
    };
    expect(element.children).toHaveLength(0);
    expect(element.openingElement.attributes[0]?.name.name).toBe("innerHTML");
  });

  it("is a parse error combined with an explicit innerHTML= attribute", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div innerHTML=a>$!{b}</div>;`),
      "combined with an explicit `innerHTML=` attribute",
    );
  });
});

describe("round 3: attribute order and position (PR #6 review)", () => {
  it("keeps a preceding spread able to override the merged shorthand class", () => {
    // '<div.card ...props class="x">' must not reorder the merged class ahead
    // of the spread: the spread should still be able to override it.
    const attrs = attrsOf(`const el = <div.card ...props class="x">y</div>;`);
    expect(attrs.map((a) => a.type)).toEqual([
      "JSXSpreadAttribute",
      "JSXAttribute",
    ]);
    const classAttr = attrs[1] as {
      name: { name: string };
      value: { value: string };
    };
    expect(classAttr.name.name).toBe("class");
    expect(classAttr.value.value).toBe("card x");
  });

  it("keeps the merged shorthand class in place among other attributes", () => {
    const attrs = attrsOf(
      `const el = <div.card data-x="1" class="y" data-z="2">w</div>;`,
    );
    expect(
      attrs.map((a) => (a as { name: { name: string } }).name.name),
    ).toEqual(["data-x", "class", "data-z"]);
  });

  it("produces disjoint ranges for the merged class and its sibling attributes", () => {
    const source = `const el = <div.card data-x=1 class="x">y</div>;`;
    const attrs = attrsOf(source) as { start: number; end: number }[];
    const [dataX, classAttr] = attrs;
    expect(dataX).toBeTruthy();
    expect(classAttr).toBeTruthy();
    // The merged class attribute must not overlap the data-x attribute that
    // precedes it in source order.
    expect((dataX as { end: number }).end).toBeLessThanOrEqual(
      (classAttr as { start: number }).start,
    );
  });

  it("merges and escapes a value containing a double quote", () => {
    const attrs = attrsOf(`const el = <div.card class='a"b'>y</div>;`);
    const attr = attrs[0] as {
      value: { value: string; extra: { raw: string } };
    };
    expect(attr.value.value).toBe('card a"b');
    expect(attr.value.extra.raw).toBe(`"card a&quot;b"`);
  });

  it("merges a value containing a single quote using double-quote raw form", () => {
    const attrs = attrsOf(`const el = <div.card class="a'b">y</div>;`);
    const attr = attrs[0] as {
      value: { value: string; extra: { raw: string } };
    };
    expect(attr.value.value).toBe("card a'b");
    expect(attr.value.extra.raw).toBe(`"card a'b"`);
  });

  it("escapes a merged value containing both quote characters", () => {
    const attrs = attrsOf(`const el = <div.card class='a"b\\'c'>y</div>;`);
    const attr = attrs[0] as {
      value: { value: string; extra: { raw: string } };
    };
    expect(attr.value.value).toBe(`card a"b'c`);
    expect(attr.value.extra.raw).toBe(`"card a&quot;b'c"`);
  });

  it("is a parse error for an empty namespace (`:foo=1`)", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div :foo=1>x</div>;`),
      "malformed namespaced attribute",
    );
  });

  it("is a parse error for a doubly-namespaced name (`a:b:c=1`)", () => {
    expectSyntaxError(
      () => parseMx(`const el = <div a:b:c=1>x</div>;`),
      "malformed namespaced attribute",
    );
  });
});
