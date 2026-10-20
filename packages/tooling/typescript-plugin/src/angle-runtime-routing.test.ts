import { parse, printAst, unknownSourceBindings } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "../../../hosts/astro/src/astro-template.ts";
import {
  compileHonoMx,
  compileHonoRegion,
} from "../../../hosts/hono/src/index.ts";
import {
  compilePreactMx,
  compilePreactRegion,
} from "../../../hosts/preact/src/index.ts";
import {
  compileReactMx,
  compileReactRegion,
} from "../../../hosts/react/src/index.ts";
import {
  compileSolidMx,
  compileSolidUnit,
} from "../../../hosts/solid/src/index.ts";
import { compile as html } from "../../../targets/html/src/index.ts";

const wrappers = [
  "(() => null) as any",
  "(() => null) satisfies any",
  "(() => null)!",
];

describe("preserved callable classification does not change runtime routing", () => {
  for (const [host, compile] of Object.entries({
    html,
    preact: compilePreactMx,
    react: compileReactMx,
    hono: compileHonoMx,
  })) {
    it.each(wrappers)(`${host} retains runtime static routing: %s`, (value) => {
      const source = `static const Foo = ${value};\n<Foo/>`;
      const runtime = compile(source, "/fixtures/callable.mx", {
        typeCheck: false,
      }).code;
      const checked = compile(source, "/fixtures/callable.mx", {
        typeCheck: true,
      }).code;
      expect(runtime).toContain(
        host === "html" ? "__mxRenderDynamic(__mxOut, Foo" : "__mxDynamic(Foo,",
      );
      expect(checked).not.toContain(
        host === "html" ? "__mxRenderDynamic(__mxOut, Foo" : "__mxDynamic(Foo,",
      );
      expect(checked).toContain(
        host === "html" ? "__mxRenderTag(__mxOut, Foo)" : "<Foo",
      );
      const local = `<const/Foo=(${value})/><Foo/>`;
      for (const typeCheck of [false, true]) {
        expect(
          compile(local, "/fixtures/callable.mx", { typeCheck }).code,
        ).toContain(host === "html" ? "__mxRenderTag(__mxOut, Foo)" : "<Foo");
      }
    });
  }

  it.each(wrappers)(
    "keeps Solid and bridge module routing unchanged: %s",
    (value) => {
      const unknown = unknownSourceBindings(`const Foo = ${value};`);
      expect(unknown).toEqual(new Set(["Foo"]));
      expect(
        compileSolidMx("<Foo/>", {
          filename: "/fixtures/callable.solid.mx",
          moduleBindings: new Set(["Foo"]),
          unknownModuleBindings: unknown,
        }).code,
      ).toContain("<Dynamic");
    },
  );

  it.each(wrappers)(
    "keeps Solid unit and region static routing unchanged: %s",
    (value) => {
      const source = `static const Foo = ${value};\n<Foo/>`;
      expect(
        compileSolidUnit(source, {
          filename: "/fixtures/tags/callable.solid.mx",
        }).code,
      ).toContain("<Dynamic");
      expect(() =>
        compileSolidMx(source, { filename: "/fixtures/callable.solid.mx" }),
      ).toThrow(
        "module-level MX statements cannot appear inside a `.solid.mx` expression",
      );
      expect(() =>
        compileSolidMx(`<const/Foo=(${value})/><Foo/>`, {
          filename: "/fixtures/callable.solid.mx",
        }),
      ).toThrow("`<const>` cannot declare a binding inside a JSX expression");
      const moduleSource = `const Foo = ${value};\nconst view = <Foo/>;`;
      const filename = "/fixtures/callable.solid.mx";
      const ast = parse(moduleSource, filename, {
        mxRegionCompile: ({ source, ...options }) =>
          compileSolidMx(source, options),
      });
      expect(printAst(ast, filename).code).toContain("<Dynamic");
    },
  );

  it.each(wrappers)("keeps Astro template routing unchanged: %s", (value) => {
    expect(() =>
      lowerAstroMx(
        `static const Foo = ${value};\n<Foo/>`,
        "/fixtures/callable.astro.mx",
      ),
    ).toThrow(
      "`<Foo>` is bound in the frontmatter to a value MX can't prove is a component",
    );
  });

  for (const [host, region, compile] of [
    ["preact", compilePreactRegion, compilePreactMx],
    ["react", compileReactRegion, compileReactMx],
    ["hono", compileHonoRegion, compileHonoMx],
  ] as const) {
    it.each([
      ['({color: "red"} as any)', '("id" as any)'],
      ['({color: "red"} satisfies object)', '("id" satisfies string)'],
      ['({color: "red"}!)', '("id"!)'],
      ['(<any>{color: "red"})', '(<any>"id")'],
    ])(
      `${host} gates wrapper validation and key emission on projection: %s`,
      (style, key) => {
        const filename = `/fixtures/callable.${host}.mx`;
        const markup = `<p style=${style}/>`;
        expect(() => region(markup, { filename })).toThrow(
          "`style=` takes an object literal",
        );
        expect(
          compile(markup, "/fixtures/callable.mx", { typeCheck: true }).code,
        ).toContain("style={");
        const loop = `<for|row| of=input.list by=${key}><p/></for>`;
        const runtime = region(loop, { filename }).code;
        expect(runtime).toContain(`key={(${key.slice(1, -1)})(row)}`);
        expect(runtime).not.toContain("void (");
        const checked = compile(loop, "/fixtures/callable.mx", {
          typeCheck: true,
        }).code;
        expect(checked).toContain("void (");
        expect(checked).toContain("row.id");
        expect(() =>
          region(`<for|k| in=input.obj by=${key}><p/></for>`, { filename }),
        ).not.toThrow();
        expect(() =>
          compile(
            `<for|k| in=input.obj by=${key}><p/></for>`,
            "/fixtures/callable.mx",
            { typeCheck: true },
          ),
        ).toThrow("only supports a string `by` key with `of`");
      },
    );
  }

  it("keeps wrapped colon-attribute functions opaque on every runtime fragment path", () => {
    const source = "<p foo:bar=((() => 1) as any)/>";
    for (const [host, region] of [
      ["preact", compilePreactRegion],
      ["react", compileReactRegion],
      ["hono", compileHonoRegion],
    ] as const) {
      expect(
        region(source, { filename: `/fixtures/colon.${host}.mx` }).code,
      ).toContain("__mxAttrValue(");
    }
    expect(
      compileSolidMx(source, { filename: "/fixtures/colon.solid.mx" }).code,
    ).toContain("__mxAttrValue(");
    expect(
      compileSolidUnit(source, { filename: "/fixtures/tags/colon.solid.mx" })
        .code,
    ).toContain("__mxAttrValue(");
    expect(lowerAstroMx(source, "/fixtures/colon.astro.mx").code).toContain(
      "__mxAttrValue(",
    );
  });

  it("keeps React region spread-style validation opaque at runtime", () => {
    const source = '<p ...({style: ("a" as any)})/>';
    expect(
      compileReactRegion(source, { filename: "/fixtures/callable.react.mx" })
        .code,
    ).toContain("style:");
    expect(() =>
      compileReactMx(source, "/fixtures/callable.mx", { typeCheck: true }),
    ).toThrow("`style` in a spread must be an object on React");
  });

  it.each(wrappers)("keeps Astro fence routing unchanged: %s", (value) => {
    expect(() =>
      lowerAstroMx(
        `---\nconst Foo = ${value};\n---\n<Foo/>`,
        "/fixtures/callable.astro.mx",
      ),
    ).toThrow(
      "`<Foo>` is bound in the frontmatter to a value MX can't prove is a component",
    );
  });
});
