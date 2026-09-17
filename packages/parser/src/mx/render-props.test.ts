import generate from "@babel/generator";
import type { Expression } from "@babel/types";
import { describe, expect, it } from "vitest";
import { parseSolid } from "./test-helpers.ts";

const parseMx = (source: string) => parseSolid(source);

/** Prints the sole top-level statement's expression for a `const el = <...>;` source. */
function printFirstExpression(source: string): string {
  const file = parseMx(source);
  const stmt = file.program.body[0] as unknown as {
    declarations: [{ init: Expression }];
  };
  const init = stmt.declarations[0].init;
  return generate(init).code;
}

/** The first node of `type` in a tree, by depth-first walk. */
function collectFirst(node: unknown, type: string): unknown {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = collectFirst(item, type);
      if (hit) return hit;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  if (record.type === type) return record;
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "extra") continue;
    const hit = collectFirst(record[key], type);
    if (hit) return hit;
  }
  return null;
}

function expectSyntaxError(source: string, expected: string) {
  let error: unknown;
  try {
    parseMx(source);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SyntaxError);
  expect((error as Error).message).toContain(expected);
}

/**
 * Decision 51: tag params on components make the children a function. This
 * is what lets MX call Solid's own render-prop components natively.
 */
describe("tag params make the children a function", () => {
  it("lowers params on a component to a callback child", () => {
    const code = printFirstExpression(
      `const el = <For|item, i| each=xs()><li>\${item()}</li></For>;`,
    );
    expect(code).toContain("each={xs()}");
    expect(code).toContain("{(item, i) => <li>{item()}</li>}");
  });

  it("accepts destructured params", () => {
    const code = printFirstExpression(
      `const el = <Show|{ name }| when=user()><b>\${name}</b></Show>;`,
    );
    // `@babel/generator` breaks an ObjectPattern across lines, so the
    // assertion is on the collapsed form rather than the printed layout.
    expect(code.replace(/\s+/g, " ")).toContain(
      "{({ name }) => <b>{name}</b>}",
    );
  });

  it("accepts TypeScript-annotated params", () => {
    const code = printFirstExpression(
      `const el = <Show|u: User| when=user()><b>\${u.name}</b></Show>;`,
    );
    expect(code).toContain("(u: User) =>");
  });

  it("lowers empty params to a zero-argument arrow", () => {
    const code = printFirstExpression(`const el = <Wrap||><b>x</b></Wrap>;`);
    expect(code).toContain("<Wrap>{() => <b>x</b>}</Wrap>");
  });

  it("passes a single child through bare", () => {
    const code = printFirstExpression(`const el = <W|x|><b>\${x}</b></W>;`);
    expect(code).toContain("{x => <b>{x}</b>}");
    expect(code).not.toContain("<>");
  });

  it("wraps a multi-child body in a fragment", () => {
    const code = printFirstExpression(
      `const el = <W|x|><b>\${x}</b><i>y</i></W>;`,
    );
    expect(code).toContain("<>");
    expect(code).toContain("<b>{x}</b>");
    expect(code).toContain("<i>y</i>");
  });
});

/**
 * Decision 51, rule 2: `<@name>` inside a tag body becomes the prop `name` on
 * that tag.
 */
describe("attribute tags become props", () => {
  it("turns an element body into a prop", () => {
    const code = printFirstExpression(
      `const el = <Layout><@header><h1>Title</h1></@header></Layout>;`,
    );
    expect(code).toContain("header={<h1>Title</h1>}");
  });

  it("turns params into a function prop", () => {
    const code = printFirstExpression(
      `const el = <Errored><@fallback|e, reset|><p>\${e.message}</p></@fallback></Errored>;`,
    );
    expect(code).toContain("fallback={(e, reset) => <p>{e.message}</p>}");
  });

  it("wraps a text-only body in a fragment", () => {
    // A bare JSXText is not valid in expression position, so the body wraps;
    // `wrapChildren` makes that decision for every caller.
    const code = printFirstExpression(
      `const el = <Layout><@header>Title</@header></Layout>;`,
    );
    expect(code).toContain("header={<>Title</>}");
  });

  it("emits own attrs first, then attribute tags in source order, and keeps ordinary children", () => {
    const code = printFirstExpression(
      `const el = <Layout id="main"><@header>H</@header><p>body</p><@footer|year|>\${year}</@footer></Layout>;`,
    );
    const attrOrder = ["id=", "header=", "footer="].map((needle) =>
      code.indexOf(needle),
    );
    expect(attrOrder[0]).toBeGreaterThan(-1);
    expect(attrOrder[0]).toBeLessThan(attrOrder[1] as number);
    expect(attrOrder[1]).toBeLessThan(attrOrder[2] as number);
    expect(code).toContain("footer={year => ");
    // The non-attribute-tag children stay children.
    expect(code).toContain("<p>body</p>");
  });
});

describe("attribute tag / attribute collisions", () => {
  // An attribute tag lowers to a JSX attribute, so a name the parent already
  // carries would emit the prop twice and let the last one silently win.
  it("rejects an attribute tag colliding with a static attribute", () => {
    expectSyntaxError(
      `const el = <Layout id="x"><@id>y</@id></Layout>;`,
      "attribute tag `@id` collides with attribute `id`",
    );
  });

  it("rejects an attribute tag colliding with a dynamic attribute", () => {
    expectSyntaxError(
      `const el = <Layout header=h()><@header>y</@header></Layout>;`,
      "attribute tag `@header` collides with attribute `header`",
    );
  });

  it("rejects an attribute tag colliding with a boolean attribute", () => {
    expectSyntaxError(
      `const el = <Layout flag><@flag>y</@flag></Layout>;`,
      "attribute tag `@flag` collides with attribute `flag`",
    );
  });

  it("rejects an attribute tag colliding with an attribute method", () => {
    expectSyntaxError(
      `const el = <Layout onDone() { f(); }><@onDone>y</@onDone></Layout>;`,
      "attribute tag `@onDone` collides with attribute `onDone`",
    );
  });

  it("rejects `<@children>` alongside an explicit `children=` attribute", () => {
    expectSyntaxError(
      `const el = <Layout children=c()><@children>y</@children></Layout>;`,
      "attribute tag `@children` collides with attribute `children`",
    );
  });

  it("rejects `<@children>` when the parent also has ordinary children", () => {
    // The ordinary children lower to the `children` prop, so `<@children>`
    // would be a second producer of the same prop.
    expectSyntaxError(
      `const el = <Layout><@children>y</@children><p>body</p></Layout>;`,
      "attribute tag `@children` collides with",
    );
  });
});

describe("consumed attribute tags", () => {
  it("keeps a consumed attribute tag out of the params callback body", () => {
    // The `<@fallback>` child is consumed into a prop, so the arrow's body is
    // only `<b>...</b>`. Measuring the original child list would run the
    // arrow's `loc` past that and into the attribute tag's text — right JS,
    // wrong source map.
    const file = parseMx(
      `const el = <Show|u| when=user()><b>hi</b><@fallback>NOPE</@fallback></Show>;`,
    );
    const arrow = collectFirst(file, "ArrowFunctionExpression") as Expression;
    const text = generate(arrow).code;
    expect(text).toContain("<b>hi</b>");
    expect(text).not.toContain("NOPE");
    expect(text).not.toContain("@fallback");
  });
});

describe("attribute tag parse errors", () => {
  it("names the enclosing attribute tag when one is nested inside another", () => {
    expectSyntaxError(
      `const el = <Layout><@header><@inner>x</@inner></@header></Layout>;`,
      "attribute tag `<@inner>` inside attribute tag `<@header>`",
    );
  });

  it("rejects attributes on an attribute tag", () => {
    expectSyntaxError(
      `const el = <Layout><@header class="x">H</@header></Layout>;`,
      "attribute tags take params or a body, not attributes (v1)",
    );
  });

  it("rejects an attribute tag at the top level", () => {
    expectSyntaxError(
      `const el = <@header>x</@header>;`,
      "@tags must be nested within another element",
    );
  });

  it("rejects an attribute tag inside `<if>`", () => {
    expectSyntaxError(
      `const el = <if=cond><@header>x</@header></if>;`,
      "attribute tag `@header` on `<if>`",
    );
  });

  it("rejects an attribute tag inside `<for>`", () => {
    expectSyntaxError(
      `const el = <for|x| of=xs()><@header>y</@header></for>;`,
      "attribute tag `@header` on `<for>`",
    );
  });

  it("rejects an unknown attribute tag inside `<try>`", () => {
    expectSyntaxError(
      `const el = <try><@header>x</@header></try>;`,
      "unknown attribute tag `<@header>`",
    );
  });
});

/**
 * `<try>` is a core-owned custom tag (`packages/core/src/builtin-tags.ts`):
 * it declares `<@catch>`/`<@placeholder>` through the generic `attributeTags`
 * contract, so the shapes it emits are unchanged but the rejections it
 * inherits are the generic custom-tag ones.
 */
describe("`<try>` on the generic attribute-tag path", () => {
  it("still lowers to Errored/Loading", () => {
    const code = printFirstExpression(
      `const el = <try><@catch|e, reset|><p>\${e.message}</p></@catch><@placeholder>Loading…</@placeholder><Body/></try>;`,
    );
    expect(code).toContain("<Errored fallback={(e, reset) =>");
    expect(code).toContain("<Loading fallback={<>Loading…</>}>");
  });

  it("reports a duplicate `<@catch>` through the generic message", () => {
    expectSyntaxError(
      `const el = <try><@catch|e|>a</@catch><@catch|e|>b</@catch></try>;`,
      "attribute tag `<@catch>` may not be repeated",
    );
  });
});
