// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A dynamic tag's emitted code on the three JSX hosts: a body passed with tag
 * arguments is emitted once, and a module declares only the dynamic helpers
 * its code calls.
 */
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const HOSTS = ["preact", "react", "hono"] as const;
type Host = (typeof HOSTS)[number];

interface HostCompilers {
  file: typeof compilePreactMx;
  region: typeof compilePreactRegion;
}

async function compilersFor(host: Host): Promise<HostCompilers> {
  if (host === "preact")
    return { file: compilePreactMx, region: compilePreactRegion };
  const url = new URL(`../../${host}/src/index.ts`, import.meta.url).href;
  const module = (await import(/* @vite-ignore */ url)) as Record<
    string,
    unknown
  >;
  const name = host === "react" ? "React" : "Hono";
  return {
    file: module[`compile${name}Mx`] as typeof compilePreactMx,
    region: module[`compile${name}Region`] as typeof compilePreactRegion,
  };
}

const parseTsx = (code: string) =>
  parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });

describe.each(HOSTS)("%s: a dynamic tag's body with tag arguments", (host) => {
  const compile = async (source: string) =>
    (await compilersFor(host)).file(source, "/f/page.mx").code;

  it("is emitted once, bound in place and passed twice", async () => {
    const code = await compile('<${input.t}("a")><p>${input.f()}</p></>');
    expect(code.match(/input\.f\(\)/g)).toHaveLength(1);
    expect(code).toContain(
      '((__mxContent) => __mxDynamic(input.t, ["a", { content: __mxContent }], __mxContent))(() => <><p>',
    );
    expect(() => parseTsx(code)).not.toThrow();
  });

  it("is emitted once with a /var", async () => {
    const code = await compile('<${input.t}("a")/n><p>${input.f()}</p></>${n}');
    expect(code.match(/input\.f\(\)/g)).toHaveLength(1);
    expect(code).toContain(
      'const __mxRet0 = ((__mxContent) => __mxDynamicPair(input.t, ["a", { content: __mxContent }], __mxContent))(() => <><p>',
    );
    expect(() => parseTsx(code)).not.toThrow();
  });
});

/** The dynamic helpers a module declares, in declaration order. */
const declared = (code: string) =>
  [
    ...code.matchAll(
      /^function (__mxIsHostComponentObject|__mxDynamic|__mxDynamicPair)\(/gm,
    ),
  ].map((match) => match[1]);

describe.each(HOSTS)("%s: the dynamic helpers a module declares", (host) => {
  it("a whole file with a dynamic tag and no /var declares no __mxDynamicPair", async () => {
    const code = (await compilersFor(host)).file(
      "<${input.t}/>",
      "/f/page.mx",
    ).code;
    expect(declared(code)).toEqual([
      "__mxIsHostComponentObject",
      "__mxDynamic",
    ]);
  });

  it("a whole file with only a dynamic /var declares all three", async () => {
    const code = (await compilersFor(host)).file(
      "<${input.t}/n/>${n}",
      "/f/page.mx",
    ).code;
    expect(declared(code)).toEqual([
      "__mxIsHostComponentObject",
      "__mxDynamic",
      "__mxDynamicPair",
    ]);
  });

  const regionDefines = async (source: string) =>
    (await compilersFor(host))
      .region(source, { filename: `/f/a.${host}.mx` })
      .hoistedDefines.map((define) => define.binding)
      .filter(
        (binding) => binding.includes("Dynamic") || binding.includes("Host"),
      );

  it("a region with a dynamic tag and no /var hoists no __mxDynamicPair", async () => {
    expect(await regionDefines("<div><${props.t}/></div>")).toEqual([
      "__mxIsHostComponentObject",
      "__mxDynamic",
    ]);
  });

  it("a region with only a dynamic /var hoists all three", async () => {
    expect(await regionDefines("<div><${props.t}/n/>${n}</div>")).toEqual([
      "__mxIsHostComponentObject",
      "__mxDynamic",
      "__mxDynamicPair",
    ]);
  });
});
