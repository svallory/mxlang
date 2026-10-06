// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX fixture source uses `${...}` placeholders.
/**
 * `<List|item, i|>…</List>` hands the body the values the component passes to
 * it. The JSX emitter used to drop the params, emitting
 * `content: () => …` so `item` was unbound (a `ReferenceError` at render, no
 * MX diagnostic). A callee reads the body as its render-prop child, exactly as
 * the plain `<List>{(item, i) => …}</List>` form does.
 */
import { spawnSync } from "node:child_process";
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
 * strict tsc. `content` stays `unknown`: the module preamble assigns the
 * normalized body to it (space TODO.md,
 * `jsx-mx-input-typed-content-ts2322`).
 */
const MX_BODY = "(item: string, i: number) => unknown";
const MX_LIST = `export interface Input { items: string[]; content?: unknown; children?: ${MX_BODY} }
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
  /**
   * A `<define>`'s own declared params are emitted unannotated
   * (`const Row = (p) => …`), so strict tsc reports them whether or not the
   * call has tag params (space TODO.md, `jsx-define-params-implicit-any`). Listed here
   * so the strict test still proves the body's params are bound and typed.
   */
  untypedDefineParams?: string[];
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
    untypedDefineParams: ["p"],
  },
  "a define called with args and a params body": {
    caller: `export interface Input { items: string[] }
<define/Row|a, content|>
  <li>\${a}<\${content}("r")/></li>
</define>
<ul><Row("x")|n|><b>\${n}</b></Row></ul>`,
    html: "<ul><li>x<b>r</b></li></ul>",
    untypedDefineParams: ["a", "content"],
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

  it.each(Object.entries(CASES))(
    "%s: the params are bound and typed under strict tsc",
    async (_name, testCase) => {
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
              skipLibCheck: true,
              strict: true,
              target: "ESNext",
              types: ["node"],
            },
            include: ["*.tsx"],
          }),
        );
        const proc = spawnSync(
          join(repoNodeModules, ".bin", "tsc"),
          ["-p", join(scratch, "tsconfig.json")],
          { encoding: "utf8" },
        );
        const errors = (proc.stdout + proc.stderr)
          .split("\n")
          .filter(Boolean)
          .map((line) => line.replace(/^.*?: error /, ""));
        const expected = (testCase.untypedDefineParams ?? []).map(
          (name) => `TS7006: Parameter '${name}' implicitly has an 'any' type.`,
        );
        expect(errors).toEqual(expected);
        expect(proc.status).toBe(expected.length === 0 ? 0 : 2);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

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
  it("a call with no params keeps `content: () =>` and no render prop", () => {
    const { code } = compilePreactMx(
      `import List from "./list.tsx"\n<List><b>x</b></List>`,
      "/fixtures/t.mx",
    );
    expect(code).toContain("content: () => <><b>x</b></>");
    expect(code).not.toContain("=> (");
    expect(code).toContain(
      "__mxDynamic(List, { content: () => <><b>x</b></> })",
    );
  });

  it("a call with params makes `content` itself take them", () => {
    const { code } = compilePreactMx(
      CASES["an imported component"]?.caller as string,
      "/fixtures/t.mx",
    );
    expect(code).toContain("content: ((item, i) => <>");
    expect(code).toContain("as (...args: any[]) => any");
    expect(code).not.toContain("() => (item, i)");
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
