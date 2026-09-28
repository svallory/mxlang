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
type RegisteredTag =
  | string
  | {
      filename: string;
      transform: NonNullable<CustomTag["transform"]>;
    };

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
  registeredTags: Record<string, RegisteredTag> = {},
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
      Object.entries(registeredTags).map(([name, registration]) => {
        const filename =
          typeof registration === "string"
            ? registration
            : registration.filename;
        return [
          name,
          {
            template: {
              filename: join(scratch, filename),
              source: files[filename] as string,
            },
            ...(typeof registration === "string"
              ? {}
              : { transform: registration.transform }),
          } as CustomTag,
        ];
      }),
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

    it(`${host}: renders a body-only fallback through an untyped MX callee`, async () => {
      const html = await renderFixture(host, {
        "main.mx": 'import Row from "./row.mx"\n<Row><@head>H</@head></Row>',
        "row.mx": "<p><${input.head}/></p>",
      });
      expect(html).toBe("<p>H</p>");
    });

    it(`${host}: passes a body-only fallback bare to an untyped TSX library component`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Boundary from "./boundary.tsx"\n<Boundary><@fallback>ready</@fallback></Boundary>',
        "boundary.tsx": [
          "/** @jsxImportSource HOSTJSX */",
          "export default function Boundary(input: { fallback: unknown }) {",
          "  return <section>{input.fallback}</section>;",
          "}",
        ].join("\n"),
      });
      expect(html).toBe("<section>ready</section>");
    });

    it(`${host}: unifies nested shape across conditional parent occurrences`, async () => {
      const files = {
        "main.mx":
          'import Row from "./row.mx"\n<Row><if=input.pickBare><@tab><@icon>I</@icon></@tab></if><else><@tab><@icon k="K">J</@icon></@tab></else></Row>',
        "row.mx":
          '<p>${typeof input.tab.icon}:${input.tab.icon.k || "-"}:<${input.tab.icon.content}/></p>',
      };
      expect(await renderFixture(host, files, { pickBare: true })).toBe(
        "<p>object:-:I</p>",
      );
      expect(await renderFixture(host, files, { pickBare: false })).toBe(
        "<p>object:K:J</p>",
      );
    });

    it(`${host}: unifies nested shape across repeated parent occurrences`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@tab><@icon k="K">J</@icon></@tab></Row>',
        "row.mx":
          '<for|tab| of=input.tab><p>${typeof tab.icon}:${tab.icon.k || "-"}:<${tab.icon.content}/></p></for>',
      });
      expect(html).toBe("<p>object:-:I</p><p>object:K:J</p>");
    });

    it(`${host}: unifies nested one-versus-array cardinality`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@tab><@icon>J</@icon><@icon>K</@icon></@tab></Row>',
        "row.mx":
          "<for|tab| of=input.tab><p>${String(Array.isArray(tab.icon))}:<for|icon| of=tab.icon><${icon}/></for></p></for>",
      });
      expect(html).toBe("<p>true:I</p><p>true:JK</p>");
    });

    it(`${host}: keeps nested fallback shape isolated between sibling parent names`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@icon k="1">J</@icon></@card></Row>',
        "row.mx":
          '<p>${String("content" in input.tab.icon)}|${String("content" in input.card.icon)}:${input.card.icon.k}:<${input.tab.icon}/>:<${input.card.icon.content}/></p>',
      });
      expect(html).toBe("<p>false|true:1:I:J</p>");
    });

    it(`${host}: keeps nested fallback cardinality isolated between sibling parent names`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@icon>J</@icon><@icon>K</@icon></@card></Row>',
        "row.mx":
          "<p>${String(Array.isArray(input.tab.icon))}|${String(Array.isArray(input.card.icon))}:<${input.tab.icon}/>:<for|icon| of=input.card.icon><${icon}/></for></p>",
      });
      expect(html).toBe("<p>false|true:I:JK</p>");
    });

    it(`${host}: keeps only each sibling parent's own nested props`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@badge>B</@badge></@card></Row>',
        "row.mx":
          "<p>${typeof input.tab.badge}|${typeof input.card.icon}:<${input.tab.icon}/>:<${input.card.badge}/></p>",
      });
      expect(html).toBe("<p>undefined|undefined:I:B</p>");
    });

    it(`${host}: does not apply a declared sibling's nested shape to an undeclared parent`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.mx"\n<Row><@tab><@icon>I</@icon></@tab><@card><@icon k="1">J</@icon></@card></Row>',
        "row.mx": [
          'export interface Input { tab?: AttrTag<{ attrs: { icon?: AttrTag<{ as: "renderable" }> } }>; [key: string]: unknown }',
          "<const/card=(input.card as any)/>",
          '<p>${String("content" in card.icon)}:${card.icon.k}:<${card.icon.content}/></p>',
        ].join("\n"),
      });
      expect(html).toBe("<p>true:1:J</p>");
    });

    it(`${host}: executes mixed fallback occurrences and parameterized bare tags`, async () => {
      const html = await renderFixture(host, {
        "main.mx":
          'import Row from "./row.tsx"\n<Row><@item>A</@item><@item k="K">B</@item><@action|suffix|>go${suffix}</@action></Row>',
        "row.tsx": [
          "/** @jsxImportSource HOSTJSX */",
          "export default function Row(input: any) {",
          '  return <><p>{typeof input.item[0]}:{input.item[0].k || "-"}:{input.item[0].content}</p><p>{typeof input.item[1]}:{input.item[1].k}:{input.item[1].content}</p><button>{input.action("!")}</button></>;',
          "}",
        ].join("\n"),
      });
      expect(html).toBe(
        "<p>object:-:A</p><p>object:K:B</p><button>go!</button>",
      );
    });

    it(`${host}: rebuilds fallback shape after a transform filters occurrences`, async () => {
      const html = await renderFixture(
        host,
        {
          "main.mx": '<filter><@item>A</@item><@item k="K">B</@item></filter>',
          "filter.mx": "<section><${input.item}/></section>",
        },
        {},
        {
          filter: {
            filename: "filter.mx",
            transform(call, ctx) {
              return ctx.build.template({
                ...call,
                attributeTags: call.attributeTags.slice(0, 1),
              });
            },
          },
        },
      );
      expect(html).toBe("<section>A</section>");
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

  it("react: keys an untyped renderable fallback array without warnings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await renderFixture("react", {
      "main.mx":
        'import Row from "./row.tsx"\n<Row><@slot><b>a</b></@slot><@slot><b>b</b></@slot></Row>',
      "row.tsx": [
        "/** @jsxImportSource react */",
        "export default function Row(input: { slot: unknown }) {",
        "  return <p>{input.slot as never}</p>;",
        "}",
      ].join("\n"),
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

    it(`${host}: renders nothing for a nullish of=/in= attribute tag, matching Marko`, async () => {
      const files = {
        "main.mx":
          'import Row from "./row.mx"\n<Row><for|x| of=input.list><@item>${x}</@item></for><for|k, v| in=input.obj><@item>${k}:${v}</@item></for></Row>',
        "row.mx": dataRow(
          "item: AttrTag[]",
          "<p><for|x| of=input.item>[<${x.content}/>]</for></p>",
        ),
      };
      const html = await renderFixture(host, files, {
        list: undefined,
        obj: null,
      });
      expect(html).toBe("<p></p>");
    });

    it(`${host}: renders nothing for a falsy (non-nullish) of= attribute tag, matching Marko`, async () => {
      const files = {
        "main.mx":
          'import Row from "./row.mx"\n<Row><for|x| of=input.list><@item>${x}</@item></for></Row>',
        "row.mx": dataRow(
          "item: AttrTag[]",
          "<p><for|x| of=input.item>[<${x.content}/>]</for></p>",
        ),
      };
      for (const list of [0, false, Number.NaN, ""]) {
        const html = await renderFixture(host, files, { list });
        expect(html).toBe("<p></p>");
      }
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
    "%s: #propsObject renders dynamic tags with a bare fallback and nested data",
    async (host) => {
      const factories = {
        preact: (props: { head: unknown; children: unknown }) =>
          preactCreateElement(
            "section",
            null,
            props.head as never,
            props.children as never,
          ),
        react: (props: { head: unknown; children: unknown }) =>
          reactCreateElement(
            "section",
            null,
            props.head as never,
            props.children as never,
          ),
        hono: (props: { head: unknown; children: unknown }) =>
          honoCreateElement(
            "section",
            null,
            props.head as never,
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

  it.each(hosts)(
    "%s: a `<define>` call carries its attribute tag through instead of dropping it",
    async (host) => {
      // `<define>` has no declared `Input`, so decision 108's untyped-callee
      // fallback applies: `<@head>` carries no attributes, so `head` arrives
      // renderable (the body itself), read directly with `<${head}/>`.
      const html = await renderFixture(host, {
        "main.mx":
          '<define/Card|title, head|><div>${title}<${head}/></div></define>\n<Card title="a"><@head>H</@head></Card>',
      });
      expect(html).toBe("<div>aH</div>");
    },
  );

  it.each(hosts)(
    "%s: rejects a `<define>` call mixing tag-argument form with an attribute tag",
    async (host) => {
      // `<Card('a')>` passes `title` positionally; adding `<@head>` on top
      // silently dropped `head` before this guard existed (round-2 review
      // finding). Marko itself allows this combination on a `<define>` call
      // (it compiles through the lenient dynamic-tag visitor); MX rejects it
      // as a documented divergence until `define-call-args-with-content`
      // (TODO) implements the lenient shape.
      await expect(
        renderFixture(host, {
          "main.mx":
            "<define/Card|title, head|><div>${title}<${head}/></div></define>\n<Card('a')><@head>H</@head></Card>",
        }),
      ).rejects.toThrow(
        "`<Card>` is a `<define>`; MX does not yet support tag arguments " +
          "together with attributes, attribute tags, or a body on a define " +
          "call (Marko does); pass the values as attributes instead.",
      );
    },
  );
});
