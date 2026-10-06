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
  return <ul>{props.items.map((x, i) => <li>{props.children(x, i) as never}</li>)}</ul>;
}`;

const CALLERS = {
  "an imported component": `import List from "./list.tsx"
export interface Input { items: string[] }
<List|item, i| items=input.items><b>\${item}\${i}</b></List>`,
  "a dynamic target": `import List from "./list.tsx"
export interface Input { items: string[] }
<const/L = List/>
<\${L}|item, i| items=input.items><b>\${item}\${i}</b></>`,
};

function scratchFor(host: Host, caller: string) {
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
  return {
    scratch,
    async compile() {
      const compile = await compilerFor(host);
      const code = compile(caller, join(scratch, "main.mx")).code;
      writeFileSync(
        join(scratch, "main.tsx"),
        `/** @jsxRuntime automatic */\n${code}`,
      );
      return code;
    },
  };
}

describe.each(hosts)("%s: tag params on a component call", (host) => {
  it.each(Object.entries(CALLERS))(
    "%s: the body receives the values the component passes",
    async (_name, caller) => {
      const { scratch, compile } = scratchFor(host, caller);
      try {
        await compile();
        const mod = (await import(
          `${join(scratch, "main.tsx")}?tp=${serial++}`
        )) as { default: (props: Record<string, unknown>) => unknown };
        const props = { items: ["a", "b"] };
        const html =
          host === "preact"
            ? renderPreact(preactCreateElement(mod.default as never, props))
            : host === "react"
              ? renderToStaticMarkup(
                  reactCreateElement(mod.default as never, props),
                )
              : String(
                  await (
                    honoJsx(mod.default as never, props as never) as {
                      toString(): Promise<string>;
                    }
                  ).toString(),
                );
        expect(html).toBe("<ul><li><b>a0</b></li><li><b>b1</b></li></ul>");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it.each(Object.entries(CALLERS))(
    "%s: the params are bound and typed under strict tsc",
    async (_name, caller) => {
      const { scratch, compile } = scratchFor(host, caller);
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
              noImplicitAny: false,
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
        expect(proc.stdout).not.toContain("Cannot find name 'item'");
        expect(proc.stdout).not.toContain("Cannot find name 'i'");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});

describe("tag params leave other emission alone", () => {
  it("a call with no params keeps `content: () =>` and no render prop", () => {
    const { code } = compilePreactMx(
      `import List from "./list.tsx"\n<List><b>x</b></List>`,
      "/fixtures/t.mx",
    );
    expect(code).toContain("content: () => <><b>x</b></>");
    expect(code).not.toContain("=> (");
  });

  it("a call with params emits the declared params on the body", () => {
    const { code } = compilePreactMx(
      CALLERS["an imported component"],
      "/fixtures/t.mx",
    );
    expect(code).toContain("content: () => (item, i) => <>");
  });
});
