// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX fixture source uses `${...}` placeholders.
/**
 * `<List|item, i|>…</List>` hands the body the values the component passes to
 * it. The JSX emitter used to drop the params, emitting
 * `content: () => …` so `item` was unbound (a `ReferenceError` at render, no
 * MX diagnostic). A callee reads the body as its render-prop child, exactly as
 * the plain `<List>{(item, i) => …}</List>` form does.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsx as honoJsx } from "hono/jsx";
import { createElement as preactCreateElement } from "preact";
import { render as renderPreact } from "preact-render-to-string";
import { createElement as reactCreateElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { strictTsc } from "./fixtures/strict-tsc.ts";
import { compilePreactMx } from "./index.ts";

type Host = "preact" | "react" | "hono";
const hosts: Host[] = ["preact", "react", "hono"];
const jsxSources = { preact: "preact", react: "react", hono: "hono/jsx" };
const repoNodeModules = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../node_modules",
);
let serial = 0;

async function compilerFor(host: Host): Promise<typeof compilePreactMx> {
  if (host === "preact") return compilePreactMx;
  const url = new URL(`../../${host}/src/index.ts`, import.meta.url).href;
  const module = (await import(/* @vite-ignore */ url)) as Record<
    string,
    unknown
  >;
  return module[
    host === "react" ? "compileReactMx" : "compileHonoMx"
  ] as typeof compilePreactMx;
}

/** A callee that calls its body once per item, as a render-prop component does. */
const LIST = `/** @jsxRuntime automatic @jsxImportSource HOSTJSX */
export interface Input { items: string[]; children: (item: string, i: number) => unknown }
export default function List(props: Input) {
  return <ul>{props.items.map((x, i) => <li key={i}>{props.children(x, i) as never}</li>)}</ul>;
}`;

/**
 * The same callee written in MX: it calls `input.content` with the item. It
 * types `children` (the slot a described call fills) as a function, as a TSX
 * component does, so the caller's params take their types from it under
 * strict tsc. `content` is typed as a function too: the module preamble casts
 * the normalized body instead of assigning it.
 */
const MX_BODY = "(item: string, i: number) => unknown";
const MX_LIST = `export interface Input { items: string[]; content?: ${MX_BODY}; children?: ${MX_BODY} }
<ul>
  <for|x, i| of=input.items>
    <li><\${input.content}(x, i)/></li>
  </for>
</ul>`;

/** A callee called with positional args, reading the body from its trailing props. */
const ARGS_FN = `/** @jsxRuntime automatic @jsxImportSource HOSTJSX */
export default function Args(label: string, props: { content: (item: string) => unknown }) {
  return <p>{label}:{props.content("x") as never}</p>;
}`;

const LIST_HTML = "<ul><li><b>a0</b></li><li><b>b1</b></li></ul>";

interface Case {
  callee?: { file: string; source: string };
  caller: string;
  html: string;
  /** Also run with `noUnusedLocals`: no emitted binding may go unread. */
  unusedLocals?: boolean;
  /** Also run with `strictNullChecks` off, where a null default widens. */
  looseNull?: boolean;
}

const CASES: Record<string, Case> = {
  "an imported component": {
    caller: `import List from "./list.tsx"
export interface Input { items: string[] }
<List|item, i| items=input.items><b>\${item}\${i}</b></List>`,
    html: LIST_HTML,
  },
  "a dynamic target": {
    caller: `import List from "./list.tsx"
export interface Input { items: string[] }
<const/L = List/>
<\${L}|item, i| items=input.items><b>\${item}\${i}</b></>`,
    html: LIST_HTML,
  },
  "an .mx-compiled callee reading input.content": {
    callee: { file: "list2.mx", source: MX_LIST },
    caller: `import List from "./list2.mx"
export interface Input { items: string[] }
<List|item, i| items=input.items><b>\${item}\${i}</b></List>`,
    html: LIST_HTML,
  },
  "an .mx-compiled callee on a dynamic target": {
    callee: { file: "list2.mx", source: MX_LIST },
    caller: `import List from "./list2.mx"
export interface Input { items: string[] }
<const/L = List/>
<\${L}|item, i| items=input.items><b>\${item}\${i}</b></>`,
    html: LIST_HTML,
  },
  "a define with params": {
    caller: `export interface Input { items: string[] }
<define/Row|p|>
  <li><\${p.content}("r")/></li>
</define>
<ul><Row|n|><b>\${n}</b></Row></ul>`,
    html: "<ul><li><b>r</b></li></ul>",
  },
  "a define called with args and a params body": {
    caller: `export interface Input { items: string[] }
<define/Row|a, { content }|>
  <li>\${a}<\${content}("r")/></li>
</define>
<ul><Row("x")|n|><b>\${n}</b></Row></ul>`,
    html: "<ul><li>x<b>r</b></li></ul>",
  },
  "a /var in a define body that shadows another define": {
    callee: {
      file: "fn.mx",
      source: `export interface Input {}
<return value=(n: number) => "local" + n/>`,
    },
    caller: `import Fn from "./fn.mx"
export interface Input { items: string[] }
<define/Row|a|><li>\${a}</li></define>
<define/Wrap><Fn/Row/><li><Row(2)/></li></define>
<ul><Wrap/></ul>`,
    html: "<ul><li>local2</li></ul>",
  },
  "a /var in a dynamic tag body that shadows a define": {
    callee: {
      file: "fn.mx",
      source: `export interface Input {}
<return value=(n: number) => "local" + n/>`,
    },
    caller: `import Fn from "./fn.mx"
export interface Input { items: string[] }
<define/Row|a|><li>\${a}</li></define>
<ul><\${"section"}><Fn/Row/><Row(2)/></></ul>`,
    html: "<ul><section>local2</section></ul>",
  },
  "an unrelated <for|Row|> leaves a direct call's argument as written": {
    caller: `export interface Input { items: string[] }
<define/Row|o|>\${typeof o.content}</define>
<p><for|Row| of=input.items>\${Row}</for><Row({ children: "c" })/></p>`,
    html: "<p>abundefined</p>",
  },
  "a call before the /var that shadows its define": {
    callee: {
      file: "fn.mx",
      source: `export interface Input {}
<return value=(n: number) => "local" + n/>`,
    },
    caller: `import Fn from "./fn.mx"
export interface Input { items: string[] }
<define/Row|a|><li>\${a}</li></define>
<define/Wrap><Row(2)/><Fn/Row/></define>
<ul><Wrap/></ul>`,
    html: "<ul>local2</ul>",
  },
  "a call nested in an element before the /var that shadows its define": {
    callee: {
      file: "fn.mx",
      source: `export interface Input {}
<return value=(n: number) => "local" + n/>`,
    },
    caller: `import Fn from "./fn.mx"
export interface Input { items: string[] }
<define/Row|a|><li>\${a}</li></define>
<define/Wrap><p><Row(2)/></p><Fn/Row/></define>
<ul><Wrap/></ul>`,
    html: "<ul><p>local2</p></ul>",
  },
  "a /var inside an element, then a call in the same body": {
    callee: {
      file: "fn.mx",
      source: `export interface Input {}
<return value=(n: number) => "local" + n/>`,
    },
    caller: `import Fn from "./fn.mx"
export interface Input { items: string[] }
<define/Row|a|><li>\${a}</li></define>
<ul><\${"section"}><div><Fn/Row/></div><Row(1)/></></ul>`,
    html: "<ul><section><div></div>local1</section></ul>",
  },
  "an attribute-tag <for> param that shadows a define": {
    callee: {
      file: "box.tsx",
      source: `/** @jsxRuntime automatic @jsxImportSource HOSTJSX */
export default function Box(props: { item?: any }) {
  const items: any[] = Array.isArray(props.item) ? props.item : [props.item];
  return <div>{items.map((i) => (typeof i === "function" ? i() : i)) as never}</div>;
}`,
    },
    caller: `import Box from "./box.tsx"
export interface Input { items: string[] }
<define/Row|p|><li>\${p}</li></define>
<Box><for|Row| of=[(n: number) => "L" + n]><@item><Row(1)/></@item></for></Box>`,
    html: "<div>L1</div>",
  },
  "a define read through a Unicode-escaped dynamic target": {
    caller: `export interface Input { items: string[] }
<define/Row><li>r</li></define>
<ul><\${\\u0052ow}/></ul>`,
    html: "<ul><li>r</li></ul>",
  },
  "a define called only directly (no unused public binding)": {
    caller: `export interface Input { items: string[] }
<define/Row|p|><li>\${p}</li></define>
<ul><for|x| of=input.items><Row(x)/></for></ul>`,
    html: "<ul><li>a</li><li>b</li></ul>",
    // The public wrapped value is not emitted when nothing reads it.
    unusedLocals: true,
  },
  "a define with attributes that is only called directly": {
    caller: `export interface Input { items: string[] }
<define/Row|p| x=1><li>\${p}</li></define>
<ul><for|x| of=input.items><Row(x)/></for></ul>`,
    html: "<ul><li>a</li><li>b</li></ul>",
    unusedLocals: true,
  },
  "a regex default in a define param: the call reaches the shadowing param": {
    caller: `<define/Row|x|><li>\${x}</li></define>
<define/List|{ a = /[}]/, Row }|><Row(1)/></define>
<List({ Row: (x: number) => "local" + x })/>`,
    html: "local1",
  },
  "a template-literal default in a define param: the call reaches the shadowing param":
    {
      caller: `<define/Row|x|><li>\${x}</li></define>
<define/List|{ a = \`\${"\\\`"}\`, Row }|><Row(1)/></define>
<List({ Row: (x: number) => "local" + x })/>`,
      html: "local1",
    },
  "a define read as a value keeps its arity and name": {
    caller: `<define/Row|a, b|><li>\${a}</li></define>
<p>\${Row.length}\${Row.name}</p>`,
    html: "<p>2Row</p>",
  },
  "a define whose attribute is spread": {
    caller: `export interface Input { items: string[] }
<define/Row|p| list=[1, 2]><li>\${p}</li></define>
<ul><for|x| of=input.items><Row(x)/></for></ul><p>\${[...Row.list].length}</p>`,
    html: "<ul><li>a</li><li>b</li></ul><p>2</p>",
    unusedLocals: true,
  },
  "a <for> param that shadows a define name": {
    caller: `export interface Input { items: string[] }
<define/Row|a|><li>outer:\${a}</li></define>
<Row(0)/>
<ul><for|Row| of=[(n: number) => "local" + n] by="name"><Row(1)/></for></ul>`,
    html: "<li>outer:0</li><ul>local1</ul>",
  },
  "a define param that shadows another define name": {
    caller: `export interface Input { items: string[] }
<define/Row|a|><li>outer:\${a}</li></define>
<define/Wrap|Row|><b><Row(2)/></b></define>
<Row(0)/><Wrap((n: number) => "p" + n)/>`,
    html: "<li>outer:0</li><b>p2</b>",
  },
  "a define whose param defaults to an array": {
    caller: `export interface Input { items: string[] }
<define/Row|xs = []|><li>\${xs.push(1)}</li></define>
<ul><Row(input.items)/></ul>`,
    html: "<ul><li>3</li></ul>",
    looseNull: true,
  },
  "a define whose param defaults to null": {
    caller: `export interface Input { items: string[] }
<define/Row|p = null|><li>\${p}</li></define>
<ul><for|x| of=input.items><Row(x)/></for></ul>`,
    html: "<ul><li>a</li><li>b</li></ul>",
    looseNull: true,
  },
  "a define whose destructured param has a default": {
    caller: `export interface Input { items: string[] }
<define/Row|{ a } = {}|><li>\${a}</li></define>
<ul><Row/></ul>`,
    html: "<ul><li></li></ul>",
  },
  "a <return> unit": {
    callee: {
      file: "unit.mx",
      source: `export interface Input { items: string[]; content?: unknown; children?: ${MX_BODY} }
<return=input.items.length/>
<ul><for|x| of=input.items><li><\${input.content}(x)/></li></for></ul>`,
    },
    caller: `import Unit from "./unit.mx"
export interface Input { items: string[] }
<Unit|item| items=input.items><b>\${item}</b></Unit>`,
    html: "<ul><li><b>a</b></li><li><b>b</b></li></ul>",
  },
  "a dynamic target with args": {
    callee: { file: "args.tsx", source: ARGS_FN },
    caller: `import Args from "./args.tsx"
export interface Input { items: string[] }
<const/A = Args/>
<\${A}("lbl")|item|><b>\${item}</b></>`,
    html: "<p>lbl:<b>x</b></p>",
  },
};

/** Params on a body whose target is a native element have nothing to call them. */
const STRING_CASES = {
  "a literal string target": `export interface Input { items: string[] }
<\${"div"}|item|>body \${item}</>`,
  "a literal string target with args": `export interface Input { items: string[] }
<\${"div"}("a")|item|>body \${item}</>`,
};

/** An optional render target: absent, Marko renders the body with no args. */
const NULLISH_TARGET = `export interface Input { c?: string }
<\${input.c}|item|>body</>`;

const RUNTIME_STRING = `export interface Input { tag: string }
<\${input.tag}|item|>body \${item}</>`;

function scratchFor(host: Host, testCase: Pick<Case, "caller" | "callee">) {
  const scratch = mkdtempSync(join(tmpdir(), `mx-${host}-tag-params-`));
  symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  writeFileSync(
    join(scratch, "list.tsx"),
    LIST.replaceAll("HOSTJSX", jsxSources[host]),
  );
  const callee = testCase.callee;
  if (callee?.file.endsWith(".tsx")) {
    writeFileSync(
      join(scratch, callee.file),
      callee.source.replaceAll("HOSTJSX", jsxSources[host]),
    );
  } else if (callee) {
    writeFileSync(join(scratch, callee.file), callee.source);
  }
  return {
    scratch,
    async compile() {
      const compile = await compilerFor(host);
      if (callee && !callee.file.endsWith(".tsx")) {
        writeFileSync(
          join(scratch, callee.file.replace(/\.mx$/, ".tsx")),
          `/** @jsxRuntime automatic */\n${compile(callee.source, join(scratch, callee.file)).code}`,
        );
      }
      const code = compile(testCase.caller, join(scratch, "main.mx")).code;
      writeFileSync(
        join(scratch, "main.tsx"),
        `/** @jsxRuntime automatic */\n${code.replaceAll('.mx"', '.tsx"')}`,
      );
      return code;
    },
  };
}

async function renderHtml(host: Host, component: unknown, props: object) {
  return host === "preact"
    ? renderPreact(preactCreateElement(component as never, props))
    : host === "react"
      ? renderToStaticMarkup(reactCreateElement(component as never, props))
      : String(
          await (
            honoJsx(component as never, props as never) as {
              toString(): Promise<string>;
            }
          ).toString(),
        );
}

describe.each(hosts)("%s: tag params on a component call", (host) => {
  it.each(Object.entries(CASES))(
    "%s: the body receives the values the component passes",
    async (_name, testCase) => {
      const { scratch, compile } = scratchFor(host, testCase);
      try {
        await compile();
        const mod = (await import(
          `${join(scratch, "main.tsx")}?tp=${serial++}`
        )) as { default: unknown };
        const html = await renderHtml(host, mod.default, {
          items: ["a", "b"],
        });
        expect(html).toBe(testCase.html);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it.concurrent.for(Object.entries(CASES))(
    "%s: the params are bound and typed under strict tsc",
    async ([_name, testCase], { signal }) => {
      const { scratch, compile } = scratchFor(host, testCase);
      try {
        await compile();
        writeFileSync(
          join(scratch, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              allowImportingTsExtensions: true,
              jsx: "react-jsx",
              jsxImportSource: jsxSources[host],
              module: "ESNext",
              moduleResolution: "Bundler",
              noEmit: true,
              noUnusedLocals: testCase.unusedLocals === true,
              skipLibCheck: true,
              strict: true,
              ...(testCase.looseNull ? { strictNullChecks: false } : {}),
              target: "ESNext",
              types: ["node"],
            },
            include: ["*.tsx"],
          }),
        );
        const proc = await strictTsc(join(scratch, "tsconfig.json"), signal);
        const errors = (proc.stdout + proc.stderr)
          .split("\n")
          .filter(Boolean)
          .map((line) => line.replace(/^.*?: error /, ""));
        expect(errors).toEqual([]);
        expect(proc.status).toBe(0);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it("a define param with a primitive default keeps its inferred type (TS2551 on a typo)", async () => {
    const { scratch, compile } = scratchFor(host, {
      caller: "<define/Row|n = 1|>${n.toFixd()}</define>\n<Row(2)/>",
    });
    try {
      await compile();
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            allowImportingTsExtensions: true,
            jsx: "react-jsx",
            jsxImportSource: jsxSources[host],
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ESNext",
            types: ["node"],
          },
          include: ["*.tsx"],
        }),
      );
      const proc = await strictTsc(
        join(scratch, "tsconfig.json"),
        new AbortController().signal,
      );
      const errors = (proc.stdout + proc.stderr).split("\n").filter(Boolean);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("TS2551");
      expect(errors[0]).toContain("toFixd");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(Object.entries(STRING_CASES))(
    "%s with a params body is a positioned compile error, as in Marko",
    async (_name, caller) => {
      const compile = await compilerFor(host);
      let error: unknown;
      try {
        compile(caller, "/fixtures/t.mx");
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        message: expect.stringContaining("Tag does not support parameters"),
        line: 2,
        column: 0,
      });
    },
  );

  it("an absent dynamic target renders the body with no args, as Marko does", async () => {
    const { scratch, compile } = scratchFor(host, { caller: NULLISH_TARGET });
    try {
      await compile();
      const mod = (await import(
        `${join(scratch, "main.tsx")}?tp=${serial++}`
      )) as { default: unknown };
      expect(await renderHtml(host, mod.default, {})).toBe("body");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("a string that arrives at run time throws instead of rendering an empty element", async () => {
    const { scratch, compile } = scratchFor(host, { caller: RUNTIME_STRING });
    try {
      await compile();
      const mod = (await import(
        `${join(scratch, "main.tsx")}?tp=${serial++}`
      )) as { default: unknown };
      await expect(
        renderHtml(host, mod.default, { tag: "div" }),
      ).rejects.toThrow(/tag params/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("tag params leave other emission alone", () => {
  it("a host component call with no params keeps `content: () =>` and no render prop", () => {
    const { code } = compilePreactMx(
      `import List from "./list.tsx"\n<List><b>x</b></List>`,
      "/fixtures/t.mx",
    );
    // A host component's body is what hand-written JSX would pass: the
    // element itself, with no fragment of MX's around it.
    expect(code).toContain("content: () => <b>x</b>");
    expect(code).not.toContain("=> (");
    expect(code).toContain("__mxDynamic(List, { content: () => <b>x</b> })");
  });

  it("a call with params makes `content` itself take them", () => {
    const { code } = compilePreactMx(
      CASES["an imported component"]?.caller as string,
      "/fixtures/t.mx",
    );
    // The render prop returns what `(item, i) => <b>…</b>` would.
    expect(code).toContain(
      "content: ((item, i) => <b>{__mxRenderable(item)}{__mxRenderable(i)}</b>)",
    );
    expect(code).toContain("as (...args: any[]) => any");
    expect(code).not.toContain("() => (item, i)");
    expect(code).toContain(", undefined, true)");
  });

  it("an authored dynamic tag keeps MX's fragment around a params body", () => {
    const { code } = compilePreactMx(
      CASES["a dynamic target"]?.caller as string,
      "/fixtures/t.mx",
    );
    expect(code).toContain("content: ((item, i) => <>");
    expect(code).toContain(", undefined, true)");
  });

  it("the args form passes params to both the trailing props and the content argument", () => {
    const { code } = compilePreactMx(
      CASES["a dynamic target with args"]?.caller as string,
      "/fixtures/t.mx",
    );
    expect(code).toContain("{ content: ((item) => <>");
    expect(code).toContain(", ((item) => <>");
    expect(code).toContain(", true)");
  });
});
