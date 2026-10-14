// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * The body of a tag that resolves to a host component reaches the component
 * exactly as hand-written JSX would pass it.
 *
 * `import { Fragment } from "preact"` then `<Fragment>${input.count}</Fragment>`
 * used to emit `content: () => <>{input.count}{null}</>`: a fragment of MX's
 * own, with a `{null}` sibling, between the author and the component. On Hono
 * that sibling made the lone `0` visible where `<Fragment>{0}</Fragment>`,
 * written by hand, renders nothing, and every host handed the component a
 * fragment element where JSX hands it the bare value, the string, the element
 * or the array of children.
 *
 * The rule: a call whose target is a binding the module imports from a module
 * that is not an MX or Marko template (core marks it with
 * `valueImportBinding`) gets a `content` function that returns what
 * `<Tag>…</Tag>` would pass as `children`. MX's own fragments (an `<if>`
 * branch, a `<for>` row, a `<define>` call's body, an authored dynamic tag, a
 * positional call, an attribute-tag body) are not hand-written JSX and keep
 * the `{null}` sibling that `sole-falsy-child.test.ts` pins.
 *
 * The first half pins the emitted code (every module also goes through
 * `@babel/parser` with the `jsx` and `typescript` plugins). The second half
 * renders each MX source and the JSX written by hand on this host and checks
 * that the markup and what the component received are the same.
 */
import { parse } from "@babel/parser";
import { h } from "preact";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const D = "$";
const BOX = 'import { Box } from "./box.tsx";\n';
const FRAGMENT = 'import { Fragment } from "preact";\n';

const compile = (source: string): string =>
  compilePreactMx(source, "/fixtures/host-body.mx").code;

/** What the component returns: the one `return (<>…</>);` of the module. */
function returned(code: string): string {
  const lines = code
    .split("\n")
    .filter((text) => /^ {2}return \(<.*\);$/.test(text));
  expect(lines).toHaveLength(1);
  return (lines[0] as string).trim();
}

function parseTsx(code: string): void {
  parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
}

const callOf = (tag: string, content: string, props = ""): string =>
  `return (<>{__mxDynamic(${tag}, { ${props}content: ${content} })}</>);`;
const callParams = (content: string): string =>
  `return (<>{__mxDynamic(Box, { content: ${content} as (...args: any[]) => any }, undefined, true)}</>);`;

// [name, source, the component's return statement]
const EMITTED: Array<[string, string, string]> = [
  [
    "a host module's Fragment with a lone placeholder",
    `${FRAGMENT}<Fragment>${D}{input.count}</Fragment>`,
    callOf("Fragment", "() => input.count"),
  ],
  [
    "a host component with a lone placeholder",
    `${BOX}<Box>${D}{input.count}</Box>`,
    callOf("Box", "() => input.count"),
  ],
  [
    "a host component with a lone placeholder and an attribute",
    `${BOX}<Box a=1>${D}{input.count}</Box>`,
    callOf("Box", "() => input.count", '"a": 1, '),
  ],
  [
    "a lone placeholder padded with newlines",
    `${BOX}<Box>\n  ${D}{input.count}\n</Box>`,
    callOf("Box", "() => input.count"),
  ],
  [
    "a lone placeholder beside a comment",
    `${BOX}<Box><!-- c -->${D}{input.count}</Box>`,
    callOf("Box", "() => input.count"),
  ],
  [
    "a lone placeholder holding a ternary",
    `${BOX}<Box>${D}{input.a ? 1 : 0}</Box>`,
    callOf("Box", "() => input.a ? 1 : 0"),
  ],
  [
    "a lone placeholder holding an object literal",
    `${BOX}<Box>${D}{{ a: 1 }}</Box>`,
    callOf("Box", "() => ({ a: 1 })"),
  ],
  [
    "a lone placeholder holding a sequence",
    `${BOX}<Box>${D}{(1, input.count)}</Box>`,
    callOf("Box", "() => (1, input.count)"),
  ],
  [
    "text",
    `${BOX}<Box>hi</Box>`,
    callOf("Box", "() => (<>hi</> as any).props.children"),
  ],
  [
    "text around a placeholder",
    `${BOX}<Box>a ${D}{input.count} b</Box>`,
    callOf("Box", "() => (<>a {input.count} b</> as any).props.children"),
  ],
  ["an element", `${BOX}<Box><b>x</b></Box>`, callOf("Box", "() => <b>x</b>")],
  [
    "an element and a placeholder",
    `${BOX}<Box><b>x</b>${D}{input.count}</Box>`,
    callOf("Box", "() => (<><b>x</b>{input.count}</> as any).props.children"),
  ],
  [
    "an <if> whose branch is a lone placeholder",
    `${BOX}<Box><if=input.a>${D}{input.x}</if></Box>`,
    callOf("Box", "() => input.a ? input.x : null"),
  ],
  [
    "an <if> with an <else> element: the branch is MX's own",
    `${BOX}<Box><if=input.a>${D}{input.x}</if><else><b>y</b></else></Box>`,
    callOf("Box", "() => input.a ? input.x : <b>y</b>"),
  ],
  [
    "a <for>: its rows are MX's own fragments and keep {null}",
    `${BOX}<Box><for|i| of=input.l>${D}{i}</for></Box>`,
    callOf(
      "Box",
      "() => ((mxList) => mxList ? [...mxList] : [])(input.l).map((i) => <__mxFragment key={i}>{i}{null}</__mxFragment>)",
    ),
  ],
  [
    "a host component inside a host component",
    `${BOX}<Box><Box>${D}{input.count}</Box></Box>`,
    callOf("Box", "() => __mxDynamic(Box, { content: () => input.count })"),
  ],
  [
    "a host component with an attribute tag: the tag's body is MX's own",
    `${BOX}<Box><@a>${D}{input.count}</@a>${D}{input.count}</Box>`,
    callOf("Box", "() => input.count", '"a": <>{input.count}{null}</>, '),
  ],
  [
    "tag params with a lone placeholder: the render prop returns it bare",
    `${BOX}<Box|n|>${D}{n}</Box>`,
    callParams("((n) => n)"),
  ],
  [
    "tag params with an object literal",
    `${BOX}<Box|n|>${D}{{ a: n }}</Box>`,
    callParams("((n) => ({ a: n }))"),
  ],
  [
    "tag params with an element",
    `${BOX}<Box|n|><b>${D}{n}</b></Box>`,
    callParams("((n) => <b>{n}</b>)"),
  ],
  [
    "tag params with text around a placeholder",
    `${BOX}<Box|n|>a ${D}{n}</Box>`,
    callParams("((n) => <>a {n}</>)"),
  ],
];

// MX's own fragments are not hand-written JSX: the sibling stays.
const MX_OWN: Array<[string, string, string]> = [
  [
    "an authored dynamic tag",
    `<const/X=input.t/>\n<${D}{X}>${D}{input.count}</>`,
    "return (<>{__mxDynamic(X, { content: () => <>{input.count}{null}</> })}</>);",
  ],
  [
    "a dynamic tag with arguments",
    `<const/X=input.t/>\n<${D}{X}(0)>${D}{input.count}</>`,
    "return (<>{__mxDynamic(X, [0, { content: () => <>{input.count}{null}</> }], () => <>{input.count}{null}</>)}</>);",
  ],
  [
    "a positional call to a host component",
    `${BOX}<Box(1)>${D}{input.count}</Box>`,
    "return (<>{__mxDynamic(Box, [1, { content: () => <>{input.count}{null}</> }], () => <>{input.count}{null}</>)}</>);",
  ],
  [
    "a define call",
    `<define/D|{ content }|><${D}{content}/></define>\n<D>${D}{input.count}</D>`,
    "return (<>{D({ content: () => <>{input.count}{null}</> })}</>);",
  ],
  [
    "an authored dynamic tag with tag params",
    `<const/X=input.t/>\n<${D}{X}|n|>${D}{n}</>`,
    "return (<>{__mxDynamic(X, { content: ((n) => <>{n}{null}</>) as (...args: any[]) => any }, undefined, true)}</>);",
  ],
];

describe("preact: a host component's body is emitted as hand-written JSX would pass it", () => {
  it.each(EMITTED)("%s", (_name, source, expected) => {
    const code = compile(source);
    expect(returned(code)).toBe(expected);
    expect(() => parseTsx(code)).not.toThrow();
  });

  it.each(MX_OWN)(
    "keeps MX's fragment and its {null} sibling for %s",
    (_name, source, expected) => {
      const code = compile(source);
      expect(returned(code)).toBe(expected);
      expect(() => parseTsx(code)).not.toThrow();
    },
  );

  it("writes no {null} sibling into a host component's body", () => {
    for (const [, source] of EMITTED) {
      if (source.includes("<for") || source.includes("<@a>")) continue;
      expect(compile(source)).not.toMatch(/content: [^\n]*\{null\}/);
    }
  });
});

// ---------------------------------------------------------------------------
// Rendering: the same source, written by hand, on the same host.

/** `box.tsx`: components that record the `children` they receive. */
const BOX_MODULE = `
export const seen: string[] = [];
function dump(c: any): unknown {
  if (Array.isArray(c)) return c.map(dump);
  if (c !== null && typeof c === "object") {
    const tag = c.tag ?? c.type;
    const name = typeof tag === "function" ? tag.name || "fn" : typeof tag === "symbol" ? String(tag.description) : String(tag);
    return { el: name, kids: dump(c.props?.children ?? c.children) };
  }
  if (typeof c === "number" && Number.isNaN(c)) return "NaN";
  return c === undefined ? "undefined" : c;
}
export const Box = ({ children }: any) => {
  seen.push(JSON.stringify(dump(children)));
  return <div>{children}</div>;
};
export const Plain = ({ children }: any) => {
  seen.push(JSON.stringify(dump(children)));
  return children;
};
/** A render prop: calls its children with 0 and NaN and keeps what they return. */
export const Rows = ({ children }: any) => {
  seen.push(JSON.stringify([dump(children(0)), dump(children(Number.NaN))]));
  return <div>{children(0)}{children(Number.NaN)}</div>;
};
export const Maybe: any = null;
`;

interface Rendered {
  html: string;
  seen: string[];
}

interface Scratch {
  dir: string;
  render(
    kind: "mx" | "hand",
    body: string,
    props: Record<string, unknown>,
  ): Promise<Rendered>;
  cleanup(): void;
}

let scratch: Scratch;
let serial = 0;

async function makeScratch(): Promise<Scratch> {
  const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mx-preact-host-body-"));
  symlinkSync(
    dirname(dirname(require.resolve("preact/package.json"))),
    join(dir, "node_modules"),
    "dir",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
    }),
  );
  writeFileSync(join(dir, "box.tsx"), BOX_MODULE);
  const box = (await import(join(dir, "box.tsx"))) as { seen: string[] };
  return {
    dir,
    async render(kind, body, props) {
      const file = join(dir, `${kind}${serial++}.tsx`);
      writeFileSync(
        file,
        kind === "mx"
          ? compilePreactMx(
              `import { Fragment } from "preact";\nimport { Box, Plain, Rows, Maybe } from "./box.tsx";\n${body}`,
              join(dir, "page.mx"),
            ).code
          : `import { Fragment } from "preact";\nimport { Box, Plain, Rows } from "./box.tsx";\nexport default function Page(props: any) {\n  const count = props.count;\n  return (${body});\n}\n`,
      );
      const mod = (await import(file)) as {
        default: (props: Record<string, unknown>) => unknown;
      };
      box.seen.length = 0;
      const html = await renderPage(mod.default, props);
      return { html, seen: [...box.seen] };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function renderPage(
  page: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
): Promise<string> {
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  return render(h(page as never, props));
}

beforeAll(async () => {
  scratch = await makeScratch();
});
afterAll(() => scratch.cleanup());

const COUNTS: Array<[string, unknown]> = [
  ["0", 0],
  ["NaN", Number.NaN],
  ["1", 1],
  ["an empty string", ""],
  ["false", false],
];

// [name, MX body, the same body in JSX]
const SHAPES: Array<[string, string, string]> = [
  [
    "<Fragment> with a lone placeholder",
    "<Fragment>${input.count}</Fragment>",
    "<Fragment>{count}</Fragment>",
  ],
  [
    "a component with a lone placeholder",
    "<Box>${input.count}</Box>",
    "<Box>{count}</Box>",
  ],
  [
    "a component returning its children",
    "<Plain>${input.count}</Plain>",
    "<Plain>{count}</Plain>",
  ],
  ["text", "<Box>hi</Box>", "<Box>hi</Box>"],
  [
    "text around a placeholder",
    "<Box>a ${input.count} b</Box>",
    "<Box>a {count} b</Box>",
  ],
  ["an element", "<Box><b>x</b></Box>", "<Box><b>x</b></Box>"],
  [
    "an element and a placeholder",
    "<Box><b>x</b>${input.count}</Box>",
    "<Box><b>x</b>{count}</Box>",
  ],
  [
    "a placeholder padded with newlines",
    "<Box>\n  ${input.count}\n</Box>",
    "<Box>\n  {count}\n</Box>",
  ],
  [
    "an <if> with a lone placeholder",
    "<Box><if=input.count>${input.count}</if></Box>",
    "<Box>{count ? count : null}</Box>",
  ],
  [
    "a host component inside a host component",
    "<Box><Plain>${input.count}</Plain></Box>",
    "<Box><Plain>{count}</Plain></Box>",
  ],
  ["a render prop", "<Rows|n|>${n}</Rows>", "<Rows>{(n: number) => n}</Rows>"],
  [
    "a render prop with an element",
    "<Rows|n|><b>${n}</b></Rows>",
    "<Rows>{(n: number) => <b>{n}</b>}</Rows>",
  ],
];

describe("preact: an MX host-component call renders and passes what the JSX does", () => {
  for (const [name, mx, hand] of SHAPES) {
    for (const [label, count] of COUNTS) {
      it(`${name}, count ${label}`, async () => {
        const props = { count };
        const fromMx = await scratch.render("mx", mx, props);
        const fromHand = await scratch.render("hand", hand, props);
        expect(fromMx.html).toBe(fromHand.html);
        expect(fromMx.seen).toEqual(fromHand.seen);
      });
    }
  }

  // What the hand-written JSX renders on this host, pinned so the equality
  // above cannot drift to a shared wrong answer.
  it.each<[string, unknown, string]>([
    ["0", 0, "0"],
    ["NaN", Number.NaN, "NaN"],
    ["1", 1, "1"],
    ["an empty string", "", ""],
    ["false", false, ""],
  ])(
    "a lone <Fragment> placeholder with %s renders the hand-written JSX's markup",
    async (_label, count, html) => {
      const fromMx = await scratch.render(
        "mx",
        "<Fragment>${input.count}</Fragment>",
        { count },
      );
      expect(fromMx.html).toBe(html);
    },
  );

  it("hands a component the bare value, string or array, as <Box>{count}</Box> does", async () => {
    const lone = await scratch.render("mx", "<Plain>${input.count}</Plain>", {
      count: 0,
    });
    expect(lone.seen).toEqual(["0"]);
    const mixed = await scratch.render("mx", "<Box>a ${input.count} b</Box>", {
      count: 0,
    });
    expect(mixed.seen).toEqual(['["a ",0," b"]']);
    const text = await scratch.render("mx", "<Box>hi</Box>", {});
    expect(text.seen).toEqual(['"hi"']);
  });

  // A binding that is absent at run time is Marko's falsy dynamic target: no
  // tag, and the body renders on its own (the html target prints the 0). The
  // body function now returns the bare value, so the dispatch closes it.
  it.each<[string, unknown, string]>([
    ["0", 0, "0"],
    ["NaN", Number.NaN, "NaN"],
    ["1", 1, "1"],
    ["an empty string", "", ""],
  ])(
    "an absent imported binding still renders its body, count %s",
    async (_label, count, html) => {
      const rendered = await scratch.render(
        "mx",
        "<Maybe>${input.count}</Maybe>",
        { count },
      );
      expect(rendered.html).toBe(html);
    },
  );
});
