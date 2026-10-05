import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import generate from "@babel/generator";
import type { Expression } from "@babel/types";
import { parseBabel, print } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import { parseSolid, solidRegionCompile } from "./test-helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * These shape/lowering fixtures use bare capitalized tags with no import —
 * they exercise how a component call lowers, not tag resolution. Since
 * decision 114 makes an unresolved capitalized tag a compile error, every
 * capitalized identifier the fixture source uses is declared bound (as
 * `mxModuleBindings` would be for a real caller's surrounding module),
 * matching Marko's own rule (`tag.scope.hasBinding(tagName)`) that any
 * in-scope binding — real or not — is what actually decides resolvability.
 *
 * Also declared as if each were a `.mx` default import (decision 116): these
 * fixtures test render-prop/attribute-tag lowering shapes, not the
 * value-import-as-tag routing decision, so every bare name keeps its
 * pre-116 direct-call shape (`<For .../>`) rather than incidentally
 * exercising the dynamic-tag path with no real specifier to check.
 */
function moduleBindingsFor(source: string): Set<string> {
  return new Set(source.match(/(?<=<)[A-Z][A-Za-z0-9]*/g) ?? []);
}

const parseMx = (source: string) => {
  const bindings = moduleBindingsFor(source);
  return parseSolid(source, undefined, {
    mxModuleBindings: bindings,
    mxImportSpecifiers: new Map(
      [...bindings].map((name) => [name, `./${name}.mx`]),
    ),
    mxImportDefaultFromMarkoOrMx: bindings,
  });
};

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
    // decision 116: `AttrCallee` is a `.tsx` default import (a plain
    // function, the "host component" case), not `.marko`/`.mx`, so it
    // lowers as a dynamic tag rather than a direct `<AttrCallee .../>`
    // call — `valueImportBinding` still lets the typed attribute-tag check
    // reference `AttrCallee` for `Parameters<typeof AttrCallee>[0][...]`.
    const filename = join(HERE, "fixtures", "caller.solid.mx");
    const source =
      'import AttrCallee from "./attr-callee.tsx";\nconst el = <AttrCallee><@item>typed</@item></AttrCallee>;';
    const result = print(source, filename, {
      mxRegionCompile: solidRegionCompile,
    });
    // The accessor is parenthesized: `satisfies` binds tighter than an
    // arrow function and would otherwise check the returned fragment.
    // `$mxDynN`'s serial is a process-wide counter, not per-test, so it is
    // normalized before comparing — the exact number is not the assertion.
    expect(
      result.code.replace(/\s+/g, " ").replace(/__mxDyn\d+/g, "__mxDyn"),
    ).toBe(
      'import AttrCallee from "./attr-callee.tsx"; const el = (() => {const __mxDyn = AttrCallee;if (__mxDyn !== null && typeof __mxDyn === "object" && (Object.getPrototypeOf(__mxDyn) === Object.prototype || Object.getPrototypeOf(__mxDyn) === null) && Object.prototype.hasOwnProperty.call(__mxDyn, "content")) throw new Error("MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <${x.content}/>");return typeof __mxDyn === "string" || typeof __mxDyn === "function" ? <Dynamic component={__mxDyn} item={(() => <>typed</>) satisfies NonNullable<Parameters<typeof AttrCallee>[0]["item"]> as any} /> : __mxDyn;})();',
    );
    expect(() =>
      parseBabel(result.code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      }),
    ).not.toThrow();
    expect(result.dependencies).toContain(
      join(HERE, "fixtures", "attr-callee.tsx"),
    );
  });

  it("prints a generated `satisfies` type intact when the region spans lines", () => {
    // The emitted region is one line and the authored one is not, so a
    // generated node's offset can name a later source line. A type reference
    // whose name and type arguments land on different lines was printed as
    // `NonNullable(\n<Parameters<...>>)`, which is not TypeScript.
    //
    // decision 116: `AttrCallee` is a `.tsx` default import, so it lowers
    // as a dynamic tag (see the test above) — the assertion here is on the
    // generated `satisfies` type staying intact, unaffected by that change.
    const filename = join(HERE, "fixtures", "caller.solid.mx");
    const source = [
      'import AttrCallee from "./attr-callee.tsx";',
      "const el = (",
      "  <AttrCallee>",
      "    <@item>",
      "      <strong>typed</strong>",
      "    </@item>",
      "  </AttrCallee>",
      ");",
    ].join("\n");
    const result = print(source, filename, {
      mxRegionCompile: solidRegionCompile,
    });
    // `$mxDynN`'s serial is a process-wide counter, not per-test, so it is
    // normalized before comparing — the exact number is not the assertion.
    expect(
      result.code.replace(/\s+/g, " ").replace(/__mxDyn\d+/g, "__mxDyn"),
    ).toBe(
      'import AttrCallee from "./attr-callee.tsx"; const el = (() => {const __mxDyn = AttrCallee; if (__mxDyn !== null && typeof __mxDyn === "object" && (Object.getPrototypeOf(__mxDyn) === Object.prototype || Object.getPrototypeOf(__mxDyn) === null) && Object.prototype.hasOwnProperty.call(__mxDyn, "content")) throw new Error("MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <${x.content}/>");return typeof __mxDyn === "string" || typeof __mxDyn === "function" ? <Dynamic component={__mxDyn} item={(() => <strong>typed</strong>) satisfies NonNullable<Parameters<typeof AttrCallee>[0]["item"]> as any} /> : __mxDyn;})();',
    );
    expect(() =>
      parseBabel(result.code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      }),
    ).not.toThrow();
  });

  it("does not recurse when two Solid callees import each other", () => {
    const filename = join(HERE, "fixtures", "mutual-a.solid.mx");
    const source = readFileSync(filename, "utf8");
    const result = print(source, filename, {
      mxRegionCompile: solidRegionCompile,
    });
    expect(result.code.replace(/\s+/g, " ")).toContain(
      '<MutualB b={(() => <>B</>) satisfies NonNullable<Parameters<typeof MutualB>[0]["b"]> as any} />',
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
    expect(code).toContain("? [...mxList] : [])(xs())");
    expect(code).toContain(".flatMap((x, mxAttrIndex) =>");
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

describe("solidmx-import-drops-single-line-params repro", () => {
  it("keeps a single-line <For> param when the file has a leading import", () => {
    const source = [
      'import { x } from "./x";',
      "const el = <For|item| each=items()><li>${item()}</li></For>;",
    ].join("\n");
    const code = printFirstExpression(source);
    expect(code).toContain("{item => <li>{item()}</li>}");
    expect(() =>
      parseBabel(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      }),
    ).not.toThrow();
  });

  it("keeps multiple single-line <For>/<Show> params after a leading import", () => {
    const source = [
      'import { x } from "./x";',
      "const el = <For|item, i| each=items()><li>${item()}-${i()}</li></For>;",
    ].join("\n");
    const code = printFirstExpression(source);
    expect(code).toContain("{(item, i) => <li>{item()}-{i()}</li>}");
  });
});

/**
 * `solidmx-multiline-region`: the same base-position mismatch this bridge
 * relies on for `import`/`satisfies` also corrupted a parenthesized/
 * multi-line region's own `<for>` params and attribute values, since both
 * bugs share one root cause in `compileSolidMx`'s `positionedSource`
 * padding — see `packages/hosts/solid/src/index.ts`.
 */
describe("solidmx-multiline-region repro", () => {
  it("keeps a single-param <for> across a parenthesized multi-line region", () => {
    const source = [
      "const el = (",
      "  <for|p| of=xs()>",
      "    <li>${p.name}</li>",
      "  </for>",
      ");",
    ].join("\n");
    const code = printFirstExpression(source);
    expect(code).toContain("p => <li>{p.name}</li>");
  });

  it("parses a two-param multi-line <for> (used to be a hard parse error)", () => {
    const source = [
      "const el = (",
      "  <for|p, i| of=xs()>",
      "    <li>${p.name}-${i}</li>",
      "  </for>",
      ");",
    ].join("\n");
    const code = printFirstExpression(source);
    expect(code).toContain("(p, i) =>");
    expect(code).toContain("p.name");
    expect(code).toContain("i()");
  });

  it("parses a multi-line `step=` attribute on <for>", () => {
    const source = [
      "const el = (",
      "  <for|i| from=0 to=10",
      "    step=2>",
      "    <li>${i}</li>",
      "  </for>",
      ");",
    ].join("\n");
    const code = printFirstExpression(source);
    expect(() =>
      parseBabel(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      }),
    ).not.toThrow();
    expect(code).toContain("0 + __mxIndex * 2");
  });
});
