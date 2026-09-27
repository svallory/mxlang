// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX fixture source uses `${...}` placeholders.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomTag } from "@mxlang/core";
import { createElement as honoCreateElement, jsx } from "hono/jsx";
import { createElement as preactCreateElement } from "preact";
import { render as renderPreact } from "preact-render-to-string";
import { createElement as reactCreateElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compilePreactMx } from "./index.ts";

type Host = "preact" | "react" | "hono";

const hosts: Host[] = ["preact", "react", "hono"];
const jsxSources = { preact: "preact", react: "react", hono: "hono/jsx" };
const repoNodeModules = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../node_modules",
);
let serial = 0;

type Compiler = typeof compilePreactMx;

async function compilerFor(host: Host): Promise<Compiler> {
  if (host === "preact") return compilePreactMx;
  const url = new URL(`../../${host}/src/index.ts`, import.meta.url).href;
  const module = (await import(/* @vite-ignore */ url)) as Record<
    string,
    unknown
  >;
  return module[
    host === "react" ? "compileReactMx" : "compileHonoMx"
  ] as Compiler;
}

async function renderFixture(
  host: Host,
  files: Record<string, string>,
  input: Record<string, unknown> = {},
  registeredTags: Record<string, string> = {},
): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), `mx-${host}-attr-tags-r2-`));
  try {
    const compile = await compilerFor(host);
    symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    // Callee declarations must exist before the caller is compiled: core
    // resolves each imported Input from disk.
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(
        join(scratch, name),
        `${name.endsWith(".tsx") ? "/** @jsxRuntime automatic */\n" : ""}${source.replaceAll("HOSTJSX", jsxSources[host])}`,
      );
    }
    const customTags = Object.fromEntries(
      Object.entries(registeredTags).map(([name, filename]) => [
        name,
        {
          template: {
            filename: join(scratch, filename),
            source: files[filename] as string,
          },
        } as CustomTag,
      ]),
    );
    for (const [name, source] of Object.entries(files)) {
      if (!name.endsWith(".mx")) continue;
      const output = compile(source, join(scratch, name), {
        customTags,
      }).code.replace(/from "\.\/(\w+)\.mx"/g, 'from "./$1.tsx"');
      writeFileSync(
        join(scratch, name.replace(/\.mx$/, ".tsx")),
        `/** @jsxRuntime automatic */\n${output}`,
      );
    }

    const mod = (await import(
      `${join(scratch, "main.tsx")}?r2=${serial++}`
    )) as { default: (props: Record<string, unknown>) => unknown };
    if (host === "preact") {
      return renderPreact(
        preactCreateElement(mod.default as never, input as never),
      );
    }
    if (host === "react") {
      return renderToStaticMarkup(
        reactCreateElement(mod.default as never, input as never),
      );
    }
    return await (
      jsx(mod.default as never, input as never) as {
        toString(): Promise<string>;
      }
    ).toString();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function dataRow(input: string, body: string): string {
  return `export interface Input { ${input} }\n${body}`;
}

afterEach(() => vi.restoreAllMocks());

describe("attribute tags round-2 regressions (executed)", () => {
  for (const host of hosts) {
    it(`${host}: preserves falsy placeholder bodies and a zero range row`, async () => {
      const files = {
        "main.mx":
          'import Row from "./row.mx"\n<Row><@head>${input.n}</@head><@slot>${input.n}</@slot><for|i| from=0 until=1><@items>${i}</@items></for></Row>',
        "row.mx": dataRow(
          'head: AttrTag; slot: AttrTag<{ as: "renderable" }>; items: AttrTag[]',
          "<p>[<${input.head.content}/>][${input.head.content}][<${input.slot}/>][${input.slot}]<for|item| of=input.items><i>[<${item.content}/>][${item.content}]</i></for></p>",
        ),
      };

      for (const [value, rendered] of [
        [0, "0"],
        ["", ""],
        [false, ""],
        [null, ""],
      ] as const) {
        const html = await renderFixture(host, files, { n: value });
        expect(html).toBe(
          `<p>[${rendered}][${rendered}][${rendered}][${rendered}]<i>[0][0]</i></p>`,
        );
      }
    });

    it(`${host}: renders placeholder-only data and renderable bodies as escaped text`, async () => {
      const attack = "<img src=x onerror=alert(1)>";
      const html = await renderFixture(
        host,
        {
          "main.mx":
            'import Row from "./row.mx"\n<Row><@head>${input.value}</@head><@slot>${input.value}</@slot></Row>',
          "row.mx": dataRow(
            'head: AttrTag; slot: AttrTag<{ as: "renderable" }>',
            "<p><${input.head.content}/>|<${input.slot}/></p>",
          ),
        },
        { value: attack },
      );
      expect(html).not.toContain("<img");
      expect(html.match(/img src=x onerror=alert\(1\)/g)).toHaveLength(2);
    });

    it(`${host}: rejects the old dynamic-tag idiom for an untyped data value`, async () => {
      await expect(
        renderFixture(host, {
          "main.mx": 'import Row from "./row.mx"\n<Row><@head>H</@head></Row>',
          "row.mx": "<p><${input.head}/></p>",
        }),
      ).rejects.toThrow(
        "MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <${x.content}/>",
      );
    });
  }

  it("reports a positioned compile error for the old idiom on a declared data tag", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mx-declared-data-tag-r2-"));
    try {
      writeFileSync(
        join(scratch, "row.mx"),
        "export interface Input { head: AttrTag }\n<p><${input.head}/></p>",
      );
      expect(() =>
        compilePreactMx(
          'import Row from "./row.mx"\n<Row><@head>H</@head></Row>',
          join(scratch, "main.mx"),
        ),
      ).toThrow(/data attribute tag/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(["static", "for", "mixed"] as const)(
    "react: keys %s renderable arrays without warnings",
    async (shape) => {
      const bodies = {
        static: "<@slot><b>a</b></@slot><@slot><b>b</b></@slot>",
        for: '<for|x| of=["a", "b"]><@slot><b>${x}</b></@slot></for>',
        mixed:
          '<@slot><b>a</b></@slot><for|x| of=["b"]><@slot><b>${x}</b></@slot></for><@slot><b>c</b></@slot>',
      };
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const html = await renderFixture("react", {
        "main.mx": `import Row from "./row.mx"\n<Row>${bodies[shape]}</Row>`,
        "row.mx": dataRow(
          'slot: AttrTag<{ as: "renderable" }>[]',
          "<p>${input.slot}</p>",
        ),
      });
      expect(html).toMatch(/^<p><b>a<\/b><b>b<\/b>/);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("react: keys data-tag content collected by map without warnings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await renderFixture("react", {
      "main.mx":
        'import Row from "./row.mx"\n<Row><@item><b>a</b></@item><@item><b>b</b></@item></Row>',
      "row.mx": dataRow(
        "item: AttrTag[]",
        "<p>${input.item.map((x) => x.content)}</p>",
      ),
    });
    expect(html).toBe("<p><b>a</b><b>b</b></p>");
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  for (const host of hosts) {
    it(`${host}: executes for-in, inclusive range, and until attribute tags`, async () => {
      const html = await renderFixture(
        host,
        {
          "main.mx":
            'import Row from "./row.mx"\n<const/value="outer"/><Row><for|k, v| in=input.obj><@item>${k}:${v}</@item></for><for|k| in=input.obj><@item>${k}:${value}</@item></for><for|i| from=1 to=3><@item>${i}</@item></for><for|i| until=2><@item>u${i}</@item></for></Row>',
          "row.mx": dataRow(
            "item: AttrTag[]",
            "<p><for|x| of=input.item>[<${x.content}/>]</for></p>",
          ),
        },
        { obj: { a: 1, b: 2 } },
      );
      expect(html).toBe("<p>[a:1][b:2][a:outer][b:outer][1][2][3][u0][u1]</p>");
    });

    it(`${host}: keeps an outer value binding in a content for-in`, async () => {
      const html = await renderFixture(
        host,
        {
          "main.mx":
            '<const/value="OUTER"/><for|k| in=input.obj><span>${k}=${value}</span></for>',
        },
        { obj: { a: 1 } },
      );
      expect(html).toBe("<span>a=OUTER</span>");
    });

    it(`${host}: executes else-if, for-in-if, and if under a nested tag`, async () => {
      const html = await renderFixture(
        host,
        {
          "main.mx":
            'import Row from "./row.mx"\n<Row><if=input.mode===1><@head>one</@head></if><else if=input.mode===2><@head>two</@head></else><else><@head>three</@head></else><for|k, v| in=input.obj><if=(v > 1)><@item>${k}</@item></if></for><@tab><if=input.on><@icon>ON</@icon></if><else><@icon>OFF</@icon></else></@tab></Row>',
          "row.mx": dataRow(
            "head: AttrTag; item: AttrTag[]; tab: AttrTag<{ attrs: { icon?: AttrTag } }>",
            "<p><${input.head.content}/>|<for|x| of=input.item><${x.content}/></for>|<${input.tab.icon?.content}/></p>",
          ),
        },
        { mode: 2, obj: { a: 1, b: 2 }, on: false },
      );
      expect(html).toBe("<p>two|b|OFF</p>");
    });

    it(`${host}: preserves loop closure capture in parameterized bodies`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.mx"\n<Row><for|x| of=["a", "b"]><@item|suffix|>${x}${suffix}</@item></for></Row>',
        "row.mx": dataRow(
          "item: AttrTag<{ params: [suffix: string] }>[]",
          '<p><for|x| of=input.item><span>${x.content("!")}</span></for></p>',
        ),
      });
      expect(html).toBe("<p><span>a!</span><span>b!</span></p>");
    });

    it(`${host}: resolves and renders a TSX callee Input declaration`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.tsx"\n<Row><@head>H</@head><for|x| of=["a", "b"]><@items|n|>${x}${n}</@items></for><@slot><i>S</i></@slot></Row>',
        "row.tsx": `/** @jsxImportSource HOSTJSX */
import type { AttrTag } from "@mxlang/${host}";
export interface Input { head: AttrTag; items: AttrTag<{ params: [n: number] }>[]; slot: AttrTag<{ as: "renderable" }> }
export default function Row(props: Input) { return <p>{props.head.content}|{props.items.map((x, i) => x.content(i))}|{props.slot}</p>; }`,
      });
      expect(html).toBe("<p>H|a0b1|<i>S</i></p>");
    });
  }

  it.each(["preact", "react"] as const)(
    "%s: emitted looped parameter bodies pass strict tsc",
    async (host) => {
      const scratch = mkdtempSync(join(tmpdir(), `mx-${host}-attr-tsc-r2-`));
      try {
        const compile = await compilerFor(host);
        symlinkSync(repoNodeModules, join(scratch, "node_modules"), "dir");
        const row = `/** @jsxImportSource ${jsxSources[host]} */
import type { AttrTag } from "@mxlang/${host}";
export interface Input { items: AttrTag<{ params: [n: number] }>[] }
export default function Row(props: Input) { return <p>{props.items.map((x, i) => x.content?.(i))}</p>; }`;
        writeFileSync(join(scratch, "row.tsx"), row);
        writeFileSync(
          join(scratch, "main.tsx"),
          compile(
            'import Row from "./row.tsx"\nexport interface Input { list: string[] }\n<Row><for|x| of=input.list><@items|n|>${x}${n.toFixed(1)}</@items></for></Row>',
            join(scratch, "main.mx"),
          ).code,
        );
        writeFileSync(
          join(scratch, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              allowImportingTsExtensions: true,
              baseUrl: dirname(repoNodeModules),
              jsx: "react-jsx",
              jsxImportSource: jsxSources[host],
              ignoreDeprecations: "6.0",
              module: "ESNext",
              moduleResolution: "Bundler",
              noEmit: true,
              skipLibCheck: true,
              strict: true,
              target: "ESNext",
              types: ["node"],
              paths: {
                "@mxlang/core": ["packages/core/src/index.ts"],
                "@mxlang/preact": ["packages/hosts/preact/src/index.ts"],
                "@mxlang/react": ["packages/hosts/react/src/index.ts"],
              },
            },
            include: ["*.tsx"],
          }),
        );
        const proc = spawnSync(
          join(repoNodeModules, ".bin", "tsc"),
          ["-p", join(scratch, "tsconfig.json")],
          { encoding: "utf8" },
        );
        expect(proc.stderr).toBe("");
        expect(proc.stdout).toBe("");
        expect(proc.status).toBe(0);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it.each(hosts)(
    "%s: #propsObject renders dynamic tags and nested data",
    async (host) => {
      const factories = {
        preact: (props: { head: { content: unknown }; children: unknown }) =>
          preactCreateElement(
            "section",
            null,
            props.head.content as never,
            props.children as never,
          ),
        react: (props: { head: { content: unknown }; children: unknown }) =>
          reactCreateElement(
            "section",
            null,
            props.head.content as never,
            props.children as never,
          ),
        hono: (props: { head: { content: unknown }; children: unknown }) =>
          honoCreateElement(
            "section",
            null,
            props.head.content as never,
            props.children as never,
          ),
      };
      const html = await renderFixture(
        host,
        {
          "main.mx": "<${input.tag}><@head>${input.value}</@head><b>B</b></>",
        },
        { tag: factories[host], value: "H" },
      );
      expect(html).toBe("<section>H<b>B</b></section>");
    },
  );

  it.each(hosts)(
    "%s: #propsObject invokes a returning unit with props, tags, and content",
    async (host) => {
      const html = await renderFixture(
        host,
        {
          "main.mx":
            '<const/rest={label: "L"}/><result ...rest><@head>H</@head><b>B</b></result>',
          "result.mx": dataRow(
            "label: string; head: AttrTag",
            "<p>${input.label}:<${input.head.content}/>:<${input.content}/></p>\n<return value=input.label/>",
          ),
        },
        {},
        { result: "result.mx" },
      );
      expect(html).toBe("<p>L:H:<b>B</b></p>");
    },
  );
});
