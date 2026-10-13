// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<define>` call (and every other node that is a JS expression: a dynamic
 * tag, an `<if>` chain, a `<for>`) that is the only child of a conditional
 * branch sits in an expression slot. It used to be written as a JSX child,
 * `cond ? {Foo()} : null`, which is not valid TSX (an object literal where an
 * expression belongs); inside a `<@catch|e|>` body the same braces made
 * `(e) => {Foo()}`, a block body that renders nothing. The slot now holds the
 * bare expression.
 *
 * `ts.createSourceFile` reports no parse diagnostic for the old output (it
 * reads `{Foo()}` as an object-literal method), so every case here also runs
 * through `@babel/parser` with the `jsx` and `typescript` plugins.
 */
import { parse } from "@babel/parser";
import { type Child, jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const DEFINE = "<define/Foo><p>inner</p></define>\n";
const IMP = 'import Bar from "./bar.mx"\n';
const CALL_ROW = "<define/Row|p|><li>${p.n}</li></define>\n";

const compile = (source: string): string =>
  compileHonoMx(source, "/fixtures/slot.mx").code;

/** What the component returns: the one `return (<>…</>);` of the module. */
function returned(code: string): string {
  const lines = code
    .split("\n")
    .filter((line) => /^ {2}return \(<.*\);$/.test(line));
  expect(lines).toHaveLength(1);
  return (lines[0] as string).trim();
}

/** A parse the TypeScript API would pass; Babel rejects the old braces. */
function parseTsx(code: string): void {
  parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
}

// [name, source, the component's return statement]
const CASES: Array<[string, string, string]> = [
  [
    "a define call as the only child of an <if>",
    `${DEFINE}<if=input.a><Foo/></if>`,
    "return (<>{input.a ? Foo() : null}</>);",
  ],
  [
    "inside an element",
    `${DEFINE}<div><if=input.a><Foo/></if></div>`,
    "return (<><div>{input.a ? Foo() : null}</div></>);",
  ],
  [
    "as the only child of an <else-if>",
    `${DEFINE}<if=input.a><p>a</p></if><else-if=input.b><Foo/></else-if>`,
    "return (<>{input.a ? <p>a</p> : input.b ? Foo() : null}</>);",
  ],
  [
    "as the only child of an <else>",
    `${DEFINE}<if=input.a><p>a</p></if><else><Foo/></else>`,
    "return (<>{input.a ? <p>a</p> : Foo()}</>);",
  ],
  [
    "in both the <if> and the <else>",
    `${DEFINE}<if=input.a><Foo/></if><else><Foo/></else>`,
    "return (<>{input.a ? Foo() : Foo()}</>);",
  ],
  [
    "in an <if> nested in an <if>",
    `${DEFINE}<if=input.a><if=input.b><Foo/></if></if>`,
    "return (<>{input.a ? input.b ? Foo() : null : null}</>);",
  ],
  [
    "in an <if> inside a <for>",
    `${DEFINE}<for|i| of=input.l><if=i><Foo/></if></for>`,
    "return (<>{((mxList) => mxList ? [...mxList] : [])(input.l).map((i) => <__mxFragment key={i}>{i ? Foo() : null}</__mxFragment>)}</>);",
  ],
  [
    "with attributes",
    `${CALL_ROW}<if=input.a><Row n=1/></if>`,
    'return (<>{input.a ? Row({ "n": 1 }) : null}</>);',
  ],
  [
    "with tag arguments",
    "<define/Row|a|><li>${a}</li></define>\n<if=input.a><Row(1)/></if>",
    "return (<>{input.a ? Row(1) : null}</>);",
  ],
  [
    "with a body",
    "<define/Box|{ content }|><div><${content}/></div></define>\n<if=input.a><Box>hi</Box></if>",
    "return (<>{input.a ? Box({ content: () => <><>hi</></> }) : null}</>);",
  ],
  [
    "a dynamic tag as the only child of an <if>",
    "<const/X=input.x/>\n<if=input.a><${X}/></if>",
    "return (<>{input.a ? __mxDynamic(X, {  }) : null}</>);",
  ],
  [
    "a dynamic tag with a body",
    "<const/X=input.x/>\n<if=input.a><${X}>hi</></if>",
    "return (<>{input.a ? __mxDynamic(X, { content: () => <><>hi</></> }) : null}</>);",
  ],
  [
    "a <for> as the only child of an <if>",
    `${DEFINE}<if=input.a><for|i| of=input.l><Foo/></for></if>`,
    "return (<>{input.a ? ((mxList) => mxList ? [...mxList] : [])(input.l).map((i) => <__mxFragment key={i}>{Foo()}</__mxFragment>) : null}</>);",
  ],
  [
    "a <for in> as the only child of an <if>",
    `${DEFINE}<if=input.a><for|k| in=input.o><Foo/></for></if>`,
    "return (<>{input.a ? Object.entries(input.o ?? {}).map(([k, value]) => <__mxFragment key={k}>{Foo()}</__mxFragment>) : null}</>);",
  ],
  [
    "a ranged <for> as the only child of an <if>",
    `${DEFINE}<if=input.a><for|i| from=0 to=2><Foo/></for></if>`,
    "return (<>{input.a ? Array.from({ length: Math.max(0, (2) - (0) + 1) }, (__mxUnused, __mxIndex) => (0) + __mxIndex).map((i) => <__mxFragment key={i}>{Foo()}</__mxFragment>) : null}</>);",
  ],
  [
    "a <@catch> body that is a define call (an arrow body, not a block)",
    `${DEFINE}<try><p/><@catch|e|><Foo/></@catch></try>`,
    "return (<><__mxErrorBoundary fallback={(e) => Foo()}>{() => (<><p /></>)}</__mxErrorBoundary></>);",
  ],
  [
    "a <@placeholder> body that is a define call",
    `${DEFINE}<try><p/><@placeholder><Foo/></@placeholder></try>`,
    "return (<><__mxSuspense fallback={Foo()}><p /></__mxSuspense></>);",
  ],
  [
    "a render-prop body (<Bar|i|>) that is a define call",
    `${DEFINE}import Bar from "./bar.mx"\n<Bar|i|><Foo/></Bar>`,
    "return (<><Bar>{(i) => Foo()}</Bar></>);",
  ],
  [
    "an <@item> body that is a define call (a prop value)",
    `${DEFINE}${IMP}<Bar><@item><Foo/></@item></Bar>`,
    "return (<><Bar item={Foo()} /></>);",
  ],
  [
    "an <@item> body that is a dynamic tag",
    `${IMP}<const/X=input.x/>\n<Bar><@item><${"$"}{X}/></@item></Bar>`,
    "return (<><Bar item={__mxDynamic(X, {  })} /></>);",
  ],
  [
    "an <@item> body that is a define call, inside an <if>",
    `${DEFINE}${IMP}<Bar><if=input.a><@item><Foo/></@item></if></Bar>`,
    "return (<><Bar item={input.a ? Foo() : undefined} /></>);",
  ],
  [
    "an <@item> body that is a define call, passed to a define (an object property)",
    `${DEFINE}<define/Box|{ item }|><${"$"}{item}/></define>\n<Box><@item><Foo/></@item></Box>`,
    'return (<>{Box({ "item": Foo() })}</>);',
  ],
  [
    "an <@item> body that is a define call, passed to a dynamic tag",
    `${DEFINE}<const/X=input.x/>\n<${"$"}{X}><@item><Foo/></@item></>`,
    'return (<>{__mxDynamic(X, { "item": Foo() })}</>);',
  ],
  [
    "an <@item|x|> body that is a define call (an arrow body, not a block)",
    `${DEFINE}${IMP}<Bar><@item|x|><Foo/></@item></Bar>`,
    "return (<><Bar item={(x) => Foo()} /></>);",
  ],
];

// Shapes that were already valid TSX and stay as they are: a fragment child
// list keeps `{Foo()}` (a JSX child), an element stays an element.
const UNCHANGED: Array<[string, string, string]> = [
  [
    "a define call next to text",
    `${DEFINE}<if=input.a><Foo/> x</if>`,
    "return (<>{input.a ? <>{Foo()} x</> : null}</>);",
  ],
  [
    "a define call next to an element",
    `${DEFINE}<if=input.a><Foo/><p>y</p></if>`,
    "return (<>{input.a ? <>{Foo()}<p>y</p></> : null}</>);",
  ],
  [
    "a define call as the only child of a <for>",
    `${DEFINE}<for|i| of=input.l><Foo/></for>`,
    "return (<>{((mxList) => mxList ? [...mxList] : [])(input.l).map((i) => <__mxFragment key={i}>{Foo()}</__mxFragment>)}</>);",
  ],
  [
    "an imported component as the only child of an <if>",
    `import Bar from "./bar.mx"\n<if=input.a><Bar/></if>`,
    "return (<>{input.a ? <Bar /> : null}</>);",
  ],
  [
    "a lone placeholder as the only child of an <if>",
    "<if=input.a>${input.x}</if>",
    "return (<>{input.a ? input.x : null}{null}</>);",
  ],
  [
    "a repeated <@item> keeps the call as the child of its keyed fragment",
    `${DEFINE}${IMP}<Bar><@item><Foo/></@item><@item><Foo/></@item></Bar>`,
    'return (<><Bar item={[<__mxFragment key={"0"}>{Foo()}</__mxFragment>, <__mxFragment key={"1"}>{Foo()}</__mxFragment>]} /></>);',
  ],
  [
    "a repeated <@item|x|> keeps the call as the child of its keyed fragment",
    `${DEFINE}${IMP}<Bar><@item|x|><Foo/></@item><@item|x|><Foo/></@item></Bar>`,
    'return (<><Bar item={[(x) => <__mxFragment key={"0"}>{Foo()}</__mxFragment>, (x) => <__mxFragment key={"1"}>{Foo()}</__mxFragment>]} /></>);',
  ],
  [
    "an <@item> body that is an imported component",
    `${IMP}import Baz from "./baz.mx"\n<Bar><@item><Baz/></@item></Bar>`,
    "return (<><Bar item={<Baz />} /></>);",
  ],
];

describe("hono: an expression node in an expression slot is written bare", () => {
  it.each(CASES)("%s", (_name, source, expected) => {
    const code = compile(source);
    expect(returned(code)).toBe(expected);
    expect(() => parseTsx(code)).not.toThrow();
  });

  it.each(UNCHANGED)("keeps %s as it was", (_name, source, expected) => {
    const code = compile(source);
    expect(returned(code)).toBe(expected);
    expect(() => parseTsx(code)).not.toThrow();
  });

  it("the parse check rejects the braced form it guards against", () => {
    expect(() =>
      parseTsx("export const x = (<>{input.a ? {Foo()} : null}</>);"),
    ).toThrow();
  });
});

async function renderWhole(
  source: string,
  props: Record<string, unknown>,
): Promise<string> {
  const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const scratch = mkdtempSync(join(tmpdir(), "mx-hono-slot-"));
  try {
    symlinkSync(
      dirname(dirname(dirname(require.resolve("hono")))),
      join(scratch, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" },
      }),
    );
    const entry = join(scratch, "page.tsx");
    writeFileSync(entry, compileHonoMx(source, join(scratch, "page.mx")).code);
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => Child;
    };
    return String(await jsx(mod.default, props).toString());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("hono: the bare define call renders the HTML the HTML target renders for the same source", () => {
  const RENDER_CASES: Array<[string, string, Record<string, unknown>, string]> =
    [
      [
        "an <if> that holds",
        `${DEFINE}<if=input.a><Foo/></if>`,
        { a: true },
        "<p>inner</p>",
      ],
      [
        "an <if> that does not hold",
        `${DEFINE}<if=input.a><Foo/></if>`,
        { a: false },
        "",
      ],
      [
        "an <else> arm",
        `${DEFINE}<if=input.a><i>a</i></if><else><Foo/></else>`,
        { a: false },
        "<p>inner</p>",
      ],
      [
        "an <else-if> arm",
        `${DEFINE}<if=input.a><i>a</i></if><else-if=input.b><Foo/></else-if>`,
        { a: false, b: true },
        "<p>inner</p>",
      ],
      [
        "a nested <if>",
        `${DEFINE}<if=input.a><if=input.b><Foo/></if></if>`,
        { a: true, b: true },
        "<p>inner</p>",
      ],
      [
        "a call with attributes",
        `${CALL_ROW}<ul><if=input.a><Row n=3/></if></ul>`,
        { a: true },
        "<ul><li>3</li></ul>",
      ],
      [
        "an <@item|x|> body that is a define call (an arrow, not a block)",
        `${DEFINE}<define/Bar|{ item }|><section><${"$"}{item}(1)/></section></define>\n<Bar><@item|x|><Foo/></@item></Bar>`,
        {},
        "<section><p>inner</p></section>",
      ],
      [
        "an <@item> body that is a define call",
        `${DEFINE}<define/Bar|{ item }|><section><${"$"}{item}/></section></define>\n<Bar><@item><Foo/></@item></Bar>`,
        {},
        "<section><p>inner</p></section>",
      ],
      [
        "a <@catch|e|> body that is a define call",
        `${DEFINE}<try><b>${"$"}{input.f()}</b><@catch|e|><Foo/></@catch></try>`,
        {
          f: () => {
            throw new Error("boom");
          },
        },
        "<p>inner</p>",
      ],
      [
        "a render-prop body that is a define call",
        `${DEFINE}<define/Bar|{ content }|><div><${"$"}{content}(7)/></div></define>\n<Bar|i|><Foo/></Bar>`,
        {},
        "<div><p>inner</p></div>",
      ],
    ];

  it.each(RENDER_CASES)("%s", async (_name, source, props, html) => {
    expect(await renderWhole(source, props)).toBe(html);
  });
});
