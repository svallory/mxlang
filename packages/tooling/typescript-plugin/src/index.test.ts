import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToTSX } from "@astrojs/compiler/sync";
import { decode } from "@jridgewell/sourcemap-codec";
import {
  type CustomTag,
  clearScanCache,
  type TemplateBackedTag,
} from "@mxlang/core";
import { print } from "@mxlang/parser";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  AMX_LANGUAGE_ID,
  composeAmxMappings,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
import { createAstroLanguagePlugin } from "./astro-language.ts";
import pluginFactory, { createConfiguredLanguagePlugins } from "./index.ts";
import {
  createSolidMxLanguagePlugin,
  decodeMappings,
  SOLID_MX_LANGUAGE_ID,
} from "./language.ts";
import {
  createAstroTypeSurface,
  createHtmlMappings,
  createMxLanguagePlugin,
  MX_LANGUAGE_ID,
} from "./mx-language.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("SolidMX language plugin", () => {
  it("puts a discovered tag's hoisted import in the virtual file", () => {
    const plugin = createSolidMxLanguagePlugin(ts);
    const fileName = `${here}/fixtures/solid-tags/page.solid.mx`;
    const source = `const a = <div><icon name="star"/></div>;\n`;
    const virtual = plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    if (!virtual) throw new Error("Expected SolidMX virtual code");
    const code = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    // A region is an expression, so the import the compiler minted for
    // `<icon>` belongs to the surrounding module. If it does not reach the
    // virtual file the editor reports an unresolved binding on a file that
    // builds fine — the two disagreeing is the whole failure mode.
    expect(code).toMatch(/import \$mx_Icon\d+ from "\.\/tags\/icon\.mx"/);
    const binding = code.match(/import (\$mx_Icon\d+)/)?.[1];
    expect(code).toContain(`<${binding}`);
  });

  it("recognizes .solid.mx and exposes a TSX service script", () => {
    const plugin = createSolidMxLanguagePlugin(ts);
    const source = "export const answer: number = 42;\n";
    const virtual = plugin.createVirtualCode?.(
      "/src/example.solid.mx",
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(plugin.getLanguageId("/src/example.solid.mx")).toBe("solidmx");
    expect(plugin.getLanguageId("/src/example.tsx")).toBeUndefined();
    if (!virtual) throw new Error("Expected SolidMX virtual code");
    expect(virtual?.languageId).toBe("typescriptreact");
    expect(virtual?.snapshot.getText(0, virtual.snapshot.getLength())).toBe(
      "export const answer: number = 42;",
    );
    expect(virtual?.mappings.length).toBeGreaterThan(0);
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {
        extension: "solid.mx",
        isMixedContent: false,
        scriptKind: ts.ScriptKind.TSX,
      },
    ]);
    expect(plugin.typescript?.getServiceScript(virtual)).toMatchObject({
      code: virtual,
      extension: ".tsx",
      scriptKind: ts.ScriptKind.TSX,
      preventLeadingOffset: true,
    });
  });

  it("decodes the printer source map into feature-enabled mappings", () => {
    const source = "const el = <button title=value()>ok</button>;\n";
    const printed = print(source, "mapping.solid.mx");

    const mappings = decodeMappings(printed.map, printed.code, source);

    expect(decode(printed.map.mappings).flat().length).toBeGreaterThan(0);
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings.every((mapping) => mapping.data.verification)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.completion)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.semantic)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.navigation)).toBe(true);
  });

  it("returns empty virtual code and records one positioned syntax error", () => {
    const plugin = createSolidMxLanguagePlugin(ts);
    const fileName = "/src/broken.solid.mx";
    const source = "const el = <button>oops;\n";
    const virtual = plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(virtual?.snapshot.getLength()).toBe(0);
    expect(virtual?.mappings).toEqual([]);
    expect(plugin.getSyntaxError(fileName)).toMatchObject({
      fileName,
      offset: source.indexOf("<button"),
      source,
    });
    expect(plugin.getSyntaxError(fileName)?.message).toContain(
      "Missing ending",
    );
  });

  it("reports a bridge syntax error once through tsserver diagnostics", () => {
    const fileName = "/project/broken.solid.mx";
    const consumer = "/project/index.ts";
    const source = "const el = <button>oops;\n";
    const service = createPluginService(
      {
        [fileName]: source,
        [consumer]: 'import "./broken.solid.mx";\n',
      },
      [consumer],
    );

    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSyntacticDiagnostics(fileName);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      start: source.indexOf("<button"),
      source: "solidmx",
      code: 80001,
      category: ts.DiagnosticCategory.Error,
    });
    expect(String(diagnostics[0]?.messageText)).toContain("Missing ending");
  });

  it("resolves and types a .solid.mx import from a TypeScript file", () => {
    const component = "/project/Counter.solid.mx";
    const consumer = "/project/index.ts";
    const service = createPluginService(
      {
        [component]: [
          "export function Counter(props: { start: number }) {",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: SolidMX placeholder syntax
          "  return <button>${props.start}</button>;",
          "}",
        ].join("\n"),
        [consumer]: [
          'import { Counter } from "./Counter.solid.mx";',
          'Counter({ start: "wrong" });',
        ].join("\n"),
      },
      [consumer],
    );

    const diagnostics = service.getSemanticDiagnostics(consumer);

    expect(diagnostics.some((diagnostic) => diagnostic.code === 2307)).toBe(
      false,
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 2322,
          start: expect.any(Number),
        }),
      ]),
    );
  });

  it("maps an inline MX attribute-method type error to its exact column", () => {
    const component = "/project/Column.solid.mx";
    const consumer = "/project/index.ts";
    const expression = 'count() + "x"';
    const source = [
      "function setCount(value: number) {}",
      "const count = () => 0;",
      `export const el = <button onClick() { setCount(${expression}) }>x</button>;`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./Column.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(component);
    const diagnostic = diagnostics.find((candidate) => candidate.code === 2345);

    expect(diagnostic?.start).toBe(source.indexOf(expression));
    expect(diagnostic?.length).toBe(expression.length);
  });

  it("maps an expression on the MX region's first line after the opening tag", () => {
    const component = "/project/FirstLine.solid.mx";
    const consumer = "/project/index.ts";
    const expression = '"bad"';
    const source = [
      "function needsNumber(value: number) { return value; }",
      `export const el = <button title=needsNumber(${expression})>x</button>;`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./FirstLine.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(component);
    const diagnostic = diagnostics.find((candidate) => candidate.code === 2345);

    expect(diagnostic?.start).toBe(source.indexOf(expression));
    expect(diagnostic?.length).toBe(expression.length);
  });
  it("keeps type arguments when rewriting bound identifiers", () => {
    const plugin = createSolidMxLanguagePlugin(ts);
    const source =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "export default function () { return <for|item| of=xs><p>${pick<string>(item)}</p></for>; }";
    const virtual = plugin.createVirtualCode?.(
      "/src/example.solid.mx",
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected SolidMX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain("pick<string>(item)");
  });
});

describe("MX language plugin", () => {
  it("recognizes .mx and exposes a TypeScript service script", () => {
    const plugin = createMxLanguagePlugin(ts);
    const source = [
      "export interface Input { title: string }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<h1>${input.title}</h1>",
    ].join("\n");
    const virtual = plugin.createVirtualCode?.(
      "/src/card.mx",
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(plugin.getLanguageId("/src/card.mx")).toBe("mx");
    expect(plugin.getLanguageId("/src/card.marko")).toBeUndefined();
    expect(plugin.getLanguageId("/src/card.solid.mx")).toBeUndefined();
    expect(plugin.getLanguageId("/src/card.ts")).toBeUndefined();
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(virtual.languageId).toBe("typescript");
    expect(generated).toContain("export interface Input { title: string }");
    expect(generated).toContain("function render(input: Input): string");
    expect(generated).toContain("out += escape(input.title)");
    expect(virtual.mappings.length).toBeGreaterThan(0);
    // TSX, not TS, for every host. The Preact host emits a component module
    // whose body is JSX; parsed as plain TS its `return (<>…)` is a syntax
    // error, which surfaced not as a parse error anyone could read but as the
    // module appearing to have no exports at all ("File '…/Counter.mx' is not
    // a module"). TSX is a superset for the JSX-free output of the other
    // hosts, whose one narrowing — `<T>x` as a type assertion — none of them
    // emits.
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {
        extension: "mx",
        isMixedContent: false,
        scriptKind: ts.ScriptKind.TSX,
      },
    ]);
    const serviceScript = plugin.typescript?.getServiceScript(virtual);
    expect(serviceScript).toMatchObject({
      code: virtual,
      extension: ".tsx",
      scriptKind: ts.ScriptKind.TSX,
    });
    // `preventLeadingOffset` must stay unset for whole-file MX. With it set,
    // Volar's `runTsc` builds its `SourceFile` from the generated text alone,
    // so `tsc` renders a correctly mapped source offset against the
    // *generated* file's line table — every diagnostic in a `.mx` file came
    // out on the wrong line and column. Leaving it unset makes Volar pad the
    // virtual contents to the source's own line structure, which is what keeps
    // the reported line/column the author's own. `.solid.mx` is unaffected
    // either way because its printed output preserves the source's lines.
    expect(serviceScript?.preventLeadingOffset).toBeUndefined();
  });

  it("builds exact expression mappings from positioned HTML IR", () => {
    const source = [
      "export interface Input { count: number }",
      "static function needsNumber(value: number) { return value; }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      '<p>before ${needsNumber(input.count + "x")} after</p>',
    ].join("\n");
    const plugin = createMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      "/src/column.mx",
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    const mappings = createHtmlMappings(
      source,
      "/src/column.mx",
      generated,
      false,
    );
    const expression = 'needsNumber(input.count + "x")';
    const mapping = mappings.find(
      (candidate) => candidate.sourceOffsets[0] === source.indexOf(expression),
    );

    expect(mapping).toMatchObject({
      sourceOffsets: [source.indexOf(expression)],
      generatedOffsets: [generated.indexOf(expression)],
      lengths: [expression.length],
    });
  });

  it("keeps duplicate expression mappings on their own forward occurrences", () => {
    const expression = "input.count";
    const source = [
      "export interface Input { count: number }",
      `<p title=${expression}>${"${"}${expression}} ${"${"}${expression}}</p>`,
    ].join("\n");
    const plugin = createMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      "/src/duplicates.mx",
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    const mappings = createHtmlMappings(
      source,
      "/src/duplicates.mx",
      generated,
      false,
    ).filter(
      (mapping) =>
        source.slice(
          mapping.sourceOffsets[0],
          (mapping.sourceOffsets[0] ?? 0) + (mapping.lengths[0] ?? 0),
        ) === expression,
    );
    const sourceOffsets = [...source.matchAll(/input\.count/g)].map(
      (match) => match.index,
    );

    expect(mappings.map((mapping) => mapping.sourceOffsets[0])).toEqual(
      sourceOffsets,
    );
    expect(mappings.map((mapping) => mapping.generatedOffsets[0])).toEqual(
      [...mappings]
        .map((mapping) => mapping.generatedOffsets[0])
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    );
    expect(
      mappings.every(
        (mapping) =>
          generated.slice(
            mapping.generatedOffsets[0],
            (mapping.generatedOffsets[0] ?? 0) + (mapping.lengths[0] ?? 0),
          ) === expression,
      ),
    ).toBe(true);
  });

  it("gives the second lowering the same custom tags as compilation", () => {
    const fileName = "/project/custom.mx";
    const source = "<icon value=input.answer/>\n";
    const customTags: Record<string, CustomTag> = {
      icon: {
        attributes: { value: {} },
        transform(call, ctx) {
          const value = call.attrs.find(
            (attr) => attr.kind !== "spread" && attr.name === "value",
          );
          if (!value) throw ctx.fail("requires `value`");
          return [ctx.build.element("span", [value])];
        },
      },
    };
    const plugin = createMxLanguagePlugin(ts, { customTags });
    const virtual = plugin.createVirtualCode?.(
      fileName,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");

    expect(plugin.getSyntaxError(fileName)).toBeUndefined();
    expect(
      virtual.mappings.some(
        (mapping) =>
          mapping.sourceOffsets[0] === source.indexOf("input.answer"),
      ),
    ).toBe(true);
  });

  describe("custom tag discovery", () => {
    const scratches: string[] = [];

    afterEach(() => {
      clearScanCache();
      for (const dir of scratches.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function project(sidecar: string) {
      const dir = mkdtempSync(join(tmpdir(), "mx-tsplugin-tags-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"t","mx":{"host":"html"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      writeFileSync(join(dir, "tags", "thing.tag.ts"), sidecar);
      return { dir, caller: join(dir, "caller.mx") };
    }

    it("resolves a tag discovered beside the file, with no options", () => {
      // No `customTags` is passed: `mx-tsc` and the tsserver plugin both build
      // this plugin with none, so discovery per file is the only thing that
      // can make a `tags/` directory reachable from either.
      const { caller } = project(
        "export default { transform: (_c, ctx) => [ctx.build.element('span', [], [ctx.build.text('ok')])] };\n",
      );
      const source = "<thing/>\n";
      const plugin = createMxLanguagePlugin(ts);

      const virtual = plugin.createVirtualCode?.(
        caller,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );
      if (!virtual) throw new Error("Expected MX virtual code");

      // A file that fails to compile yields empty virtual code plus a recorded
      // syntax error, so both assertions together are the proof.
      expect(plugin.getSyntaxError(caller)).toBeUndefined();
      expect(
        virtual.snapshot.getText(0, virtual.snapshot.getLength()),
      ).toContain("ok");
    });

    it("reports a broken sidecar as a syntax error naming that file", () => {
      const { caller } = project(
        [
          "const shared = { text: true };",
          "export default { parseOptions: shared };",
        ].join("\n"),
      );
      const plugin = createMxLanguagePlugin(ts);

      plugin.createVirtualCode?.(
        caller,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString("<thing/>\n"),
        { getAssociatedScript: () => undefined },
      );

      // Surfaced through the plugin's own diagnostic channel rather than
      // thrown, so one bad sidecar does not blank out the whole project.
      expect(plugin.getSyntaxError(caller)?.message).toContain("thing.tag.ts");
    });

    it("resolves a discovered tag in an .amx page too", () => {
      // `createAmxLanguagePlugin` lowered with no options while
      // `@mxlang/astro`'s Vite plugin passed `{ customTags }`, so a tag that
      // compiled under `astro build` was an unknown tag in the editor and
      // under `mx-tsc --astro` — the asymmetry already closed for
      // `.solid.mx`.
      const dir = mkdtempSync(join(tmpdir(), "mx-amx-tags-"));
      scratches.push(dir);
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"a","mx":{"host":"astro"}}',
      );
      mkdirSync(join(dir, "tags"), { recursive: true });
      writeFileSync(
        join(dir, "tags", "stamp.tag.ts"),
        "export default { transform: (_c, ctx) => [ctx.build.text('stamped')] };\n",
      );

      const amx = join(dir, "page.amx");
      const source = "---\n---\n<stamp/>\n";
      const plugin = createAmxLanguagePlugin(ts);
      const virtual = plugin.createVirtualCode?.(
        amx,
        AMX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );
      if (!virtual) throw new Error("Expected AMX virtual code");

      expect(plugin.getSyntaxError(amx)).toBeUndefined();
      expect(
        virtual.snapshot.getText(0, virtual.snapshot.getLength()),
      ).toContain("stamped");
    });

    it("gives the second lowering the discovered tags too", () => {
      // `createHtmlMappings` lowers the same source again; without the same
      // map the file gets *no* mappings at all, not merely none inside the
      // expansion (spec §4's TS-plugin note).
      const { caller } = project(
        "export default { transform: (call, ctx) => [ctx.build.element('span', call.attrs)] };\n",
      );
      const source = "<thing value=input.answer/>\n";
      const plugin = createMxLanguagePlugin(ts);

      const virtual = plugin.createVirtualCode?.(
        caller,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );
      if (!virtual) throw new Error("Expected MX virtual code");

      expect(
        virtual.mappings.some(
          (mapping) =>
            mapping.sourceOffsets[0] === source.indexOf("input.answer"),
        ),
      ).toBe(true);
    });
  });

  it.each([
    ["html", "/src/component.mx", true],
    ["preact", `${here}/fixtures/preact-policy/component.mx`, true],
    ["solid", `${here}/fixtures/solid-policy/component.mx`, false],
  ])(
    "maps component tag, attribute, and attribute-tag names for the %s host",
    (_host, fileName, needsImport) => {
      const markup = "<Card title=1><@footer>ok</@footer></Card>";
      const source = needsImport
        ? `import Card from "./Card.mx"\n${markup}`
        : markup;
      const plugin = createMxLanguagePlugin(ts);
      const virtual = plugin.createVirtualCode?.(
        fileName,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );
      if (!virtual) throw new Error("Expected MX virtual code");
      const generated = virtual.snapshot.getText(
        0,
        virtual.snapshot.getLength(),
      );

      for (const [name, sourceOffset] of [
        ["Card", source.indexOf("<Card") + 1],
        ["title", source.indexOf("title")],
        ["footer", source.indexOf("@footer") + 1],
      ] as const) {
        const mapping = virtual.mappings.find(
          (candidate) => candidate.sourceOffsets[0] === sourceOffset,
        );
        expect(mapping, `${_host}:${name}`).toBeDefined();
        const generatedLength =
          mapping?.generatedLengths?.[0] ?? mapping?.lengths[0] ?? 0;
        expect(
          generated.slice(
            mapping?.generatedOffsets[0] ?? 0,
            (mapping?.generatedOffsets[0] ?? 0) + generatedLength,
          ),
        ).toBe(name);
      }
    },
  );

  it("uses the nearest package.json host and Astro strictness", () => {
    const astroFile = `${here}/fixtures/astro-policy/card.mx`;
    const solidFile = `${here}/fixtures/solid-policy/card.mx`;
    const plugin = createMxLanguagePlugin(ts);
    const astroSource = "<let/count=0/>";
    const astroValidSource = [
      "export interface Input { title: string; content: () => string }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<h1>${input.title}</h1>",
    ].join("\n");
    const solidSource = "<button title=count>count</button>";
    const astroVirtual = plugin.createVirtualCode?.(
      astroFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(astroSource),
      { getAssociatedScript: () => undefined },
    );
    const solidVirtual = plugin.createVirtualCode?.(
      solidFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(solidSource),
      { getAssociatedScript: () => undefined },
    );

    expect(astroVirtual?.snapshot.getLength()).toBe(0);
    expect(plugin.getSyntaxError(astroFile)?.message).toContain(
      "strict policy",
    );
    const astroValidVirtual = plugin.createVirtualCode?.(
      astroFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(astroValidSource),
      { getAssociatedScript: () => undefined },
    );
    expect(
      astroValidVirtual?.snapshot.getText(
        0,
        astroValidVirtual.snapshot.getLength(),
      ),
    ).toContain('Omit<Input, "content"> & { children?: unknown }');
    expect(
      solidVirtual?.snapshot.getText(0, solidVirtual.snapshot.getLength()),
    ).toContain("<button title={count}>count</button>");
  });

  it("compiles a whole-file .mx through the Preact host", () => {
    // `createMxLanguagePlugin`'s preact branch, mirroring the html/astro/solid
    // cases above. Its only other coverage is `@mxlang/tsc`'s end-to-end
    // `mx-tsc` run, which cannot see this package's own virtual-code shape.
    const preactFile = `${here}/fixtures/preact-policy/card.mx`;
    const plugin = createMxLanguagePlugin(ts);
    const source = [
      "export interface Input { title: string }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<h1>${input.title}</h1>",
    ].join("\n");
    const virtual = plugin.createVirtualCode?.(
      preactFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    // The Preact host's own module shape, not the string host's.
    expect(generated).toContain("/** @jsxImportSource preact */");
    expect(generated).toContain("export default function (props: Input) {");
    expect(generated).toContain("<h1>{input.title}</h1>");
    expect(generated).not.toContain("let out =");
    expect(virtual.mappings.length).toBeGreaterThan(0);
    expect(plugin.getSyntaxError(preactFile)).toBeUndefined();
  });

  it("compiles a whole-file .mx through the React host", () => {
    const reactFile = `${here}/fixtures/react-policy/card.mx`;
    const plugin = createMxLanguagePlugin(ts);
    const source = [
      "export interface Input { title: string }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      '<label class="title" for="title">${input.title}</label>',
    ].join("\n");
    const virtual = plugin.createVirtualCode?.(
      reactFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain("/** @jsxImportSource react */");
    expect(generated).toContain(
      '<label className="title" htmlFor="title">{input.title}</label>',
    );
    expect(virtual.mappings.length).toBeGreaterThan(0);
    expect(plugin.getSyntaxError(reactFile)).toBeUndefined();
  });

  it("compiles a whole-file .mx through the Hono host", () => {
    const honoFile = `${here}/fixtures/hono-policy/card.mx`;
    const plugin = createMxLanguagePlugin(ts);
    const source = [
      "export interface Input { title: string }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      '<label class="title" for="title">${input.title}</label>',
    ].join("\n");
    const virtual = plugin.createVirtualCode?.(
      honoFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain("/** @jsxImportSource hono/jsx */");
    expect(generated).toContain(
      '<label class="title" for="title">{input.title}</label>',
    );
    expect(virtual.mappings.length).toBeGreaterThan(0);
    expect(plugin.getSyntaxError(honoFile)).toBeUndefined();
  });

  it("reports the angular host as not wired in yet, rather than falling through to html", () => {
    const angularFile = `${here}/fixtures/angular-policy/card.mx`;
    const plugin = createMxLanguagePlugin(ts);
    const source = ["<div>hi</div>"].join("\n");
    plugin.createVirtualCode?.(
      angularFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    const syntaxError = plugin.getSyntaxError(angularFile);
    expect(syntaxError?.message).toContain(
      "the angular host is not wired into @mxlang/typescript-plugin yet",
    );
  });

  it("parses `<` comparisons and generic calls in the virtual TSX", () => {
    // The regression the TSX script kind could plausibly have introduced: in
    // TSX, `<T>x` is JSX rather than a type assertion. It does not reach a
    // host's output (every host emits `x as T`), but `a < b` and a generic
    // call sit in ordinary expression positions that any template may carry,
    // and TypeScript's call-position disambiguation has to resolve
    // `fn<string>("x")` as a call rather than as an element.
    const preactFile = `${here}/fixtures/preact-policy/compare.mx`;
    const plugin = createMxLanguagePlugin(ts);
    // `pick` arrives by import rather than being declared here: Marko's own
    // parser reads the `<` that opens a type-parameter list as a tag, so
    // *declaring* a generic in a `static` block is a parse error before any
    // host sees it. The generic **call site** in the template is what this
    // test is about, and it is unaffected.
    const source = [
      'import { pick } from "./pick.ts";',
      "export interface Input { a: number; b: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<p>${input.a < input.b ? pick<string>('lo') : pick<string>('hi')}</p>",
    ].join("\n");
    const virtual = plugin.createVirtualCode?.(
      preactFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    if (!virtual) throw new Error("Expected MX virtual code");
    expect(plugin.getSyntaxError(preactFile)).toBeUndefined();
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());

    // Parsed as the service actually parses it — TSX — with no diagnostics.
    const parsed = ts.createSourceFile(
      "generated.tsx",
      generated,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX,
    );
    const parseDiagnostics = (
      parsed as unknown as { parseDiagnostics?: unknown[] }
    ).parseDiagnostics;
    expect(parseDiagnostics ?? []).toHaveLength(0);
    expect(generated).toContain("input.a < input.b");
    // The generic call is emitted as a call. Its *type argument* survives the
    // core's expression printer — `pick<string>('lo')` prints as
    // `pick<string>('lo')`.
    expect(generated).toContain("pick<string>('lo')");
    expect(generated).toContain("pick<string>('hi')");

    // A `<` comparison maps back to its own position in the `.mx` source, so
    // a diagnostic on it is reported against the line the author wrote. The
    // mapped unit is the whole placeholder expression, which is what the
    // core's IR carries a position for — not the `input.a < input.b`
    // sub-span. (An expression whose *source* spelling carries a type
    // argument maps nowhere, since the printer's erasure means the code
    // cannot be found in both texts and the builder emits nothing rather
    // than a wrong column — a consequence of the same pre-existing erasure,
    // pinned by the sibling test below.)
    const plain = [
      "export interface Input { a: number; b: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<p>${input.a < input.b ? 'lo' : 'hi'}</p>",
    ].join("\n");
    const plainVirtual = plugin.createVirtualCode?.(
      `${here}/fixtures/preact-policy/plain.mx`,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(plain),
      { getAssociatedScript: () => undefined },
    );
    const mapped = (plainVirtual?.mappings ?? []).map((mapping) =>
      plain.slice(
        mapping.sourceOffsets[0] ?? 0,
        (mapping.sourceOffsets[0] ?? 0) + (mapping.lengths[0] ?? 0),
      ),
    );
    expect(mapped).toContain("input.a < input.b ? 'lo' : 'hi'");
  });

  it("reports an MX compile error once through tsserver diagnostics", () => {
    const fileName = "/project/broken.mx";
    const consumer = "/project/index.ts";
    const source = "<await=value>oops</await>";
    const service = createPluginService(
      {
        [fileName]: source,
        [consumer]: 'import "./broken.mx";\n',
      },
      [consumer],
    );

    service.getSemanticDiagnostics(consumer);
    const diagnostics = service.getSyntacticDiagnostics(fileName);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      start: source.indexOf("<await"),
      source: "mx",
      code: 80001,
      category: ts.DiagnosticCategory.Error,
    });
  });

  it("maps a type error amid other text to its source expression column", () => {
    const component = "/project/Column.mx";
    const consumer = "/project/index.ts";
    const expression = 'input.count + "x"';
    const source = [
      "export interface Input { count: number }",
      "static function needsNumber(value: number) { return value; }",
      `<p>before ${"${"}needsNumber(${expression})} after</p>`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./Column.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostic = service
      .getSemanticDiagnostics(component)
      .find((candidate) => candidate.code === 2345);

    expect(diagnostic?.start).toBe(source.indexOf(expression));
    expect(diagnostic?.length).toBe(expression.length);
  });

  it("maps a static-block type error through the real plugin service", () => {
    const component = "/project/StaticError.mx";
    const consumer = "/project/index.ts";
    const source = [
      "export interface Input { title: string }",
      'static const bogus: number = "not a number";',
      `<h1>${"${"}input.title}</h1>`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./StaticError.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostic = service
      .getSemanticDiagnostics(component)
      .find((candidate) => candidate.code === 2322);

    // TypeScript anchors an assignability error on a declaration's *name*, not
    // on the offending initializer, so the mapping must land on `bogus` — the
    // whole point being that it lands inside the `static` block at all rather
    // than being dropped for want of a mapping.
    expect(diagnostic?.start).toBe(source.indexOf("bogus"));
    expect(diagnostic?.length).toBe("bogus".length);
  });

  it("maps a type error inside a generic call and type assertion in an interpolation", () => {
    const component = "/project/Generic.mx";
    const consumer = "/project/index.ts";
    const pickModule = "/project/pick.ts";
    // `pick` arrives by import rather than being declared here: Marko's own
    // parser reads the `<` that opens a type-parameter list as a tag, so
    // *declaring* a generic in a `static` block is a parse error before any
    // host sees it (see "parses `<` comparisons and generic calls in the
    // virtual TSX" above). The generic **call site** in the template is what
    // this test is about, and it is unaffected.
    //
    // Only the `${...}` interpolation site is asserted here. The brief asked
    // for one test per expression site (interpolation, attribute value,
    // `<if>` condition, `<for>` iterable, attribute method body); the other
    // four sites are covered — as pre-existing gaps, not as passing cases —
    // by the two tests below, plus this task's report.
    const source = [
      'import { pick } from "./pick.ts";',
      "export interface Input { title: string }",
      `<p>${"${"}pick<string>(1 as number)}</p>`,
    ].join("\n");
    const service = createPluginService(
      {
        [component]: source,
        [consumer]: 'import "./Generic.mx";\n',
        [pickModule]: "export function pick<T>(val: T): T { return val; }\n",
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(component);
    // TypeScript diagnostic 2345: Argument of type 'number' is not assignable to parameter of type 'string'.
    const typeError = diagnostics.find((candidate) => candidate.code === 2345);

    expect(typeError?.start).toBe(source.indexOf("1 as number"));
  });

  it("documents a pre-existing gap: a bare generic call outside an interpolation misparses as a comparison", () => {
    // Not introduced by this task's change (reproduced identically against
    // `main`, before this task's core.ts edit, via a direct `@marko/compiler`
    // AST probe). Only a `${...}`-wrapped expression is parsed as an ordinary
    // JS/TS expression; an attribute value, an `<if>` condition and a `<for>`
    // iterable are parsed through a different path that does not enable the
    // TypeScript plugin the same way, so `pick<string>(x)` there is read as
    // `(pick < string) > x` — a `BinaryExpression`, never a `CallExpression`
    // with `typeParameters`. There is no core seam to intercept this: the
    // wrong tree is what Marko hands the resolver, before any host or the
    // slice-based printer this task added ever sees the node. Fixing it would
    // mean changing `@marko/compiler`'s own attribute-value/condition/iterable
    // parsing, out of this task's scope (`packages/core/src/**`).
    // biome-ignore lint/suspicious/noExplicitAny: probing Marko's internal AST shape, not this package's types
    const compileSync: (source: string, filename: string, opts: any) => void =
      createRequire(import.meta.url)("@marko/compiler").compileSync;
    let valueType: string | undefined;
    compileSync("<if=pick<string>(3 as number)>x</if>", "gap.mx", {
      output: "html",
      translator: {
        taglibs: [],
        tagDiscoveryDirs: [],
        translate: {
          Program: {
            // biome-ignore lint/suspicious/noExplicitAny: Marko's internal Babel path type
            exit(path: any) {
              path.traverse({
                // biome-ignore lint/suspicious/noExplicitAny: Marko's internal Babel path type
                MarkoTag(tagPath: any) {
                  if (tagPath.node.name?.value !== "if") return;
                  valueType = tagPath.node.attributes[0]?.value?.type;
                },
              });
            },
          },
        },
      },
    });

    expect(valueType).toBe("BinaryExpression");
  });

  it("documents the one site that cannot keep type arguments: an attribute method's synthesized function wrapper", () => {
    // Marko builds the attribute-method shorthand's `FunctionExpression` node
    // itself (there is no literal `function (…) { … }` in the source), so it
    // carries no `start`/`end`/`loc` at all — confirmed by walking the parsed
    // tree directly. `expr()` in packages/core/src/core.ts therefore takes its
    // synthetic-node fallback (`ctx.generate(node)`) rather than the slice,
    // and the underlying AST's `typeParameters` is already `null` (Marko's own
    // `stripTypes` pass erases it before any host sees the tree — see
    // packages/core/README.md and this task's report). There is no source
    // range to slice and no AST field left to print: a generic call written
    // inside an attribute-method body cannot keep its type arguments through
    // this printer.
    //
    // Preact accepts attribute methods (`resolveAttributeMethod: () => true`
    // in packages/hosts/preact/src/emitter.ts); the default host does not, so
    // this uses the `preact-policy` fixture directory the way the two tests
    // above do, rather than `/project` (default host).
    const preactFile = `${here}/fixtures/preact-policy/generic-method.mx`;
    const source = [
      'import { pick } from "./pick.ts";',
      "export interface Input { title: string }",
      "<div onClick() { pick<string>(5); } />",
    ].join("\n");
    const virtual = createMxLanguagePlugin(ts).createVirtualCode?.(
      preactFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    // `pick(5)` still type-checks (`T` is inferred as `number`), so this test
    // pins the printed output, not a diagnostic.
    expect(generated).toContain("pick(5)");
    expect(generated).not.toContain("pick<string>(5)");
  });
});

describe("Astro language plugin composition", () => {
  it("loads Astro's language plugin when astro is true", () => {
    const plugins = createConfiguredLanguagePlugins(ts, true);

    expect(
      plugins.some(
        (plugin) => plugin.getLanguageId("/project/src/page.astro") === "astro",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (plugin) =>
          plugin.getLanguageId?.("/project/src/page.amx") === "astromx",
      ),
    ).toBe(true);
  });

  it("does not load Astro's language plugin when astro is false", () => {
    let loaded = false;
    const plugins = createConfiguredLanguagePlugins(ts, false, () => {
      loaded = true;
      throw new Error("should not load");
    });

    expect(loaded).toBe(false);
    expect(
      plugins.some(
        (plugin) => plugin.getLanguageId("/project/src/page.astro") === "astro",
      ),
    ).toBe(false);
    expect(
      plugins.some(
        (plugin) =>
          plugin.getLanguageId?.("/project/src/page.amx") === "astromx",
      ),
    ).toBe(false);
  });

  it("explains how to install the missing optional Astro peer", () => {
    expect(() =>
      createAstroLanguagePlugin(() => {
        throw new Error("Cannot find module");
      }),
    ).toThrowError(
      "@mxlang/typescript-plugin: `astro: true` requires the optional peer dependency `@astrojs/language-server@2.16.16`; install it beside the plugin.",
    );
  });

  // An `.astro` file inside a dependency is Astro's own package-owned
  // component source, not the consumer's code: associating it keeps imports
  // resolvable without `mx-tsc` reporting diagnostics for files the user
  // cannot edit. Both separator styles are covered because the check
  // normalizes Windows paths before testing for the segment.
  it.each([
    ["/project/node_modules/astro/components/Image.astro", true],
    ["C:\\project\\node_modules\\astro\\components\\Image.astro", true],
    ["/project/src/pages/index.astro", false],
    ["C:\\project\\src\\pages\\index.astro", false],
  ])("treats %s as associated-only: %s", (fileName, expected) => {
    const plugin = createAstroLanguagePlugin();

    expect(plugin.isAssociatedFileOnly?.(fileName, "astro")).toBe(expected);
  });
});

describe("AstroMX language plugin", () => {
  it("recognizes .amx and exposes composed TSX virtual code", () => {
    const source = [
      "---",
      "const items = [1, 2, 3];",
      "---",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<for|item| of=items><p>${item}</p></for>",
    ].join("\n");
    const plugin = createAmxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      "/src/page.amx",
      AMX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(plugin.getLanguageId("/src/page.amx")).toBe("astromx");
    expect(plugin.getLanguageId("/src/page.astro")).toBeUndefined();
    if (!virtual) throw new Error("Expected AstroMX virtual code");
    expect(virtual.languageId).toBe("typescriptreact");
    expect(virtual.snapshot.getText(0, virtual.snapshot.getLength())).toContain(
      "[...items].map((item) =>",
    );
    expect(virtual.mappings.length).toBeGreaterThan(0);
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {
        extension: "amx",
        isMixedContent: false,
        scriptKind: ts.ScriptKind.TSX,
      },
    ]);
  });

  it("composes an inline expression through Astro's source map", () => {
    const expression = 'needsNumber("bad")';
    const source = [
      "---",
      "function needsNumber(value: number) { return value; }",
      "---",
      `<p>before ${"${"}${expression}} after</p>`,
    ].join("\n");
    const plugin = createAmxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      "/src/column.amx",
      AMX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected AstroMX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    const mapping = virtual.mappings.find(
      (candidate) => candidate.sourceOffsets[0] === source.indexOf(expression),
    );

    expect(mapping).toMatchObject({
      sourceOffsets: [source.indexOf(expression)],
      generatedOffsets: [generated.indexOf(expression)],
      lengths: [expression.length],
    });
  });

  it("discards a transformed hoist when Astro preserves only a partial overlap", () => {
    const astro = [
      "---",
      "const answer: number = 42;",
      "---",
      "<p>answer</p>",
    ].join("\n");
    const converted = convertToTSX(astro, {
      filename: "/src/partial.amx",
      sourcemap: "external",
    });
    const generatedStart = astro.indexOf("const answer");
    const generatedEnd = astro.indexOf("<p>");

    const mappings = composeAmxMappings(
      [
        {
          // Model `static const …` becoming `const …` while its generated
          // whole-block span crosses the closing fence Astro rewrites away.
          // Astro maps the statement, but not the complete generated span.
          sourceStart: 0,
          sourceEnd: generatedEnd - generatedStart + "static ".length,
          generatedStart,
          generatedEnd,
        },
      ],
      converted.map,
      converted.code,
      astro,
    );

    expect(mappings).toEqual([]);
  });
});

describe("Astro type surface", () => {
  const compiled = (inputMembers: string) =>
    [
      `export interface Input {${inputMembers}}`,
      "",
      "function render(input: Input): string {",
      '  return "";',
      "}",
      "",
      "export default render;",
    ].join("\n");

  it("offers children to a component whose Input declares content", () => {
    const surface = createAstroTypeSurface(
      compiled(" title: string; content: () => string; "),
    );

    expect(surface).toContain('"content" extends keyof Input');
    expect(surface).toContain(
      'Omit<Input, "content"> & { children?: unknown }',
    );
  });

  /**
   * A component with no content slot accepts no slot content at runtime, so
   * `children` must not be bolted on: `<Card>anything</Card>` against such a
   * component is a real error, and the earlier unconditional
   * `children?: unknown` silently accepted it.
   */
  it("resolves to Input itself for a component with no content slot", () => {
    const surface = createAstroTypeSurface(compiled(" title: string; "));
    const service = createPluginService(
      {
        "/project/surface.ts": [
          surface.replace("export default mxAstroRender;", ""),
          'const withChildren: MxAstroInput = { title: "t", children: 1 };',
          'const withoutChildren: MxAstroInput = { title: "t" };',
          "void withChildren;",
          "void withoutChildren;",
        ].join("\n"),
      },
      ["/project/surface.ts"],
    );

    const codes = service
      .getSemanticDiagnostics("/project/surface.ts")
      .map((diagnostic) => diagnostic.code);

    // TS2353: `children` is not a known property, because `Input` never
    // declared `content` and so the conditional type resolved to `Input`.
    expect(codes).toContain(2353);
  });
});

function createPluginService(
  files: Record<string, string>,
  rootFiles: string[],
): ts.LanguageService {
  const snapshots = new Map(
    Object.entries(files).map(([fileName, source]) => [
      fileName,
      ts.ScriptSnapshot.fromString(source),
    ]),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    allowArbitraryExtensions: true,
    allowImportingTsExtensions: true,
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => rootFiles,
    getScriptVersion: () => "0",
    getScriptKind: (fileName) =>
      fileName.endsWith(".solid.mx")
        ? ts.ScriptKind.TSX
        : fileName.endsWith(".tsx")
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS,
    getScriptSnapshot(fileName) {
      return (
        snapshots.get(fileName) ??
        (ts.sys.fileExists(fileName)
          ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "")
          : undefined)
      );
    },
    getCurrentDirectory: () => "/project",
    getDefaultLibFileName: (compilerOptions) =>
      ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (fileName) =>
      snapshots.has(fileName) || ts.sys.fileExists(fileName),
    readFile(fileName) {
      const snapshot = snapshots.get(fileName);
      return snapshot
        ? snapshot.getText(0, snapshot.getLength())
        : ts.sys.readFile(fileName);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: (directory) =>
      directory === "/project" || ts.sys.directoryExists(directory),
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    resolveModuleNameLiterals(moduleLiterals, containingFile) {
      return moduleLiterals.map((moduleLiteral) => ({
        resolvedModule: ts.resolveModuleName(
          moduleLiteral.text,
          containingFile,
          options,
          host,
        ).resolvedModule,
      }));
    },
  };
  const languageService = ts.createLanguageService(host);
  const project = {
    projectKind: ts.server.ProjectKind.Configured,
    getProjectName: () => "/project/tsconfig.json",
    getCurrentDirectory: () => "/project",
    getScriptVersion: () => "0",
    getScriptInfo: (fileName: string) => {
      const snapshot = snapshots.get(fileName);
      return snapshot ? { getSnapshot: () => snapshot } : undefined;
    },
    readFile: host.readFile,
    fileExists: host.fileExists,
    readDirectory: host.readDirectory,
    useCaseSensitiveFileNames: () => true,
    refreshDiagnostics: () => undefined,
    getCanonicalFileName: (fileName: string) => fileName,
    getModuleResolutionCache: () => undefined,
    projectService: {
      host: ts.sys,
    },
  };
  const info = {
    project,
    languageService,
    languageServiceHost: host,
    serverHost: ts.sys,
    config: {},
    session: { change: () => undefined },
  } as unknown as ts.server.PluginCreateInfo;

  return pluginFactory({ typescript: ts }).create(info);
}

describe("custom tag template mappings", () => {
  /**
   * The template writes an expression byte-identical to one the caller writes.
   *
   * Under the unit model (decision 95) the template is a separate module the
   * caller imports, so its copy never enters the caller's generated text at
   * all — the property these tests assert (no mapping may point at the
   * caller's text for something the caller did not write) now holds by
   * construction rather than by the mapping pass being careful. They are kept
   * as the regression that would catch expansion returning by any route.
   */
  const CALLER = [
    "static const helper = { count: 1 };",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    "<p>${helper.count}</p>",
    "<box/>",
  ].join("\n");

  const box: TemplateBackedTag = {
    template: {
      filename: "/tags/box.mx",
      source:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
        "<span>${helper.count}</span>",
    },
  };
  const customTags: Record<string, CustomTag> = { box };

  function mappingsFor(source: string, tags?: Record<string, CustomTag>) {
    const plugin = createMxLanguagePlugin(ts, { customTags: tags });
    const virtual = plugin.createVirtualCode?.(
      "/src/caller.mx",
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    return {
      generated,
      mappings: createHtmlMappings(
        source,
        "/src/caller.mx",
        generated,
        false,
        undefined,
        [],
        tags,
      ),
    };
  }

  it("imports the template instead of expanding it", () => {
    const { generated } = mappingsFor(CALLER, customTags);
    // The template's body stays in its own module: the caller's generated text
    // holds its own `helper.count` once, and the tag arrives as an import.
    expect(generated.split("helper.count")).toHaveLength(2);
    expect(generated).toMatch(/import\s+\$mx_\w+\s+from\s+"[^"]*box\.mx"/);
    expect(generated).not.toContain("<span>");
  });

  it("keeps exactly the caller's own expression mapped", () => {
    const { mappings } = mappingsFor(CALLER, customTags);
    const own = mappings.filter(
      (mapping) =>
        CALLER.slice(
          mapping.sourceOffsets[0],
          (mapping.sourceOffsets[0] ?? 0) + (mapping.lengths[0] ?? 0),
        ) === "helper.count",
    );
    // One, because the caller wrote it once. The template's identical copy
    // must not add a second mapping onto the caller's own text.
    expect(own).toHaveLength(1);
    const [mapping] = own as [(typeof own)[number]];
    expect(mapping.sourceOffsets[0]).toBe(CALLER.indexOf("helper.count"));
  });

  it("maps no span outside the caller's own text", () => {
    const { mappings } = mappingsFor(CALLER, customTags);
    for (const mapping of mappings) {
      const start = mapping.sourceOffsets[0] ?? 0;
      expect(start + (mapping.lengths[0] ?? 0)).toBeLessThanOrEqual(
        CALLER.length,
      );
    }
  });

  it("does not cost the file its ordinary mappings", () => {
    // The double-resolve class: a file that calls a custom tag must still get
    // mappings at all. Compared against the same file with no call.
    const withTag = mappingsFor(CALLER, customTags).mappings;
    const withoutTag = mappingsFor(
      CALLER.replace("<box/>", "<span>plain</span>"),
    ).mappings;
    expect(withTag.length).toBe(withoutTag.length);
    expect(withTag.length).toBeGreaterThan(0);
  });
});
