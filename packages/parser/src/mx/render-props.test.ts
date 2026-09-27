import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import generate from "@babel/generator";
import type { Expression } from "@babel/types";
import { describe, expect, it } from "vitest";
import { print } from "../index.ts";
import { parseSolid, solidRegionCompile } from "./test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const parseMx = (source: string) => parseSolid(source);

/** Prints the sole top-level statement's expression for a `const el = <...>;` source. */
function printFirstExpression(source: string): string {
  const file = parseMx(source);
  const stmt = file.program.body.find(
    (item: { type?: string }) => item.type === "VariableDeclaration",
  ) as unknown as {
    declarations: [{ init: Expression }];
  };
  const init = stmt.declarations[0].init;
  return generate(init).code;
}

function expectSyntaxError(
  source: string,
  expected: string,
  position?: { line: number; column: number },
) {
  let error: unknown;
  try {
    parseMx(source);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SyntaxError);
  expect((error as Error).message).toContain(expected);
  if (position) expect(error).toMatchObject({ loc: position });
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
  it("uses an imported callee's Input from the surrounding module", () => {
    const filename = join(HERE, "fixtures", "caller.solid.mx");
    const source =
      'import AttrCallee from "./attr-callee.tsx";\nconst el = <AttrCallee><@item>typed</@item></AttrCallee>;';
    const result = print(source, filename, {
      mxRegionCompile: solidRegionCompile,
    });
    expect(result.code.replace(/\s+/g, " ")).toContain(
      "item={() => <>typed</>}",
    );
    expect(result.dependencies).toContain(
      join(HERE, "fixtures", "attr-callee.tsx"),
    );
  });

  it("does not recurse when two SolidMX callees import each other", () => {
    const filename = join(HERE, "fixtures", "mutual-a.solid.mx");
    const source = readFileSync(filename, "utf8");
    const result = print(source, filename, {
      mxRegionCompile: solidRegionCompile,
    });
    expect(result.code.replace(/\s+/g, " ")).toContain(
      "<MutualB b={() => <>B</>} />",
    );
    expect(result.dependencies).toEqual([
      join(HERE, "fixtures", "mutual-b.solid.mx"),
    ]);
  });

  it("does not resolve a locally shadowed component through its module import", () => {
    const filename = join(HERE, "fixtures", "shadowed.solid.mx");
    const source =
      'import AttrCallee from "./attr-callee.tsx";\nfunction view(AttrCallee: unknown) { return <AttrCallee><@item>local</@item></AttrCallee>; }';
    const result = print(source, filename, {
      mxRegionCompile: solidRegionCompile,
    });
    expect(result.dependencies).not.toContain(
      join(HERE, "fixtures", "attr-callee.tsx"),
    );
  });
  it("turns an element body into a prop", () => {
    const code = printFirstExpression(
      `const el = <Layout><@header><h1>Title</h1></@header></Layout>;`,
    );
    expect(code.replace(/\s+/g, " ")).toContain(
      "header={() => <h1>Title</h1>}",
    );
  });

  it("turns params into a function prop", () => {
    const code = printFirstExpression(
      `const el = <Errored><@fallback|e, reset|><p>\${e.message}</p></@fallback></Errored>;`,
    );
    expect(code.replace(/\s+/g, " ")).toContain(
      "fallback={(e, reset) => () => <p>{e.message}</p>}",
    );
  });

  it("wraps a text-only body in a fragment", () => {
    // A bare JSXText is not valid in expression position, so the body wraps;
    // `wrapChildren` makes that decision for every caller.
    const code = printFirstExpression(
      `const el = <Layout><@header>Title</@header></Layout>;`,
    );
    expect(code.replace(/\s+/g, " ")).toContain("header={() => <>Title</>}");
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
    expect(code.replace(/\s+/g, " ")).toContain(
      "footer={year => () => <>{() => {",
    );
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
    const text = generate(
      (
        file.program.body[0] as unknown as {
          declarations: [{ init: Expression }];
        }
      ).declarations[0].init,
    ).code;
    expect(text).toContain("u => <b>hi</b>");
    expect(text).toContain("fallback={() => <>NOPE</>}");
    expect(text).not.toContain("@fallback");
  });
});

describe("attribute tag parse errors", () => {
  it("emits nested attribute tags recursively", () => {
    const code = printFirstExpression(
      `const el = <Layout><@header><@inner>x</@inner></@header></Layout>;`,
    );
    expect(code.replace(/\s+/g, " ")).toContain(
      'header={{ "inner": () => <>x</>, content: undefined }}',
    );
  });

  it("emits attributes on data-shaped attribute tags", () => {
    const code = printFirstExpression(
      `const el = <Layout><@header class="x">H</@header></Layout>;`,
    );
    expect(code.replace(/\s+/g, " ")).toContain(
      'header={{ "class": "x", content: () => <>H</> }}',
    );
  });

  it("rejects an attribute tag at the top level", () => {
    expectSyntaxError(
      `const el = <@header>x</@header>;`,
      "@tags must be nested within another element",
    );
  });

  it("emits an attribute tag inside `<if>` as a conditional value", () => {
    const code = printFirstExpression(
      `const el = <Layout><if=cond><@header>x</@header></if></Layout>;`,
    );
    expect(code.replace(/\s+/g, " ")).toContain(
      "header={cond ? () => <>x</> : undefined}",
    );
  });

  it("emits an attribute tag inside `<for>` as a real array", () => {
    const code = printFirstExpression(
      `const el = <Layout><for|x| of=xs()><@header>\${x}</@header></for></Layout>;`,
    );
    expect(code).toContain("[...xs()].flatMap((x, mxAttrIndex) =>");
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
