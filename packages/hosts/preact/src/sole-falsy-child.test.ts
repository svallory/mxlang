// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A fragment whose only child is one value, `<>{x}</>`, loses that child on
 * Hono when it is falsy but visible: `hono/jsx`'s `Fragment` keeps an array
 * of children whole and otherwise renders `children ? [children] : []`, so a
 * lone `0` or `NaN` renders nothing (Preact and React render them). The
 * emitter therefore writes `{null}` after a lone value child, which is
 * invisible on every JSX host and turns the children into an array. This is
 * the rule `#attributeTagRenderable` already followed for attribute-tag
 * bodies.
 *
 * The places a lone value child sits in a fragment are the component's own
 * `return (<>…</>)`, a `<for>` row, the `content` function of a define call
 * or dynamic tag, a `<define>` body and a `<try>` body. The strings below
 * are exact; each rendered string is what the html target renders for the
 * same source (the oracle fixtures `if-sole-zero`, `for-sole-zero` and
 * `define-call-sole-zero` hold the same shapes against Marko's output). Every
 * emitted module also goes through `@babel/parser` with the `jsx` and
 * `typescript` plugins.
 */
import { parse } from "@babel/parser";
import { type FunctionComponent, h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const D = "$";
const DEF = `<define/Box|{ content }|><b><${D}{content}/></b></define>\n`;
const EACH = `<define/Each|{ content }|><i><${D}{content}(0)/></i></define>\n`;
const X = '<const/X="em"/>\n';

const compile = (source: string): string =>
  compilePreactMx(source, "/fixtures/zero.mx").code;

/** The one line of the module that matches `pattern`. */
function line(code: string, pattern: RegExp): string {
  const lines = code.split("\n").filter((text) => pattern.test(text));
  expect(lines).toHaveLength(1);
  return (lines[0] as string).trim();
}

/** What the component returns: the one `return (<>…</>);` of the module. */
const returned = (code: string): string => line(code, /^ {2}return \(<.*\);$/);

function parseTsx(code: string): void {
  parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
}

const LIST = "((mxList) => mxList ? [...mxList] : [])";
const ROW = (key: string, body: string): string =>
  `<__mxFragment key={${key}}>${body}</__mxFragment>`;

// [name, source, the component's return statement]
const CASES: Array<[string, string, string]> = [
  [
    "an <if> with a lone placeholder",
    `<if=input.a>${D}{input.x}</if>`,
    "return (<>{input.a ? input.x : null}{null}</>);",
  ],
  [
    "an <if> with a lone placeholder, the file ending in a newline",
    `<if=input.a>${D}{input.x}</if>\n`,
    "return (<>{input.a ? input.x : null}{null}</>);",
  ],
  [
    "an <if> and an <else> with lone placeholders",
    `<if=input.a>${D}{input.x}</if><else>${D}{input.y}</else>`,
    "return (<>{input.a ? input.x : input.y}{null}</>);",
  ],
  [
    "an <if> and an <else-if> with lone placeholders",
    `<if=input.a>${D}{input.x}</if><else-if=input.b>${D}{input.y}</else-if>`,
    "return (<>{input.a ? input.x : input.b ? input.y : null}{null}</>);",
  ],
  [
    "an <if> with a lone placeholder and an <else> with an element",
    `<if=input.a>${D}{input.x}</if><else><b>y</b></else>`,
    "return (<>{input.a ? input.x : <b>y</b>}{null}</>);",
  ],
  [
    "an <if> whose only child is an <if> with a lone placeholder",
    `<if=input.a><if=input.b>${D}{input.x}</if></if>`,
    "return (<>{input.a ? input.b ? input.x : null : null}{null}</>);",
  ],
  [
    "<for of> with a lone placeholder",
    `<for|i| of=input.l>${D}{i}</for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "{i}{null}")})}</>);`,
  ],
  [
    "<for in> with a lone placeholder",
    `<for|k, v| in=input.o>${D}{v}</for>`,
    `return (<>{Object.entries(input.o ?? {}).map(([k, v]) => ${ROW("k", "{v}{null}")})}</>);`,
  ],
  [
    "<for from to> with a lone placeholder",
    `<for|n| from=0 to=1>${D}{n}</for>`,
    `return (<>{Array.from({ length: Math.max(0, (1) - (0) + 1) }, (__mxUnused, __mxIndex) => (0) + __mxIndex).map((n) => ${ROW("n", "{n}{null}")})}</>);`,
  ],
  [
    "a <for> with a lone placeholder as the only child of an <if>",
    `<if=input.a><for|i| of=input.l>${D}{i}</for></if>`,
    `return (<>{input.a ? ${LIST}(input.l).map((i) => ${ROW("i", "{i}{null}")}) : null}</>);`,
  ],
  [
    "a <for> inside a <for>: only the inner row is closed",
    `<for|a| of=input.l><for|b| of=a>${D}{b}</for></for>`,
    `return (<>{${LIST}(input.l).map((a) => ${ROW("a", `{${LIST}(a).map((b) => ${ROW("b", "{b}{null}")})}`)})}</>);`,
  ],
  [
    "a define call with a lone placeholder body",
    `${DEF}<Box>${D}{input.x}</Box>`,
    "return (<>{Box({ content: () => <>{input.x}{null}</> })}</>);",
  ],
  [
    "a define call with tag params and a lone placeholder body",
    `${EACH}<Each|n|>${D}{n}</Each>`,
    "return (<>{Each({ content: ((n) => <>{n}{null}</>) as (...args: any[]) => any })}</>);",
  ],
  [
    "a dynamic tag with a lone placeholder body",
    `${X}<${D}{X}>${D}{input.x}</>`,
    "return (<>{__mxDynamic(X, { content: () => <>{input.x}{null}</> })}</>);",
  ],
  [
    "a dynamic tag with arguments and a lone placeholder body",
    `<const/X=input.t/>\n<${D}{X}(0)>${D}{input.x}</>`,
    "return (<>{__mxDynamic(X, [0, { content: () => <>{input.x}{null}</> }], () => <>{input.x}{null}</>)}</>);",
  ],
  [
    "a <try> with a lone placeholder body",
    `<try>${D}{input.x}<@catch|e|>${D}{e.message}</@catch></try>`,
    "return (<><__mxErrorBoundary fallback={(e) => <>{e.message}{null}</>}>{() => (<>{input.x}{null}</>)}</__mxErrorBoundary></>);",
  ],
  [
    "a <try> with a placeholder and a lone placeholder body",
    `<try><@placeholder>wait</@placeholder>${D}{input.x}</try>`,
    "return (<><__mxSuspense fallback={<>wait</>}>{input.x}{null}</__mxSuspense></>);",
  ],
  [
    "a <try> whose <@catch> body is a lone placeholder",
    `<try><div>ok</div><@catch|e|>${D}{input.x}</@catch></try>`,
    "return (<><__mxErrorBoundary fallback={(e) => <>{input.x}{null}</>}>{() => (<><div>ok</div></>)}</__mxErrorBoundary></>);",
  ],
  [
    "a <try> whose <@catch> body is an <if> with a lone placeholder",
    `<try><div>ok</div><@catch|e|><if=input.a>${D}{input.x}</if></@catch></try>`,
    "return (<><__mxErrorBoundary fallback={(e) => <>{input.a ? input.x : null}{null}</>}>{() => (<><div>ok</div></>)}</__mxErrorBoundary></>);",
  ],
];

// The shapes whose fragment has another child, is not a fragment, or holds
// something that is never a falsy scalar. They get no `{null}`.
const UNCHANGED: Array<[string, string, string]> = [
  [
    "a placeholder with a sibling in the component",
    `<if=input.a>${D}{input.x}</if>-`,
    "return (<>{input.a ? input.x : null}-</>);",
  ],
  [
    "a lone <if> inside an element",
    `<div><if=input.a>${D}{input.x}</if></div>`,
    "return (<><div>{input.a ? input.x : null}</div></>);",
  ],
  [
    "a lone placeholder inside an element",
    `<div>${D}{input.x}</div>`,
    "return (<><div>{input.x}</div></>);",
  ],
  [
    "two placeholders in an <if>",
    `<if=input.a>${D}{input.x}${D}{input.y}</if>`,
    "return (<>{input.a ? <>{input.x}{input.y}</> : null}</>);",
  ],
  [
    "an <if> whose branches are elements",
    `<if=input.a><b>x</b></if><else><i>y</i></else>`,
    "return (<>{input.a ? <b>x</b> : <i>y</i>}</>);",
  ],
  [
    "<for> rows that are elements",
    `<for|i| of=input.l><li>${D}{i}</li></for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "<li>{i}</li>")})}</>);`,
  ],
  [
    "a define call with an element body",
    `${DEF}<Box><i>${D}{input.x}</i></Box>`,
    "return (<>{Box({ content: () => <><i>{input.x}</i></> })}</>);",
  ],
  [
    "an <if> with an empty body",
    "<if=input.a></if>",
    "return (<>{input.a ? null : null}</>);",
  ],
  [
    "a <try> whose <@catch> body is an element",
    `<try><div>ok</div><@catch|e|><b>${D}{input.x}</b></@catch></try>`,
    "return (<><__mxErrorBoundary fallback={(e) => <b>{input.x}</b>}>{() => (<><div>ok</div></>)}</__mxErrorBoundary></>);",
  ],
];

describe("preact: a lone value child is closed with a null child", () => {
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

  it("closes a <define> body that is a lone placeholder", () => {
    const code = compile(`<define/Z|n|>${D}{n}</define>\n<Z(0)/>`);
    expect(line(code, /^ {2}const Z = /)).toBe(
      "const Z = (n) => (<>{n}{null}</>);",
    );
    expect(returned(code)).toBe("return (<>{Z(0)}</>);");
    expect(() => parseTsx(code)).not.toThrow();
  });

  it("closes the body of a returning unit that is a lone placeholder", () => {
    const code = compile(`<return=input.x/>\n<if=input.a>${D}{input.y}</if>`);
    expect(code).toContain(
      "output: (<>{input.a ? input.y : null}{null}</>) };",
    );
    expect(() => parseTsx(code)).not.toThrow();
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
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-zero-"));
  try {
    symlinkSync(
      dirname(dirname(require.resolve("preact/package.json"))),
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
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
      }),
    );
    const entry = join(scratch, "page.tsx");
    writeFileSync(
      entry,
      compilePreactMx(source, join(scratch, "page.mx")).code,
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FunctionComponent<Record<string, unknown>>;
    };
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    return render(h(mod.default, props));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// [name, source, props, what the html target renders for the same source]
const RENDER_CASES: Array<[string, string, Record<string, unknown>, string]> = [
  ["<if> with 0", `<if=input.a>${D}{input.x}</if>`, { a: true, x: 0 }, "0"],
  [
    "<if> with 0, the file ending in a newline",
    `<if=input.a>${D}{input.x}</if>\n`,
    { a: true, x: 0 },
    "0",
  ],
  [
    "<if> with NaN",
    `<if=input.a>${D}{input.x}</if>`,
    { a: true, x: Number.NaN },
    "NaN",
  ],
  [
    "<if> with an empty string",
    `<if=input.a>${D}{input.x}</if>`,
    { a: true, x: "" },
    "",
  ],
  [
    "<if> with null",
    `<if=input.a>${D}{input.x}</if>`,
    { a: true, x: null },
    "",
  ],
  [
    "<if> with a false condition",
    `<if=input.a>${D}{input.x}</if>`,
    { a: false, x: 0 },
    "",
  ],
  [
    "<else> with 0",
    `<if=input.a>${D}{input.x}</if><else>${D}{input.y}</else>`,
    { a: false, y: 0 },
    "0",
  ],
  [
    "<else-if> with 0",
    `<if=input.a>${D}{input.x}</if><else-if=input.b>${D}{input.y}</else-if>`,
    { a: false, b: true, y: 0 },
    "0",
  ],
  [
    "an <if> in an <if> with 0",
    `<if=input.a><if=input.b>${D}{input.x}</if></if>`,
    { a: true, b: true, x: 0 },
    "0",
  ],
  ["<for of> with 0", `<for|i| of=input.l>${D}{i}</for>`, { l: [0, 1] }, "01"],
  [
    "<for of> over 0, an empty string and null",
    `<for|i| of=input.l>${D}{i}</for>`,
    { l: ["", null, 0] },
    "0",
  ],
  ["<for from to> with 0", `<for|n| from=0 to=1>${D}{n}</for>`, {}, "01"],
  [
    "<for in> with 0",
    `<for|k, v| in=input.o>${D}{v}</for>`,
    { o: { a: 0, b: 1 } },
    "01",
  ],
  [
    "a <for> in an <if> with 0",
    `<if=input.a><for|i| of=input.l>${D}{i}</for></if>`,
    { a: true, l: [0, 1] },
    "01",
  ],
  [
    "a <for> in a <for> with 0",
    `<for|a| of=input.l><for|b| of=a>${D}{b}</for></for>`,
    { l: [[0], [1, 0]] },
    "010",
  ],
  [
    "a define call with a 0 body",
    `${DEF}<Box>${D}{input.x}</Box>`,
    { x: 0 },
    "<b>0</b>",
  ],
  [
    "a define call with an empty string body",
    `${DEF}<Box>${D}{input.x}</Box>`,
    { x: "" },
    "<b></b>",
  ],
  [
    "a define call with a null body",
    `${DEF}<Box>${D}{input.x}</Box>`,
    { x: null },
    "<b></b>",
  ],
  [
    "a define call with tag params and a 0 argument",
    `${EACH}<Each|n|>${D}{n}</Each>`,
    {},
    "<i>0</i>",
  ],
  [
    "a define call with arguments and a 0 body",
    `<define/Row|n, { content }|><b>${D}{n}<${D}{content}/></b></define>\n<Row(0)>${D}{input.x}</Row>`,
    { x: 0 },
    "<b>00</b>",
  ],
  [
    "a dynamic tag with a 0 body",
    `${X}<${D}{X}>${D}{input.x}</>`,
    { x: 0 },
    "<em>0</em>",
  ],
  [
    "a dynamic tag with an empty string body",
    `${X}<${D}{X}>${D}{input.x}</>`,
    { x: "" },
    "<em></em>",
  ],
  [
    "a dynamic tag with a null body",
    `${X}<${D}{X}>${D}{input.x}</>`,
    { x: null },
    "<em></em>",
  ],
  [
    "a dynamic tag with arguments and a 0 body",
    `<const/X=input.t/>\n<${D}{X}(0)>${D}{input.x}</>`,
    { t: "em", x: 0 },
    "<em>0</em>",
  ],
  [
    "a <define> body that is a 0 argument",
    `<define/Z|n|>${D}{n}</define>\n<Z(0)/>`,
    {},
    "0",
  ],
  [
    "a <try> with a 0 body",
    `<try>${D}{input.x}<@catch|e|>${D}{e.message}</@catch></try>`,
    { x: 0 },
    "0",
  ],
  [
    "a <try> with a placeholder and a 0 body",
    `<try><@placeholder>wait</@placeholder>${D}{input.x}</try>`,
    { x: 0 },
    "0",
  ],
  // The shapes that already rendered the zero.
  [
    "a lone <if> inside an element",
    `<div><if=input.a>${D}{input.x}</if></div>`,
    { a: true, x: 0 },
    "<div>0</div>",
  ],
  [
    "an <if> with a sibling",
    `<if=input.a>${D}{input.x}</if>-`,
    { a: true, x: 0 },
    "0-",
  ],
  [
    "<for> rows that are elements",
    `<for|i| of=input.l><li>${D}{i}</li></for>`,
    { l: [0, 1] },
    "<li>0</li><li>1</li>",
  ],
];

describe("preact: a lone 0 renders what the html target renders", () => {
  it.each(RENDER_CASES)("%s", async (_name, source, props, html) => {
    expect(await renderWhole(source, props)).toBe(html);
  });

  // The html target prints `false` (Marko's rule); a JSX host never renders a
  // boolean, for a placeholder anywhere, so a lone `false` is empty on all
  // three JSX hosts alike. This pins that the closing child leaves it so.
  it("renders a lone false as nothing, as every JSX child does", async () => {
    expect(
      await renderWhole(`<if=input.a>${D}{input.x}</if>`, {
        a: true,
        x: false,
      }),
    ).toBe("");
    expect(
      await renderWhole(`<for|i| of=input.l>${D}{i}</for>`, {
        l: [false, 1],
      }),
    ).toBe("1");
  });
});
