// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A body whose only child is a `${expr}` placeholder, or that has no
 * children, sits between JSX tags: a `<for>` row (`<__mxFragment>…</__mxFragment>`)
 * and the `content` function of a `<define>` call or a dynamic tag
 * (`() => <>…</>`). It used to be written as the bare expression, which JSX
 * reads as text, so `<for|i| of=l>${i}</for>` emitted `…>i</__mxFragment>`
 * and rendered the word `i` once per row, and an empty body emitted the word
 * `null`. A lone placeholder there is now a JSX expression child `{i}`, and an
 * empty body is empty.
 *
 * The rendered strings below are what the html target renders for the same
 * source (the oracle fixtures `for-sole-placeholder` and
 * `define-call-sole-placeholder` hold the same shapes against Marko's
 * output). Every emitted module also goes through `@babel/parser` with the
 * `jsx` and `typescript` plugins.
 */
import { parse } from "@babel/parser";
import { type FunctionComponent, h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const D = "$";
const DEF = `<define/Box|{ content }|><b><${D}{content}/></b></define>\n`;
const DEF_ARGS = `<define/Box|{ content }|><b><${D}{content}(5)/></b></define>\n`;
const IMP = 'import Bar from "./bar.mx"\n';

const compile = (source: string): string =>
  compilePreactMx(source, "/fixtures/sole.mx").code;

/** What the component returns: the one `return (<>…</>);` of the module. */
function returned(code: string): string {
  const lines = code
    .split("\n")
    .filter((line) => /^ {2}return \(<.*\);$/.test(line));
  expect(lines).toHaveLength(1);
  return (lines[0] as string).trim();
}

function parseTsx(code: string): void {
  parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
}

const LIST = "((mxList) => mxList ? [...mxList] : [])";
const ROW = (key: string, body: string): string =>
  `<__mxFragment key={${key}}>${body}</__mxFragment>`;

// [name, source, the component's return statement]
const CASES: Array<[string, string, string]> = [
  [
    "<for of> with a lone placeholder",
    `<for|i| of=input.l>${D}{i}</for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "{i}")})}</>);`,
  ],
  [
    "<for of> with an index param, the placeholder naming the index",
    `<for|i, idx| of=input.l>${D}{idx}</for>`,
    `return (<>{${LIST}(input.l).map((i, idx) => ${ROW("i", "{idx}")})}</>);`,
  ],
  [
    "<for of> with a placeholder that is an expression",
    `<for|i| of=input.l>${D}{i.name}</for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "{i.name}")})}</>);`,
  ],
  [
    "<for of> with an empty body",
    "<for|i| of=input.l></for>",
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "")})}</>);`,
  ],
  [
    "<for of> with a comment-only body",
    "<for|i| of=input.l><!-- c --></for>",
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "")})}</>);`,
  ],
  [
    "<for of> with a comment and a lone placeholder",
    `<for|i| of=input.l><!-- c -->${D}{i}</for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "{i}")})}</>);`,
  ],
  [
    "<for in> with a lone placeholder",
    `<for|k, v| in=input.o>${D}{v}</for>`,
    `return (<>{Object.entries(input.o ?? {}).map(([k, v]) => ${ROW("k", "{v}")})}</>);`,
  ],
  [
    "<for in> with an empty body",
    "<for|k| in=input.o></for>",
    `return (<>{Object.entries(input.o ?? {}).map(([k, value]) => ${ROW("k", "")})}</>);`,
  ],
  [
    "<for from to> with a lone placeholder",
    `<for|n| from=1 to=3>${D}{n}</for>`,
    `return (<>{Array.from({ length: Math.max(0, (3) - (1) + 1) }, (__mxUnused, __mxIndex) => (1) + __mxIndex).map((n) => ${ROW("n", "{n}")})}</>);`,
  ],
  [
    "<for from until step> with a lone placeholder",
    `<for|n| from=0 until=6 step=2>${D}{n}</for>`,
    `return (<>{Array.from({ length: Math.max(0, Math.ceil(((6) - (0)) / (2))) }, (__mxUnused, __mxIndex) => (0) + __mxIndex * (2)).map((n) => ${ROW("n", "{n}")})}</>);`,
  ],
  [
    "<for from to> with an empty body",
    "<for|n| from=1 to=3></for>",
    `return (<>{Array.from({ length: Math.max(0, (3) - (1) + 1) }, (__mxUnused, __mxIndex) => (1) + __mxIndex).map((n) => ${ROW("n", "")})}</>);`,
  ],
  [
    "a <for> whose only child is a <for> with a lone placeholder",
    `<for|a| of=input.l><for|b| of=a>${D}{b}</for></for>`,
    `return (<>{${LIST}(input.l).map((a) => ${ROW("a", `{${LIST}(a).map((b) => ${ROW("b", "{b}")})}`)})}</>);`,
  ],
  [
    "a <for> with a lone placeholder as the only child of an <if>",
    `<if=input.a><for|i| of=input.l>${D}{i}</for></if>`,
    `return (<>{input.a ? ${LIST}(input.l).map((i) => ${ROW("i", "{i}")}) : null}</>);`,
  ],
  [
    "a <for> with a lone placeholder inside an element",
    `<ul><for|i| of=input.l>${D}{i}</for></ul>`,
    `return (<><ul>{${LIST}(input.l).map((i) => ${ROW("i", "{i}")})}</ul></>);`,
  ],
  [
    "a define call with a lone placeholder body",
    `${DEF}<Box>${D}{input.y}</Box>`,
    "return (<>{Box({ content: () => <>{input.y}</> })}</>);",
  ],
  [
    "a define call with a lone placeholder body and tag params",
    `${DEF_ARGS}<Box|n|>${D}{n}</Box>`,
    "return (<>{Box({ content: ((n) => <>{n}</>) as (...args: any[]) => any })}</>);",
  ],
  [
    "a define call with tag params and a comment-only body (no content)",
    `${DEF_ARGS}<Box|n|><!-- c --></Box>`,
    "return (<>{Box({  })}</>);",
  ],
  [
    "a define call with arguments and a lone placeholder body",
    `<define/Row|n, { content }|><b><${D}{content}/></b></define>\n<Row(1)>${D}{input.y}</Row>`,
    "return (<>{Row(1, { content: () => <>{input.y}</> })}</>);",
  ],
  [
    "a define call with a lone placeholder body in an <if>",
    `${DEF}<if=input.a><Box>${D}{input.y}</Box></if>`,
    "return (<>{input.a ? Box({ content: () => <>{input.y}</> }) : null}</>);",
  ],
  [
    "a dynamic tag with a lone placeholder body",
    `<const/X="em"/>\n<${D}{X}>${D}{input.y}</>`,
    "return (<>{__mxDynamic(X, { content: () => <>{input.y}</> })}</>);",
  ],
  [
    "a dynamic tag with a lone placeholder body and tag params",
    `<const/X=input.x/>\n<${D}{X}|n|>${D}{n}</>`,
    "return (<>{__mxDynamic(X, { content: ((n) => <>{n}</>) as (...args: any[]) => any }, undefined, true)}</>);",
  ],
  [
    "a dynamic tag with arguments and a lone placeholder body",
    `<const/X=input.x/>\n<${D}{X}(1)>${D}{input.y}</>`,
    "return (<>{__mxDynamic(X, [1, { content: () => <>{input.y}</> }], () => <>{input.y}</>)}</>);",
  ],
  [
    "a dynamic tag with a lone placeholder body in an <if>",
    `<const/X=input.x/>\n<if=input.a><${D}{X}>${D}{input.y}</></if>`,
    "return (<>{input.a ? __mxDynamic(X, { content: () => <>{input.y}</> }) : null}</>);",
  ],
  [
    "a dynamic tag with an empty body (no content)",
    `<const/X=input.x/>\n<${D}{X}></>`,
    "return (<>{__mxDynamic(X, {  })}</>);",
  ],
];

// Shapes that were already right and must stay as they are: another child
// next to the placeholder, an element around it, and the expression slots
// (a ternary arm, a render-prop arrow body, an imported component's children)
// where a lone placeholder is the bare expression.
const UNCHANGED: Array<[string, string, string]> = [
  [
    "a placeholder next to text in a <for>",
    `<for|i| of=input.l>${D}{i} </for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "<>{i} </>")})}</>);`,
  ],
  [
    "a placeholder inside an element in a <for>",
    `<for|i| of=input.l><b>${D}{i}</b></for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "<b>{i}</b>")})}</>);`,
  ],
  [
    "two placeholders in a <for>",
    `<for|i| of=input.l>${D}{i}${D}{i}</for>`,
    `return (<>{${LIST}(input.l).map((i) => ${ROW("i", "<>{i}{i}</>")})}</>);`,
  ],
  [
    "a placeholder next to text in a define call body",
    `${DEF}<Box>${D}{input.y} x</Box>`,
    "return (<>{Box({ content: () => <><>{input.y} x</></> })}</>);",
  ],
  [
    "a lone placeholder as the only child of an <if> (an expression slot)",
    `<if=input.a>${D}{input.x}</if>`,
    "return (<>{input.a ? input.x : null}</>);",
  ],
  [
    "an empty <if> (an expression slot)",
    "<if=input.a></if>",
    "return (<>{input.a ? null : null}</>);",
  ],
  [
    "a lone placeholder in an imported component's children",
    `${IMP}<Bar>${D}{input.y}</Bar>`,
    "return (<><Bar>{input.y}</Bar></>);",
  ],
  [
    "a lone placeholder as a render-prop arrow body (an expression slot)",
    `${IMP}<Bar|n|>${D}{n}</Bar>`,
    "return (<><Bar>{(n) => n}</Bar></>);",
  ],
  [
    "an empty render-prop body",
    `${IMP}<Bar|n|></Bar>`,
    "return (<><Bar /></>);",
  ],
];

describe("preact: a lone placeholder or an empty body between JSX tags", () => {
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
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-sole-"));
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

describe("preact: a lone placeholder or an empty body renders what the html target renders", () => {
  const RENDER_CASES: Array<[string, string, Record<string, unknown>, string]> =
    [
      ["<for of>", `<for|i| of=input.l>${D}{i}</for>`, { l: [1, 2] }, "12"],
      [
        "<for of> over text that needs escaping",
        `<for|i| of=input.l>${D}{i}</for>`,
        { l: ["a&b"] },
        "a&amp;b",
      ],
      [
        "<for of> inside an element",
        `<ul><for|i| of=input.l>${D}{i}</for></ul>`,
        { l: [1, 2] },
        "<ul>12</ul>",
      ],
      [
        "<for of> with an index param",
        `<for|i, idx| of=input.l>${D}{i}</for>`,
        { l: ["a", "b", "c"] },
        "abc",
      ],
      [
        "<for of> with an empty body",
        "<for|i| of=input.l></for>",
        { l: [1, 2] },
        "",
      ],
      [
        "<for of> with a comment-only body",
        "<for|i| of=input.l><!-- c --></for>",
        { l: [1, 2] },
        "",
      ],
      [
        "<for in>",
        `<for|k, v| in=input.o>${D}{v}</for>`,
        { o: { a: 1, b: 2 } },
        "12",
      ],
      [
        "<for in> with an empty body",
        "<for|k| in=input.o></for>",
        { o: { a: 1 } },
        "",
      ],
      ["<for from to>", `<for|n| from=1 to=3>${D}{n}</for>`, {}, "123"],
      [
        "<for from to> with an empty body",
        "<for|n| from=1 to=3></for>",
        {},
        "",
      ],
      [
        "a <for> inside a <for>",
        `<for|a| of=input.l><for|b| of=a>${D}{b}</for></for>`,
        { l: [[1, 2], [3]] },
        "123",
      ],
      [
        "a <for> in an <if> branch",
        `<if=input.a><for|i| of=input.l>${D}{i}</for></if><else>none</else>`,
        { a: true, l: [1, 2] },
        "12",
      ],
      [
        "a define call with a lone placeholder body",
        `${DEF}<Box>${D}{input.y}</Box>`,
        { y: "Y" },
        "<b>Y</b>",
      ],
      [
        "a define call whose placeholder needs escaping",
        `${DEF}<Box>${D}{input.y}</Box>`,
        { y: "a&b" },
        "<b>a&amp;b</b>",
      ],
      [
        "a define call with tag params",
        `${DEF_ARGS}<Box|n|>${D}{n}</Box>`,
        {},
        "<b>5</b>",
      ],
      ["a define call with an empty body", `${DEF}<Box></Box>`, {}, "<b></b>"],
      [
        "a define call with tag params and an empty body",
        `${DEF_ARGS}<Box|n|></Box>`,
        {},
        "<b></b>",
      ],
      [
        "a define call with arguments",
        `<define/Row|n, { content }|><b>${D}{n}<${D}{content}/></b></define>\n<Row(1)>${D}{input.y}</Row>`,
        { y: "Y" },
        "<b>1Y</b>",
      ],
      [
        "a dynamic tag with a lone placeholder body",
        `<const/X="em"/>\n<${D}{X}>${D}{input.y}</>`,
        { y: "Y" },
        "<em>Y</em>",
      ],
      [
        "a dynamic tag with an empty body",
        `<const/X="em"/>\n<${D}{X}></>`,
        {},
        "<em></em>",
      ],
      [
        "a dynamic tag, in an <if>, with a lone placeholder body",
        `<const/X="em"/>\n<if=input.a><${D}{X}>${D}{input.y}</></if>`,
        { a: true, y: "Y" },
        "<em>Y</em>",
      ],
    ];

  it.each(RENDER_CASES)("%s", async (_name, source, props, html) => {
    expect(await renderWhole(source, props)).toBe(html);
  });

  // hono/jsx's Fragment drops a sole falsy child, `0` included, so a lone
  // `${0}` in a body renders nothing there (the same drop `<if=c>${0}</if>`
  // has always had); the other two hosts render the zero.
  it("renders a zero value", async () => {
    expect(
      await renderWhole(`<for|i| of=input.l>${D}{i}</for>`, { l: [0, 1] }),
    ).toBe("01");
  });
});
