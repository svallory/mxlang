import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertToTSX } from "@astrojs/compiler/sync";
import { decode } from "@jridgewell/sourcemap-codec";
import {
  type CustomTag,
  clearScanCache,
  type MxWarning,
  markoCompiler,
  readCalleeInput,
  resetCalleeInputCache,
  type TemplateBackedTag,
} from "@mxlang/core";
import { print } from "@mxlang/parser";
import { builtinLookup } from "@mxlang/target-registry";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AMX_LANGUAGE_ID,
  composeAmxMappings,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
import { createAstroLanguagePlugin } from "./astro-language.ts";
import pluginFactory, { createConfiguredLanguagePlugins } from "./index.ts";
import {
  compileWithDependencies,
  createNgMxLanguagePlugin,
  createSolidMxLanguagePlugin,
  decodeMappings,
  NG_MX_LANGUAGE_ID,
  SOLID_MX_LANGUAGE_ID,
  solidRegionCompile,
} from "./language.ts";
import {
  createAstroTypeSurface,
  createHtmlMappings,
  createMxLanguagePlugin,
  MX_LANGUAGE_ID,
} from "./mx-language.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("Solid language plugin", () => {
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

    if (!virtual) throw new Error("Expected .solid.mx virtual code");
    const code = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    // A region is an expression, so the import the compiler minted for
    // `<icon>` belongs to the surrounding module. If it does not reach the
    // virtual file the editor reports an unresolved binding on a file that
    // builds fine — the two disagreeing is the whole failure mode.
    expect(code).toMatch(/import \$mx_Icon\d+ from "\.\/tags\/icon\.mx"/);
    const binding = code.match(/import (\$mx_Icon\d+)/)?.[1];
    expect(code).toContain(`<${binding}`);
  });

  it("does not inject an import for an mx.tags entry whose hosts excludes solid", () => {
    // Same shape as the test above, but through an `mx.tags` entry
    // restricted to a different host: `createSolidMxLanguagePlugin`'s scan
    // must honor `hosts` (decision 110(a)), so no import is minted and the
    // region's `<gizmo>` reference stays unresolved.
    const dir = mkdtempSync(join(tmpdir(), "mx-solid-hosts-"));
    try {
      mkdirSync(join(dir, "widgets"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "t",
          mx: {
            host: "solid",
            tags: [{ dir: "widgets", hosts: ["html"] }],
          },
        }),
      );
      writeFileSync(
        join(dir, "widgets", "gizmo.mx"),
        '<span class="icon">${input.name}</span>\n',
      );

      const plugin = createSolidMxLanguagePlugin(ts);
      const fileName = join(dir, "page.solid.mx");
      const source = `const a = <div><gizmo name="star"/></div>;\n`;
      const virtual = plugin.createVirtualCode?.(
        fileName,
        SOLID_MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );

      if (!virtual) throw new Error("Expected .solid.mx virtual code");
      const code = virtual.snapshot.getText(0, virtual.snapshot.getLength());
      expect(code).not.toMatch(/import \$mx_Gizmo\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clearScanCache();
    }
  });

  it("warns about an unknown host name in mx.tags[].hosts (decision 110a; round 2 finding 2)", () => {
    // The scan diagnostic core records for a typo'd host name was computed
    // but dropped here: `createVirtualCode` used `getCustomTags`, which
    // returns only `.customTags`. It now uses `scanCached` and reports
    // `.diagnostics` through `console.warn`, the same channel
    // `mx-language.ts` already used for this exact case.
    const dir = mkdtempSync(join(tmpdir(), "mx-solid-hosts-warning-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mkdirSync(join(dir, "widgets"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "t",
          mx: {
            host: "solid",
            tags: [{ dir: "widgets", hosts: ["bogus"] }],
          },
        }),
      );
      writeFileSync(
        join(dir, "widgets", "gizmo.mx"),
        '<span class="icon">${input.name}</span>\n',
      );

      const plugin = createSolidMxLanguagePlugin(ts);
      const fileName = join(dir, "page.solid.mx");
      const source = "const a = <div>no call</div>;\n";
      plugin.createVirtualCode?.(
        fileName,
        SOLID_MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );

      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("bogus")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
      clearScanCache();
    }
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
    if (!virtual) throw new Error("Expected .solid.mx virtual code");
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
    const serviceScript = plugin.typescript?.getServiceScript(virtual);
    expect(serviceScript).toMatchObject({
      code: virtual,
      extension: ".tsx",
      scriptKind: ts.ScriptKind.TSX,
    });
    // `preventLeadingOffset` must stay unset: `mx-tsc` turns a correctly
    // mapped source offset into line/column against the generated file's
    // line table when it is set, reporting the wrong column whenever the
    // printer reformats an earlier line (solid-mx-tsc-column-against-printed-text).
    expect(serviceScript?.preventLeadingOffset).toBeUndefined();
  });

  it("decodes the printer source map into feature-enabled mappings", () => {
    const source = "const el = <button title=value()>ok</button>;\n";
    const printed = print(source, "mapping.solid.mx", {
      mxRegionCompile: solidRegionCompile,
    });

    const mappings = decodeMappings(printed.map, printed.code, source);

    expect(decode(printed.map.mappings).flat().length).toBeGreaterThan(0);
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings.every((mapping) => mapping.data.verification)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.completion)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.semantic)).toBe(true);
    expect(mappings.every((mapping) => mapping.data.navigation)).toBe(true);
  });

  it("maps offsets past an escaped text character to the shifted generated positions", () => {
    // jsx-text-lt-unescaped: authored `<` in text is emitted as `&#60;`,
    // three characters longer than the source. An expression after the
    // escaped character, and a statement on the following line, must still
    // map to the shifted generated offsets, so a diagnostic on either lands
    // on the authored text instead of three columns late.
    const plugin = createSolidMxLanguagePlugin(ts);
    const source =
      "const a = <div>a < b ${input.zed}</div>;\nconst n: number = 1;\n";
    const virtual = plugin.createVirtualCode?.(
      "/src/mapping.solid.mx",
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    if (!virtual) throw new Error("Expected .solid.mx virtual code");
    const code = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(code).toContain("a &#60; b {input.zed}");
    // Identity up to the escaped `<`, then everything after it shifted by
    // the two extra characters of `&#60;`.
    expect(virtual.mappings).toEqual([
      expect.objectContaining({
        generatedOffsets: [0],
        sourceOffsets: [0],
        lengths: [17],
      }),
      expect.objectContaining({
        generatedOffsets: [26],
        sourceOffsets: [23],
        lengths: [9],
      }),
      expect.objectContaining({
        generatedOffsets: [44],
        sourceOffsets: [41],
        lengths: [20],
      }),
    ]);
  });

  it("returns a no-mapping stub module and records one positioned syntax error", () => {
    const plugin = createSolidMxLanguagePlugin(ts);
    const fileName = "/src/broken.solid.mx";
    const source = "const el = <button>oops;\n";
    const virtual = plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(
      virtual?.snapshot.getText(0, virtual.snapshot.getLength()),
    ).toContain("export default");
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
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Solid placeholder syntax
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

  it.each([
    [
      "single-line region",
      [
        "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }",
        'export const el = <button title="a">x</button>;',
        'export const broken: number = "text";',
      ],
    ],
    [
      "multi-line region",
      [
        "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }",
        "export const el = (",
        '  <button title="a">',
        "    x",
        "  </button>",
        ");",
        'export const broken: number = "text";',
      ],
    ],
  ])(
    "keeps a plain TypeScript diagnostic's column correct after a reformatted %s (solid-mx-tsc-column-against-printed-text)",
    (_label, lines) => {
      const component = "/project/AfterRegion.solid.mx";
      const consumer = "/project/index.ts";
      const source = [
        'import type { AttrTag } from "@mxlang/solid";',
        "",
        ...lines,
      ].join("\n");
      const service = createPluginService(
        {
          [component]: source,
          [consumer]: 'import "./AfterRegion.solid.mx";\n',
        },
        [consumer],
      );
      service.getSemanticDiagnostics(consumer);

      const diagnostics = service.getSemanticDiagnostics(component);
      const diagnostic = diagnostics.find(
        (candidate) => candidate.code === 2322,
      );

      expect(diagnostic?.start).toBe(source.indexOf("broken"));
    },
  );

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
    if (!virtual) throw new Error("Expected .solid.mx virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain("pick<string>(item)");
  });
});

describe("MX language plugin", () => {
  it("maps offsets past entity-decoded text to the shifted generated positions", () => {
    // jsx-text-entities: the Preact emitter HTML5-decodes authored text and
    // re-emits `&copy;` as `&#169;`, one character longer than the source. An
    // expression after the decoded text must still map to its shifted
    // generated offset, so a diagnostic on it lands on the authored text
    // instead of a column late. The control expression in plain text pins
    // the baseline delta against the module's type-surface preamble.
    const plugin = createMxLanguagePlugin(ts);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    const source = "<div>&copy; ${input.zed} and ${input.two}</div>\n";
    const virtual = plugin.createVirtualCode?.(
      `${here}/fixtures/preact-policy/component.mx`,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain("&#169;");
    const find = (text: string) => {
      const mapping = virtual.mappings.find(
        (candidate) => candidate.sourceOffsets[0] === source.indexOf(text),
      );
      expect(mapping, text).toBeDefined();
      const generatedOffset = mapping?.generatedOffsets[0] ?? 0;
      const length = mapping?.generatedLengths?.[0] ?? mapping?.lengths[0] ?? 0;
      expect(generated.slice(generatedOffset, generatedOffset + length)).toBe(
        text,
      );
      return generatedOffset - source.indexOf(text);
    };
    // `&copy;` is 6 source characters and `&#169;` is 7 generated ones, so the
    // expression after the entity carries one extra character of drift over
    // the expression in plain text.
    expect(find("input.zed") - find("input.two")).toBe(1);
  });

  it("keeps the Astro composed panel a module after reading Card's attribute-tag Input", () => {
    const fileName = join(
      here,
      "../../../../examples/astro-static/src/components/panel.mx",
    );
    const source = readFileSync(fileName, "utf8");
    const plugin = createMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      fileName,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    expect(plugin.getSyntaxError(fileName)).toBeUndefined();
    expect(virtual.snapshot.getText(0, virtual.snapshot.getLength())).toContain(
      "export default mxAstroRender",
    );
  });

  it("puts a discovered template tag's import in the virtual file", () => {
    const plugin = createMxLanguagePlugin(ts);
    const fileName = `${here}/fixtures/html-tags/page.mx`;
    const source = '<div><icon name="star"/></div>\n';
    const virtual = plugin.createVirtualCode?.(
      fileName,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    // A discovered *template* tag compiles to its own module, so the page
    // emits an import of it. The editor must see that import, or it reports
    // an unresolved binding on a page a build compiles fine.
    expect(generated).toMatch(/import \$mx_Icon\d+ from "\.\/tags\/icon\.mx"/);
    const binding = generated.match(/import (\$mx_Icon\d+)/)?.[1];
    // Called through the html target's sink (decision 155).
    expect(generated).toMatch(
      new RegExp(
        `(?:\\${binding}\\.render\\(|__mxRenderTag\\(__mxOut, \\${binding}\\)\\()`,
      ),
    );
    // And no syntax error was recorded for the file.
    expect(plugin.getSyntaxError(fileName)).toBeUndefined();
  });

  it("reports a compile error raised inside a tag template against the template file, not the caller", () => {
    const plugin = createMxLanguagePlugin(ts);
    const fileName = `${here}/fixtures/html-tags-broken/page.mx`;
    const templateFileName = `${here}/fixtures/html-tags-broken/tags/broken.mx`;
    const source = '<div><broken name="star"/></div>\n';
    plugin.createVirtualCode?.(
      fileName,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    // The template's own orphan `<else>` (line 3, 0-based line 2) must be
    // reported against `tags/broken.mx`, matching the language server's
    // spec §2 "third position rule" — not against the caller's `page.mx`.
    const templateDiagnostics = plugin.getCompileDiagnostics(templateFileName);
    expect(templateDiagnostics).toHaveLength(1);
    expect(templateDiagnostics[0]?.fileName).toBe(templateFileName);
    expect(templateDiagnostics[0]?.source).toContain("<else/>");

    // The caller still gets a pointer diagnostic so a broken template isn't
    // silently invisible when only the caller is open.
    const callerDiagnostics = plugin.getCompileDiagnostics(fileName);
    expect(callerDiagnostics).toHaveLength(1);
    expect(callerDiagnostics[0]?.message).toContain(templateFileName);
  });

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
    // Decision 134: `.astro.mx` ends in `.mx` but goes to the Astro template
    // plugin, never to this one.
    expect(plugin.getLanguageId("/src/card.astro.mx")).toBeUndefined();
    expect(
      createAmxLanguagePlugin(ts).getLanguageId("/src/card.astro.mx"),
    ).toBe(AMX_LANGUAGE_ID);
    expect(
      createAmxLanguagePlugin(ts).getLanguageId("/src/card.mx"),
    ).toBeUndefined();
    expect(plugin.getLanguageId("/src/card.ts")).toBeUndefined();
    if (!virtual) throw new Error("Expected MX virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(virtual.languageId).toBe("typescript");
    expect(generated).toContain("export interface Input { title: string }");
    expect(generated).toContain("function Card(input: Input): string");
    expect(generated).toContain("__mxOut.write(__mxEscape(input.title));");
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

    it("routes a broken sidecar to its source and leaves a caller pointer", () => {
      const source = [
        "const shared = { text: true };",
        "export default { parseOptions: shared };",
      ].join("\n");
      const { dir, caller } = project(source);
      const sidecar = join(dir, "tags", "thing.tag.ts");
      const plugin = createMxLanguagePlugin(ts);

      plugin.createVirtualCode?.(
        caller,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString("<thing/>\n"),
        { getAssociatedScript: () => undefined },
      );

      // The error belongs to the sidecar, not the caller's syntax channel.
      // It is still surfaced rather than thrown, with a caller jump pointer.
      expect(plugin.getSyntaxError(caller)).toBeUndefined();
      const [own] = plugin.getCompileDiagnostics(sidecar);
      expect(own?.fileName).toBe(sidecar);
      expect(own?.source).toBe(source);
      expect(own?.offset).toBe(source.lastIndexOf("parseOptions"));
      expect(own?.message).not.toContain(sidecar);
      const [pointer] = plugin.getCompileDiagnostics(caller);
      expect(pointer?.offset).toBe(0);
      expect(pointer?.message).toContain(`(in ${sidecar}:2:18)`);
    });

    it("does not resolve an mx.tags entry whose hosts excludes this host (whole-file .mx, html)", () => {
      // `createMxLanguagePlugin` resolves its host through
      // `resolveTargetPolicy`, which reads this fixture's `package.json` as
      // `"html"` — an entry restricted to `hosts: ["solid"]` must stay
      // invisible here, decision 110(a).
      const dir = mkdtempSync(join(tmpdir(), "mx-tsplugin-hosts-"));
      scratches.push(dir);
      mkdirSync(join(dir, "widgets"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "t",
          mx: {
            host: "html",
            tags: [{ dir: "widgets", hosts: ["solid"] }],
          },
        }),
      );
      writeFileSync(
        join(dir, "widgets", "gizmo.tag.ts"),
        "export default { transform: (_c, ctx) => [ctx.build.element('span', [], [ctx.build.text('ok')])] };\n",
      );
      const caller = join(dir, "caller.mx");
      const plugin = createMxLanguagePlugin(ts);

      plugin.createVirtualCode?.(
        caller,
        MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString("<gizmo/>\n"),
        { getAssociatedScript: () => undefined },
      );

      // An unresolved lowercase tag is a Marko parse-time error, the same
      // observable failure as an entirely undiscovered tag.
      expect(plugin.getSyntaxError(caller)?.message).toBeDefined();
    });

    it("resolves a discovered tag in an .astro.mx page too", () => {
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

      const amx = join(dir, "page.astro.mx");
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

    it("does not resolve an mx.tags entry whose hosts excludes astro (.astro.mx)", () => {
      // Same fixture shape as the "resolves a discovered tag in an .astro.mx
      // page too" test above, but the entry restricts `hosts` to a
      // different host: `createAmxLanguagePlugin`'s scan must honor it
      // (decision 110(a)), rather than resolving `<stamp>` as it does with
      // no restriction.
      const dir = mkdtempSync(join(tmpdir(), "mx-amx-hosts-"));
      scratches.push(dir);
      mkdirSync(join(dir, "widgets"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "a",
          mx: {
            host: "astro",
            tags: [{ dir: "widgets", hosts: ["solid"] }],
          },
        }),
      );
      writeFileSync(
        join(dir, "widgets", "stamp.tag.ts"),
        "export default { transform: (_c, ctx) => [ctx.build.text('stamped')] };\n",
      );

      const amx = join(dir, "page.astro.mx");
      const source = "---\n---\n<stamp/>\n";
      const plugin = createAmxLanguagePlugin(ts);
      const virtual = plugin.createVirtualCode?.(
        amx,
        AMX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );
      if (!virtual) throw new Error("Expected AMX virtual code");

      expect(
        virtual.snapshot.getText(0, virtual.snapshot.getLength()),
      ).not.toContain("stamped");
    });

    it("warns about an unknown host name in mx.tags[].hosts (.astro.mx; decision 110a; round 2 finding 2)", () => {
      // The scan diagnostic core records for a typo'd host name was
      // computed but dropped here: `createVirtualCode` used
      // `getCustomTags`, which returns only `.customTags`. It now uses
      // `scanCached` and reports `.diagnostics` through `console.warn`.
      const dir = mkdtempSync(join(tmpdir(), "mx-amx-hosts-warning-"));
      scratches.push(dir);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        mkdirSync(join(dir, "widgets"), { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "a",
            mx: {
              host: "astro",
              tags: [{ dir: "widgets", hosts: ["bogus"] }],
            },
          }),
        );
        writeFileSync(
          join(dir, "widgets", "stamp.tag.ts"),
          "export default { transform: (_c, ctx) => [ctx.build.text('stamped')] };\n",
        );

        const amx = join(dir, "page.astro.mx");
        const source = "---\n---\n<div>no call</div>\n";
        const plugin = createAmxLanguagePlugin(ts);
        plugin.createVirtualCode?.(
          amx,
          AMX_LANGUAGE_ID,
          ts.ScriptSnapshot.fromString(source),
          { getAssociatedScript: () => undefined },
        );

        expect(
          warn.mock.calls.some((call) => String(call[0]).includes("bogus")),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
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
    ["html", "/src/component.mx"],
    ["preact", `${here}/fixtures/preact-policy/component.mx`],
  ] as const)(
    "maps component tag, attribute, and attribute-tag names for the %s host",
    (_host, fileName) => {
      const markup = "<Card title=1><@footer>ok</@footer></Card>";
      const source = `import Card from "./Card.mx"\n${markup}`;
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

  it("compiles a resolved capitalized tag with no throw for the solid host (decision 114)", () => {
    // Distinct from the html/preact row above rather than folded into its
    // `it.each`, and a smoke test rather than a mapping test: Solid's
    // whole-file `.mx` compile (`compileSolidMx`) rejects an authored
    // `import` as a module-level statement even outside a real `.solid.mx`
    // region (a separate, pre-existing limitation — see
    // `packages/hosts/solid/AGENTS.md`), so there is no way to give `Card`
    // a real import here the way html/preact's row does; a registered
    // custom tag is the only other resolution route. But a custom tag's
    // `transform` builds entirely fresh IR with no source position tied to
    // anything in the original call — not the tag name, not its attrs, not
    // its attribute tags — so none of the mapping assertions the html/preact
    // row makes can be reproduced for it. This asserts only what actually
    // holds: decision 114's tightened `isComponent` does not regress a
    // custom-tag-resolved capitalized tag into an unresolved-tag error.
    const fileName = `${here}/fixtures/solid-policy/component.mx`;
    const source = "<Card title=1><@footer>ok</@footer></Card>";
    const plugin = createMxLanguagePlugin(ts, {
      customTags: {
        Card: {
          transform: (call, ctx) => [ctx.build.element("div", call.attrs)],
        },
      },
    });
    const virtual = plugin.createVirtualCode?.(
      fileName,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    expect(plugin.getSyntaxError?.(fileName)).toBeUndefined();
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain("<div");
    expect(generated).toContain("1");
  });

  it("resolves and imports another whole-file Solid .mx component (decision 115)", () => {
    // Whole-file `.mx` resolved to Solid must go through `compileSolidUnit`
    // in the editor too, not the region compiler — the production-path
    // proof that motivated wiring `createMxLanguagePlugin`'s
    // `host === "solid"` branch here.
    const fileName = `${here}/fixtures/solid-policy/uses-widget.mx`;
    const source = 'import Widget from "./widget.mx"\n<Widget/>\n';
    const plugin = createMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      fileName,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected MX virtual code");
    expect(plugin.getSyntaxError?.(fileName)).toBeUndefined();
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    expect(generated).toContain('import Widget from "./widget.mx"');
    expect(generated).toContain("<Widget />");
  });

  it("type-checks a whole-file Solid .mx component's ordinary props at the caller (solid-whole-file-prop-typing)", () => {
    // `compileSolidUnit` keeps `export interface Input` and annotates
    // `function Card(input: Input)`, so the caller's props are a JSX props
    // check, as on preact/html. Before, `input` was implicit `any`.
    const directory = `${here}/fixtures/solid-policy`;
    const wrongSource = 'import Card from "./Card.mx"\n<Card title=1/>';
    const files: Record<string, string> = {
      [`${directory}/Card.mx`]:
        "export interface Input { title: string; count?: number }\n<div>${input.title}${input.count ?? 0}</div>",
      [`${directory}/Tabs.mx`]:
        "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }\n<div/>",
      [`${directory}/Plain.mx`]: "<div>plain</div>",
      [`${directory}/Wrong.mx`]: wrongSource,
      [`${directory}/WrongOptional.mx`]:
        'import Card from "./Card.mx"\n<Card title="a" count="many"/>',
      [`${directory}/Missing.mx`]: 'import Card from "./Card.mx"\n<Card/>',
      [`${directory}/WrongTab.mx`]:
        'import Tabs from "./Tabs.mx"\n<Tabs><@tab title=1/></Tabs>',
      [`${directory}/Good.mx`]: [
        'import Card from "./Card.mx"',
        'import Tabs from "./Tabs.mx"',
        'import Plain from "./Plain.mx"',
        '<Card title="a"/>',
        '<Card title="b" count=2/>',
        '<Tabs><@tab title="t"/></Tabs>',
        "<Plain/>",
      ].join("\n"),
    };
    const consumer = `${directory}/index.ts`;
    files[consumer] = ["Wrong", "WrongOptional", "Missing", "WrongTab", "Good"]
      .map((name) => `import "./${name}.mx";`)
      .join("\n");
    const service = createPluginService(files, [consumer]);
    service.getSemanticDiagnostics(consumer);
    const codes = (name: string) =>
      service
        .getSemanticDiagnostics(`${directory}/${name}.mx`)
        .map((diagnostic) => diagnostic.code);

    // The wrong prop is reported on the attribute itself.
    expect(
      service
        .getSemanticDiagnostics(`${directory}/Wrong.mx`)
        .some(
          (diagnostic) =>
            diagnostic.code === 2322 &&
            diagnostic.start === wrongSource.indexOf("title"),
        ),
    ).toBe(true);
    expect(codes("WrongOptional")).toContain(2322);
    expect(codes("Missing")).toContain(2741);
    expect(codes("WrongTab")).toContain(2322);
    // Correct calls stay clean: required, optional, AttrTag, and a component
    // with no `Input`.
    expect(codes("Good")).toEqual([]);
  });

  it("types a whole-file Solid .mx <return> unit's /var, and reports /var on a unit with no <return>", () => {
    // A unit declaring `<return>` widens its parameter with the `$mxReturn`
    // callback prop, so the caller's generated `$mxReturn={...}` type-checks.
    // `/var` needs a discovered tag, so the callees live in a real `tags/`
    // directory of a scratch Solid package.
    const dir = mkdtempSync(join(tmpdir(), "mx-solid-return-"));
    try {
      mkdirSync(join(dir, "tags"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "t", mx: { host: "solid" } }),
      );
      writeFileSync(
        join(dir, "tags", "counter.mx"),
        "export interface Input { start: number }\n<span>${input.start}</span>\n<return value=input.start + 1/>\n",
      );
      writeFileSync(
        join(dir, "tags", "plain.mx"),
        "export interface Input { start: number }\n<span>${input.start}</span>\n",
      );
      const good = join(dir, "good.mx");
      const bad = join(dir, "bad.mx");
      const wrongType = join(dir, "wrong-type.mx");
      const consumer = join(dir, "index.ts");
      const files: Record<string, string> = {
        // `n` is a number, so `n.toFixed(1)` is fine; that is the type check.
        [good]: "<counter/n start=1/>\n<p>${n.toFixed(1)}</p>\n",
        [bad]: "<plain/n start=1/>\n<p>${n}</p>\n",
        // `n` is a number, not a string: `.toUpperCase` must not exist.
        [wrongType]: "<counter/n start=1/>\n<p>${n.toUpperCase()}</p>\n",
        [consumer]:
          'import "./good.mx";\nimport "./bad.mx";\nimport "./wrong-type.mx";',
      };
      const service = createPluginService(files, [consumer]);
      service.getSemanticDiagnostics(consumer);
      const diagnose = (fileName: string) => {
        const plugin = createMxLanguagePlugin(ts);
        plugin.createVirtualCode?.(
          fileName,
          MX_LANGUAGE_ID,
          ts.ScriptSnapshot.fromString(files[fileName] as string),
          { getAssociatedScript: () => undefined },
        );
        return {
          compile: plugin.getCompileDiagnostics(fileName),
          semantic: service.getSemanticDiagnostics(fileName),
        };
      };

      // A `<return>` unit called with `/var` type-checks clean: the caller's
      // generated `$mxReturn={...}` is a declared prop of the widened
      // parameter, not an excess property.
      const ok = diagnose(good);
      expect(ok.compile).toEqual([]);
      expect(ok.semantic).toEqual([]);
      // `/var` on a unit with no `<return>` is rejected, by core's own
      // compile diagnostic (it fires before TypeScript would see the excess
      // `$mxReturn` prop).
      const no = diagnose(bad);
      expect(no.compile).toHaveLength(1);
      expect(no.compile[0]?.message).toContain("does not return a value");
      // KNOWN LIMIT, not asserted as desired (firstmate's ruling on
      // tag-var-type-from-return: option C): the bound variable is
      // `let n: any;` assigned in a callback, so it is explicitly `any`
      // (never the `<return>` expression's own type), not the `<return>`
      // expression's type (`n.toUpperCase()` on a number does not error).
      // The callback prop is `(value: unknown) => void`.
      const wrong = diagnose(wrongType);
      expect(wrong.compile).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // TODO tag-var-type-from-return (S159 round 2; firstmate's ruling: option
  // C, `any`, documented — real inference is impossible without changing
  // the emitted runtime JS, since TypeScript's `typeof` only accepts an
  // identifier, never an arbitrary expression, and the `<return>` value can
  // depend on the unit's own body locals, so no type-only declaration beside
  // the component can name it either). This is the `.solid.mx` *region*
  // counterpart of the whole-file test above: a `/var` bound from a
  // discovered `<counter/n .../>` inside a region is `let n;`, untyped, the
  // surrounding TypeScript module declares it (`@mxlang/parser`'s
  // `hoistRegionImports`), and the region's `$mxReturn={...}` callback prop
  // assigns it — same shape and same limitation as the whole-file case.
  it("types a .solid.mx region's <return> unit /var as any (KNOWN LIMIT, tag-var-type-from-return)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-solid-region-return-"));
    try {
      mkdirSync(join(dir, "tags"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "t", mx: { host: "solid" } }),
      );
      writeFileSync(
        join(dir, "tags", "counter.mx"),
        "export interface Input { start: number }\n<span>${input.start}</span>\n<return value=input.start + 1/>\n",
      );
      const good = join(dir, "good.solid.mx");
      const wrongType = join(dir, "wrong-type.solid.mx");
      const consumer = join(dir, "index.ts");
      const files: Record<string, string> = {
        // `n` is a number, so `n.toFixed(1)` is fine; that is the type check.
        [good]:
          "export function App() {\n  return <div><counter/n start=1/><p>${n.toFixed(1)}</p></div>;\n}\n",
        // `n` is a number, not a string: `.toUpperCase` must not exist —
        // this is the KNOWN LIMIT: it does not error today.
        [wrongType]:
          "export function App() {\n  return <div><counter/n start=1/><p>${n.toUpperCase()}</p></div>;\n}\n",
        [consumer]:
          'import "./good.solid.mx";\nimport "./wrong-type.solid.mx";',
      };
      const service = createPluginService(files, [consumer]);
      service.getSemanticDiagnostics(consumer);
      const diagnose = (fileName: string) => {
        const plugin = createSolidMxLanguagePlugin(ts);
        plugin.createVirtualCode?.(
          fileName,
          SOLID_MX_LANGUAGE_ID,
          ts.ScriptSnapshot.fromString(files[fileName] as string),
          { getAssociatedScript: () => undefined },
        );
        return {
          compile: plugin.getCompileDiagnostics(fileName),
          semantic: service.getSemanticDiagnostics(fileName),
        };
      };

      // This harness has no `solid-js` JSX-namespace types wired up, so a
      // bare `<div>`/`<p>` element itself reports TS7026 ("JSX element
      // implicitly has type 'any'") regardless of this fix — irrelevant
      // noise, filtered out the same way the sibling `.solid.mx` import
      // test above ignores it. `n.toFixed`/`n.toUpperCase` are unaffected by
      // that noise: a real `n: any` never reports anything there, and a
      // real `n: number` reports TS2339 on `.toUpperCase()` specifically.
      const realTypeErrors = (diagnostics: readonly ts.Diagnostic[]) =>
        diagnostics.filter((d) => d.code !== 7026 && d.code !== 2875);

      const ok = diagnose(good);
      expect(ok.compile).toEqual([]);
      expect(realTypeErrors(ok.semantic)).toEqual([]);
      // KNOWN LIMIT, not asserted as desired: `let n;` is untyped, assigned
      // in the region's `$mxReturn={...}` callback, so `n.toUpperCase()` on
      // a number does not error. A future fix for tag-var-type-from-return
      // flips this to a real TS2339.
      const wrong = diagnose(wrongType);
      expect(wrong.compile).toEqual([]);
      expect(realTypeErrors(wrong.semantic)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["html", "/project", ".mx"],
    ["preact", `${here}/fixtures/preact-policy`, ".mx"],
    ["solid", `${here}/fixtures/solid-policy`, ".solid.mx"],
  ])(
    "type-checks declared attribute-tag attrs for the %s host and maps failures to the call site",
    (host, directory, extension) => {
      const callee = `${directory}/Card${extension}`;
      const wrong = `${directory}/Wrong${extension}`;
      const missing = `${directory}/Missing${extension}`;
      const consumer = `${directory}/index.ts`;
      const card =
        host === "solid"
          ? [
              'import type { AttrTag } from "@mxlang/solid";',
              "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }",
              "export default function Card(_input: Input) { return null; }",
            ].join("\n")
          : "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }\n<div/>";
      const wrongSource = `import Card from "./Card${extension}"\n<Card><@tab title=1/></Card>`;
      const missingSource = `import Card from "./Card${extension}"\n<Card><@tab/></Card>`;
      const files = {
        [callee]: card,
        [wrong]: wrongSource,
        [missing]: missingSource,
        [consumer]: `import "./Wrong${extension}";\nimport "./Missing${extension}";`,
      };
      const service = createPluginService(files, [consumer]);
      service.getSemanticDiagnostics(consumer);

      const wrongDiagnostics = service.getSemanticDiagnostics(wrong);
      const missingDiagnostics = service.getSemanticDiagnostics(missing);

      expect(
        wrongDiagnostics.some((diagnostic) => diagnostic.code === 2322),
      ).toBe(true);
      // A wrong attribute type is reported on the attribute itself
      // (`solid-attr-tag-attr-offset`) — every host, `title`, not the tag
      // name it sits on.
      expect(
        wrongDiagnostics.some(
          (diagnostic) => diagnostic.start === wrongSource.indexOf("title"),
        ),
      ).toBe(true);
      expect(
        missingDiagnostics.some((diagnostic) => diagnostic.code === 2322),
      ).toBe(true);
      expect(
        missingDiagnostics.some(
          (diagnostic) => diagnostic.start === missingSource.indexOf("tab"),
        ),
      ).toBe(true);
    },
  );

  it("maps the wrong attribute in the middle of several on one attribute tag (solid-attr-tag-attr-offset)", () => {
    const callee = "/project/Card.solid.mx";
    const caller = "/project/Wrong.solid.mx";
    const consumer = "/project/index.ts";
    const card = [
      'import type { AttrTag } from "@mxlang/solid";',
      "export interface Input { tab: AttrTag<{ attrs: { first: string; title: string; last: string } }> }",
      "export default function Card(_input: Input) { return null; }",
    ].join("\n");
    const callerSource =
      'import Card from "./Card.solid.mx"\n<Card><@tab first="a" title=1 last="b"/></Card>';
    const service = createPluginService(
      {
        [callee]: card,
        [caller]: callerSource,
        [consumer]: 'import "./Wrong.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(caller);
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2322)).toBe(
      true,
    );
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.indexOf("title"),
      ),
    ).toBe(true);
    // Neither sibling attribute's own span is mistaken for the wrong one's.
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.indexOf("first"),
      ),
    ).toBe(false);
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.lastIndexOf("last"),
      ),
    ).toBe(false);
  });

  it.each([
    ["a comma", "a, b"],
    ["a closing paren", "a)b"],
    ["a closing brace", "a}b"],
    ["a closing bracket", "a]b"],
  ])(
    "keeps the attribute span correct when a string value contains %s (solid-attr-tag-attr-offset)",
    (_label, titleValue) => {
      const callee = "/project/Card.solid.mx";
      const caller = "/project/Wrong.solid.mx";
      const consumer = "/project/index.ts";
      const card = [
        'import type { AttrTag } from "@mxlang/solid";',
        "export interface Input { tab: AttrTag<{ attrs: { title: string; after: string } }> }",
        "export default function Card(_input: Input) { return null; }",
      ].join("\n");
      // `after=1` (a number literal against a declared `string`) is
      // deliberately wrong, so the test proves the *following* property's
      // own span was not corrupted by scanning past an unbalanced bracket
      // character inside `title`'s own string value.
      const callerSource = `import Card from "./Card.solid.mx"\n<Card><@tab title="${titleValue}" after=1/></Card>`;
      const service = createPluginService(
        {
          [callee]: card,
          [caller]: callerSource,
          [consumer]: 'import "./Wrong.solid.mx";\n',
        },
        [consumer],
      );
      service.getSemanticDiagnostics(consumer);

      const diagnostics = service.getSemanticDiagnostics(caller);
      expect(diagnostics.some((diagnostic) => diagnostic.code === 2322)).toBe(
        true,
      );
      expect(
        diagnostics.some(
          (diagnostic) => diagnostic.start === callerSource.indexOf("after"),
        ),
      ).toBe(true);
    },
  );

  it("maps each occurrence of a same-named attribute tag on separate calls independently (solid-attr-tag-attr-offset)", () => {
    // Two separate `<Card>` calls, each with its own single `<@tab>` — the
    // same attribute-tag *name* appears twice in one file's generated text,
    // which is what `attributeTagDiagnosticMappings`'s per-name
    // `generatedCursors` exists to keep from cross-mapping.
    const callee = "/project/Card.solid.mx";
    const caller = "/project/Wrong.solid.mx";
    const consumer = "/project/index.ts";
    const card = [
      'import type { AttrTag } from "@mxlang/solid";',
      "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }",
      "export default function Card(_input: Input) { return null; }",
    ].join("\n");
    const callerSource = [
      'import Card from "./Card.solid.mx"',
      'export const a = <Card><@tab title="a"/></Card>;',
      "export const b = <Card><@tab title=2/></Card>;",
    ].join("\n");
    const service = createPluginService(
      {
        [callee]: card,
        [caller]: callerSource,
        [consumer]: 'import "./Wrong.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(caller);
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2322)).toBe(
      true,
    );
    // The wrong occurrence's own `title` (the second `<Card>`'s), not the
    // first, correctly-typed one.
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.lastIndexOf("title"),
      ),
    ).toBe(true);
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.indexOf("title"),
      ),
    ).toBe(false);
  });

  it("maps a same-named attribute tag independently across two different callees", () => {
    // `<Card>` and `<Modal>` are two distinct components that each declare
    // their own `<@tab>` attribute tag. `generatedCursors` is keyed only by
    // tag *name*, not by which callee owns the occurrence, so this proves a
    // second callee's `tab` is not cross-mapped through the first callee's
    // cursor position.
    const cardCallee = "/project/Card.solid.mx";
    const modalCallee = "/project/Modal.solid.mx";
    const caller = "/project/Wrong.solid.mx";
    const consumer = "/project/index.ts";
    const card = [
      'import type { AttrTag } from "@mxlang/solid";',
      "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }",
      "export default function Card(_input: Input) { return null; }",
    ].join("\n");
    const modal = [
      'import type { AttrTag } from "@mxlang/solid";',
      "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }",
      "export default function Modal(_input: Input) { return null; }",
    ].join("\n");
    const callerSource = [
      'import Card from "./Card.solid.mx"',
      'import Modal from "./Modal.solid.mx"',
      'export const a = <Card><@tab title="a"/></Card>;',
      "export const b = <Modal><@tab title=2/></Modal>;",
    ].join("\n");
    const service = createPluginService(
      {
        [cardCallee]: card,
        [modalCallee]: modal,
        [caller]: callerSource,
        [consumer]: 'import "./Wrong.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(caller);
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2322)).toBe(
      true,
    );
    // The wrong occurrence is `<Modal>`'s `title`, not `<Card>`'s.
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.lastIndexOf("title"),
      ),
    ).toBe(true);
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.indexOf("title"),
      ),
    ).toBe(false);
  });

  it("maps a wrong attribute on a nested component's own attribute tag (solid-attr-tag-attr-offset)", () => {
    const outerCallee = "/project/Card.solid.mx";
    const innerCallee = "/project/Inner.solid.mx";
    const caller = "/project/Wrong.solid.mx";
    const consumer = "/project/index.ts";
    const inner = [
      'import type { AttrTag } from "@mxlang/solid";',
      "export interface Input { sub: AttrTag<{ attrs: { title: string } }> }",
      "export default function Inner(_input: Input) { return null; }",
    ].join("\n");
    const outer = [
      'import type { AttrTag } from "@mxlang/solid";',
      "export interface Input { tab: AttrTag<{}> }",
      "export default function Card(_input: Input) { return null; }",
    ].join("\n");
    const callerSource = [
      'import Card from "./Card.solid.mx"',
      'import Inner from "./Inner.solid.mx"',
      "<Card><@tab><Inner><@sub title=1/></Inner></@tab></Card>",
    ].join("\n");
    const service = createPluginService(
      {
        [outerCallee]: outer,
        [innerCallee]: inner,
        [caller]: callerSource,
        [consumer]: 'import "./Wrong.solid.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);

    const diagnostics = service.getSemanticDiagnostics(caller);
    expect(diagnostics.some((diagnostic) => diagnostic.code === 2322)).toBe(
      true,
    );
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.start === callerSource.indexOf("title"),
      ),
    ).toBe(true);
  });

  it.each([
    ["html", "/project", ".mx"],
    ["preact", `${here}/fixtures/preact-policy`, ".mx"],
    ["solid", `${here}/fixtures/solid-policy`, ".solid.mx"],
  ])(
    "reports a %s callee's own type error against the callee, not the caller that read its Input",
    (host, directory, extension) => {
      // Regression: registering the callee as a Volar *associated script* of
      // its caller made `@volar/typescript`'s `getServiceScript` answer for
      // the callee with the caller's virtual code, so the callee's
      // diagnostics were mapped through the caller's mappings and reported
      // in the caller's file.
      const callee = `${directory}/BrokenCard${extension}`;
      const caller = `${directory}/BrokenCaller${extension}`;
      const consumer = `${directory}/broken-index.ts`;
      const input =
        "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }";
      const card =
        host === "solid"
          ? [
              'import type { AttrTag } from "@mxlang/solid";',
              input,
              'export const broken: number = "text";',
              "export default function Card(_input: Input) { return null; }",
            ].join("\n")
          : [input, 'static const broken: number = "text";', "<div/>"].join(
              "\n",
            );
      const callerSource = `import Card from "./BrokenCard${extension}"\n<Card><@tab title="a"/></Card>`;
      const service = createPluginService(
        {
          [callee]: card,
          [caller]: callerSource,
          [consumer]: `import "./BrokenCaller${extension}";`,
        },
        [consumer],
      );
      service.getSemanticDiagnostics(consumer);

      const callerDiagnostics = service.getSemanticDiagnostics(caller);
      const calleeDiagnostics = service.getSemanticDiagnostics(callee);

      expect(
        callerDiagnostics.map((diagnostic) => diagnostic.code),
      ).not.toContain(2322);
      expect(
        calleeDiagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          file: diagnostic.file?.fileName,
          start: diagnostic.start,
        })),
      ).toContainEqual({
        code: 2322,
        file: callee,
        start: card.indexOf("broken"),
      });
    },
  );

  describe("a callee's Input changing under an unchanged caller", () => {
    const directory = `${here}/fixtures/preact-policy`;
    const callee = `${directory}/MutableCard.mx`;
    const caller = `${directory}/MutableCaller.mx`;
    const consumer = `${directory}/mutable-index.ts`;
    const optional =
      "export interface Input { tab: AttrTag<{ attrs: { title?: string } }> }\n<div/>";
    const required =
      "export interface Input { tab: AttrTag<{ attrs: { title: string } }> }\n<div/>";
    const callerSource =
      'import Card from "./MutableCard.mx"\n<Card><@tab/></Card>';
    // Not `indexOf("tab")`: that is the `tab` inside `MutableCard`.
    const tagName = callerSource.indexOf("@tab") + 1;

    function projectWith(calleeSource: string) {
      const project = createMutablePluginService(
        {
          [callee]: calleeSource,
          [caller]: callerSource,
          [consumer]: 'import "./MutableCaller.mx";',
        },
        [consumer],
      );
      project.service.getSemanticDiagnostics(consumer);
      return project;
    }

    function callerErrors(project: ReturnType<typeof projectWith>) {
      return project.service
        .getSemanticDiagnostics(caller)
        .map((diagnostic) => ({
          code: diagnostic.code,
          start: diagnostic.start,
        }));
    }

    it("re-checks the caller when the callee's attribute types tighten", () => {
      const project = projectWith(optional);
      expect(callerErrors(project)).toEqual([]);

      project.setFile(callee, required);

      expect(callerErrors(project)).toEqual([{ code: 2322, start: tagName }]);
    });

    it("re-checks the caller when the callee's attribute types loosen again", () => {
      const project = projectWith(required);
      expect(callerErrors(project)).toEqual([{ code: 2322, start: tagName }]);

      project.setFile(callee, optional);

      expect(callerErrors(project)).toEqual([]);
    });

    it("follows the callee through a tighten-then-loosen cycle in one project", () => {
      const project = projectWith(optional);
      expect(callerErrors(project)).toEqual([]);

      project.setFile(callee, required);
      project.service.getSemanticDiagnostics(callee);
      expect(callerErrors(project)).toEqual([{ code: 2322, start: tagName }]);

      project.setFile(callee, optional);
      project.service.getSemanticDiagnostics(callee);
      expect(callerErrors(project)).toEqual([]);
    });

    // Decision 107, option A: the documented limitation. A type change
    // reaches the caller through TypeScript's own module graph, but what the
    // caller *compiled to* (here the shape inferred while the callee did not
    // exist, and the warning that came with it) is only replaced when the
    // caller is compiled again.
    it("keeps what the caller compiled to until the caller itself is compiled again", () => {
      const lateCallee = `${directory}/LateCard.mx`;
      const lateCaller = `${directory}/LateCaller.mx`;
      const lateConsumer = `${directory}/late-index.ts`;
      const lateSource =
        'import Card from "./LateCard.mx"\n<Card><@tab/></Card>';
      const project = createMutablePluginService(
        {
          [lateCaller]: lateSource,
          [lateConsumer]: 'import "./LateCaller.mx";',
        },
        [lateConsumer],
      );
      const warnings = () =>
        project.service
          .getSyntacticDiagnostics(lateCaller)
          .filter((diagnostic) => diagnostic.code === 80002)
          .map((diagnostic) => diagnostic.messageText);
      project.service.getSemanticDiagnostics(lateConsumer);
      expect(warnings()).toEqual([
        expect.stringContaining("attribute-tag shape inferred"),
      ]);

      project.setFile(lateCallee, required);
      project.service.getSemanticDiagnostics(lateCaller);
      expect(warnings()).toEqual([
        expect.stringContaining("attribute-tag shape inferred"),
      ]);

      project.setFile(lateCaller, lateSource);
      project.service.getSemanticDiagnostics(lateCaller);
      expect(warnings()).toEqual([]);
    });
  });

  describe("compileWithDependencies against a real readCalleeInput compile", () => {
    // B declares `AttrTag<Alias>` where `Alias` is the *whole* type
    // argument, imported from C -- the shape `resolveNamedType` actually
    // follows across files (confirmed at
    // packages/core/src/callee-input.test.ts:234; a *nested* field
    // reference, `AttrTag<{ attrs: Alias }>`, is not followed the same way
    // and is covered by TypeScript's own live module graph through the
    // emitted `satisfies` clause instead -- see this package's AGENTS.md).
    const dir = mkdtempSync(join(tmpdir(), "mx-compile-deps-nesting-"));
    afterEach(() => {
      resetCalleeInputCache();
      rmSync(dir, { recursive: true, force: true });
    });

    it("converges a B -> C -> D -> E alias chain (fails on the single-retry cap)", () => {
      const bPath = join(dir, "B.ts");
      const cPath = join(dir, "C.ts");
      const dPath = join(dir, "D.ts");
      const ePath = join(dir, "E.ts");
      // On disk, only B -> C -> D is wired; D declares the shape directly.
      // Only the caller's *unsaved* text of D re-points it at E -- so E is
      // discoverable only once D itself is read fresh, which (with a single
      // retry) can happen on pass 2 at the earliest. E's own unsaved text
      // then needs a *further* pass to be read fresh, which the single-retry
      // cap never runs.
      writeFileSync(
        bPath,
        [
          'import type { CAlias } from "./C.ts";',
          "export interface Input { tag?: AttrTag<CAlias> }",
        ].join("\n"),
      );
      writeFileSync(
        cPath,
        'export type CAlias = DAlias;\nimport type { DAlias } from "./D.ts";\n',
      );
      writeFileSync(
        dPath,
        'export type DAlias = { as: "data"; attrs: { title?: string } };\n',
      );
      writeFileSync(
        ePath,
        'export type DAlias = { as: "data"; attrs: { title: string } };\n',
      );

      const unsavedText = new Map<string, string>([
        [
          dPath,
          'export type DAlias = EAlias;\nimport type { EAlias } from "./E.ts";\n',
        ],
        [
          ePath,
          'export type EAlias = { as: "data"; attrs: { title: string } };\n',
        ],
      ]);
      const readSource = (fileName: string) => unsavedText.get(fileName);

      let compiles = 0;
      const compile = () => {
        compiles++;
        return readCalleeInput(
          { kind: "name", name: "Card" },
          {
            importer: join(dir, "caller.mx"),
            imports: new Map([["Card", "./B.ts"]]),
            targets: builtinLookup(),
          },
        );
      };

      // previousDependencies already includes B and C from an earlier
      // compile -- the persisted-map steady state `createVirtualCode`'s
      // `dependencies.get(fileName)` produces once the caller has compiled
      // this chain before -- but NOT D yet. Pass 1 therefore reads D from
      // *disk* (stale: no import of E at all) and merely discovers D as a
      // new dependency; the single retry then reads D *fresh* (now
      // importing E), which is what first reveals E -- one pass too late
      // for the single-retry cap to also read E fresh in the same call.
      const result = compileWithDependencies(
        readSource,
        [bPath, cPath],
        compile,
      );

      expect(result.dependencies).toContain(ePath);
      // The bug: current code converges in exactly 2 passes and stops,
      // never re-reading E once it is newly discovered by the retry's own
      // compile -- one hop short of the E's fresh, tightened shape.
      expect(compiles).toBeGreaterThan(2);
    });
  });

  describe("compileWithDependencies", () => {
    it("compiles once when no host reader is supplied", () => {
      let compiles = 0;
      const result = compileWithDependencies(undefined, [], () => {
        compiles++;
        return { dependencies: ["/project/Card.mx"], pass: compiles };
      });

      expect(compiles).toBe(1);
      expect(result.pass).toBe(1);
    });

    it("recompiles against the host's text for a newly reported dependency", () => {
      const read: string[] = [];
      let compiles = 0;
      const result = compileWithDependencies(
        (fileName) => {
          read.push(fileName);
          return fileName === "/project/Card.mx" ? "unsaved" : undefined;
        },
        [],
        () => {
          compiles++;
          return {
            dependencies: ["/project/Card.mx", "/project/Card.ts"],
            pass: compiles,
          };
        },
      );

      expect(read).toEqual(["/project/Card.mx", "/project/Card.ts"]);
      expect(compiles).toBe(2);
      expect(result.pass).toBe(2);
    });

    it("does not recompile when the host holds none of the new dependencies", () => {
      let compiles = 0;
      const result = compileWithDependencies(
        () => undefined,
        [],
        () => {
          compiles++;
          return { dependencies: ["/project/Card.mx"], pass: compiles };
        },
      );

      expect(compiles).toBe(1);
      expect(result.pass).toBe(1);
    });

    it("reads the previous dependencies' text before the first pass and stops when the set is unchanged", () => {
      const read: string[] = [];
      let compiles = 0;
      compileWithDependencies(
        (fileName) => {
          read.push(fileName);
          return "unsaved";
        },
        ["/project/Card.mx"],
        () => {
          // The reader must already have run: the first pass is the one
          // that sees an open callee's unsaved text.
          expect(read).toEqual(["/project/Card.mx"]);
          compiles++;
          return { dependencies: ["/project/Card.mx"] };
        },
      );

      expect(compiles).toBe(1);
      expect(read).toEqual(["/project/Card.mx"]);
    });

    it("treats a reordered dependency list as the same set", () => {
      let compiles = 0;
      compileWithDependencies(
        () => "unsaved",
        ["/project/A.mx", "/project/B.mx"],
        () => {
          compiles++;
          return { dependencies: ["/project/B.mx", "/project/A.mx"] };
        },
      );

      expect(compiles).toBe(1);
    });

    it("resolves a three-level dependency chain (A -> B -> C), each hop revealed only by the previous one's fresh text", () => {
      // B is only known once its fresh source is read (pass 2), and C is
      // only known once B's fresh source is itself compiled (also surfaced
      // on pass 2's own result) -- so a further pass (pass 3) is needed to
      // read C's fresh text. Before the fixed-point fix this stopped after
      // one retry (pass 2) with C read from disk/absent; now it keeps going
      // until C's fresh text is actually incorporated.
      const read: string[] = [];
      let compiles = 0;
      const result = compileWithDependencies(
        (fileName) => {
          read.push(fileName);
          if (fileName === "/project/B.mx") return "fresh-b";
          if (fileName === "/project/C.mx") return "fresh-c";
          return undefined;
        },
        [],
        () => {
          compiles++;
          // Pass 1 (no deps yet read): discovers B only.
          // Pass 2 (B's fresh text read): discovers B and C, since B's
          // fresh source is what reveals the import of C.
          // Pass 3 (B and C's fresh text read): the set is stable.
          return compiles === 1
            ? { dependencies: ["/project/B.mx"], pass: compiles }
            : {
                dependencies: ["/project/B.mx", "/project/C.mx"],
                pass: compiles,
              };
        },
      );

      expect(compiles).toBe(3);
      expect(read).toEqual(["/project/B.mx", "/project/B.mx", "/project/C.mx"]);
      expect(result.pass).toBe(3);
      expect(result.dependencies).toEqual(["/project/B.mx", "/project/C.mx"]);
    });

    it("terminates a dependency cycle (A -> B -> A) within the pass cap", () => {
      const read: string[] = [];
      let compiles = 0;
      const result = compileWithDependencies(
        (fileName) => {
          read.push(fileName);
          return `fresh-${fileName}`;
        },
        [],
        () => {
          compiles++;
          // A and B always report each other: the dependency set never
          // grows, but it also never stabilizes source-for-source on the
          // very first pass (there is no `previousDependencies` yet), so at
          // least one retry runs before `sameDependencies` (an unchanging
          // set) stops the loop.
          return {
            dependencies: ["/project/A.mx", "/project/B.mx"],
            pass: compiles,
          };
        },
      );

      expect(compiles).toBeLessThanOrEqual(8);
      expect(result.dependencies).toEqual(["/project/A.mx", "/project/B.mx"]);
    });

    it("caps at 8 passes for a chain that keeps discovering a new dependency every pass", () => {
      const result = compileWithDependencies(
        (fileName) => `fresh-${fileName}`,
        [],
        (() => {
          let compiles = 0;
          return () => {
            compiles++;
            // Every pass reports one more dependency than the last, so the
            // set is never stable and the loop only stops at the cap.
            const dependencies = Array.from(
              { length: compiles },
              (_, index) => `/project/Dep${index}.mx`,
            );
            return { dependencies, compiles };
          };
        })(),
      );

      expect(result.compiles).toBe(8);
      expect(result.dependencies).toHaveLength(8);
    });

    it("warns exactly once, naming the unsettled chain, when the cap is reached", () => {
      const result = compileWithDependencies(
        (fileName) => `fresh-${fileName}`,
        [],
        (() => {
          let compiles = 0;
          return () => {
            compiles++;
            const dependencies = Array.from(
              { length: compiles },
              (_, index) => `/project/Dep${index}.mx`,
            );
            return { dependencies, warnings: [] as MxWarning[] };
          };
        })(),
      );

      expect(result.warnings).toHaveLength(1);
      const warning = result.warnings?.[0];
      if (!warning) throw new Error("expected a warning");
      expect(warning.message).toContain("8 passes");
      expect(warning.message).toContain("/project/Dep0.mx");
      expect(warning.message).toContain("/project/Dep7.mx");
      expect(warning.line).toBe(1);
      expect(warning.column).toBe(0);
    });

    it("produces no warning when the chain genuinely settles on its 8th (final) compile", () => {
      // Reproduces the exact off-by-one the loop's fixed-point check misses:
      // the check runs at the *top* of each iteration against the previous
      // pass's result, so it validates compiles #1 through #7 but never the
      // 8th, cap-exhausting compile. A chain that keeps discovering a new
      // dependency through pass 7 and then genuinely settles on pass 8 must
      // not warn -- it converged, it just took every available pass to do
      // so.
      const read: string[] = [];
      const result = compileWithDependencies(
        (fileName) => {
          read.push(fileName);
          return `fresh-${fileName}`;
        },
        [],
        (() => {
          let compiles = 0;
          return () => {
            compiles++;
            // Passes 1-7 each discover one more dependency than the last
            // (same growth shape as the never-settling test above); pass 8
            // reports the exact same 7-dependency set pass 7 did, so the
            // loop's *final* compile is the one that settles.
            const length = Math.min(compiles, 7);
            const dependencies = Array.from(
              { length },
              (_, index) => `/project/Dep${index}.mx`,
            );
            return { dependencies, compiles, warnings: [] as MxWarning[] };
          };
        })(),
      );

      expect(result.compiles).toBe(8);
      expect(result.dependencies).toHaveLength(7);
      expect(result.warnings).toEqual([]);
    });

    it("produces no warning when the dependency set reaches a fixed point", () => {
      const result = compileWithDependencies(
        (fileName) => `fresh-${fileName}`,
        [],
        () => ({
          dependencies: ["/project/Card.mx"],
          warnings: [] as MxWarning[],
        }),
      );

      expect(result.warnings).toEqual([]);
    });

    it("produces no warning when a dependency cycle settles source-for-source", () => {
      const result = compileWithDependencies(
        (fileName) => `fresh-${fileName}`,
        [],
        () => ({
          dependencies: ["/project/A.mx", "/project/B.mx"],
          warnings: [] as MxWarning[],
        }),
      );

      expect(result.warnings).toEqual([]);
    });

    it("threads compileWithDependencies's warnings through a real caller's compile diagnostics with no false positive (mx-language.ts)", () => {
      // A real multi-pass caller: Card's Input declares `AttrTag<A0>`, and
      // A0 -> A1 -> A2 is only revealed hop-by-hop as each alias file's
      // *unsaved* (host-held) text is read fresh on a later pass -- the
      // same shape as the `readCalleeInput` chain test above, driven this
      // time through `createMxLanguagePlugin`'s real `createVirtualCode`
      // and `getCompileDiagnostics`, not a synthetic `compile` callback.
      // Bounded to 3 hops (well under `readCalleeInput`'s own
      // `MAX_ALIAS_DEPTH`, 4, which a single pass's alias-following cannot
      // exceed independent of `MAX_COMPILE_PASSES`), so this caller
      // converges to a fixed point within the cap -- proving the real
      // wiring (`mx-language.ts`'s `warnings.map(...)` into
      // `compileDiagnostics`) carries an empty `warnings` array through as
      // no diagnostic, not a false-positive cap warning, for an ordinary
      // multi-pass compile.
      const dir = `${here}/fixtures/preact-policy/multi-pass-caller`;
      mkdirSync(dir, { recursive: true });
      try {
        const aliasPath = (index: number) => join(dir, `Alias${index}.ts`);
        const cardPath = join(dir, "Card.mx");
        const callerPath = join(dir, "caller.mx");
        const hopCount = 3;

        writeFileSync(
          cardPath,
          [
            'import type { A0 } from "./Alias0.ts";',
            "export interface Input { tab: AttrTag<A0> }",
            "<div/>",
          ].join("\n"),
        );
        for (let index = 0; index < hopCount; index++) {
          writeFileSync(
            aliasPath(index),
            `export type A${index} = { attrs: { title: string } };\n`,
          );
        }
        const unsavedText = new Map<string, string>();
        for (let index = 0; index < hopCount - 1; index++) {
          unsavedText.set(
            aliasPath(index),
            [
              `export type A${index} = A${index + 1};`,
              `import type { A${index + 1} } from "./Alias${index + 1}.ts";`,
            ].join("\n"),
          );
        }
        const readSource = (fileName: string) => unsavedText.get(fileName);

        const callerSource =
          'import Card from "./Card.mx"\n<Card><@tab title="x"/></Card>\n';
        writeFileSync(callerPath, callerSource);

        const plugin = createMxLanguagePlugin(ts, { readSource });
        const virtual = plugin.createVirtualCode?.(
          callerPath,
          MX_LANGUAGE_ID,
          ts.ScriptSnapshot.fromString(callerSource),
          { getAssociatedScript: () => undefined },
        );
        if (!virtual) throw new Error("Expected MX virtual code");
        expect(plugin.getSyntaxError?.(callerPath)).toBeUndefined();

        const diagnostics = plugin.getCompileDiagnostics(callerPath);
        expect(diagnostics.some((d) => d.category === "error")).toBe(false);
        expect(diagnostics.some((d) => d.category === "warning")).toBe(false);
      } finally {
        resetCalleeInputCache();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

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

    expect(astroVirtual?.mappings).toEqual([]);
    expect(
      astroVirtual?.snapshot.getText(0, astroVirtual.snapshot.getLength()),
    ).toContain("export default");
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
    ).toContain(
      '<button title={__mxAttrValue("title", count, "button")}>count</button>',
    );
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
    expect(generated).toContain("export default function Card(props: Input) {");
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

  describe("failed compile leaves a typed stub module (ts2306-cascade)", () => {
    const consumerSource = [
      'import Broken from "./broken.EXT";',
      'import { Input, helper } from "./broken.EXT";',
      'import type { Input as TypeOnly, Shape } from "./broken.EXT";',
      'import * as NS from "./broken.EXT";',
      "export const uses: [unknown, unknown, unknown, unknown, unknown, Input<string>, TypeOnly, Shape<1, 2>] = [Broken, helper, NS.default, NS.helper, NS.Input, null as never, null as never, null as never];",
      "",
    ].join("\n");
    const brokenBody = [
      "export interface Input<T = unknown> { v: T }",
      "export interface Shape<A, B> { a: A; b: B }",
      "export const helper = 1;",
    ].join("\n");

    for (const [label, ext, broken, code] of [
      [
        "whole-file .mx",
        "mx",
        `${brokenBody}\n<await=value>oops</await>`,
        80001,
      ],
      [
        "Solid .solid.mx",
        "solid.mx",
        "const el = <button>oops;\n" + brokenBody,
        80001,
      ],
    ] as const) {
      it(`reports only the real compile error for every import form (${label})`, () => {
        const fileName = `/project/broken.${ext}`;
        const consumer = "/project/index.ts";
        const service = createPluginService(
          {
            [fileName]: broken,
            [consumer]: consumerSource.replaceAll("EXT", ext),
          },
          [consumer],
        );

        const semantic = service.getSemanticDiagnostics(consumer);
        expect(
          semantic.map((d) => d.code),
          semantic.map((d) => String(d.messageText)).join("\n"),
        ).toEqual([]);
        const own = service.getSyntacticDiagnostics(fileName);
        expect(own).toHaveLength(1);
        expect(own[0]?.code).toBe(code);
      });
    }

    it("still reports a type error on a misused import from a clean .mx", () => {
      const clean = "/project/clean.mx";
      const consumer = "/project/index.ts";
      const service = createPluginService(
        {
          [clean]:
            "export interface Input { n: number }\n<div>${input.n}</div>",
          [consumer]:
            'import Clean, { type Input } from "./clean.mx";\nconst bad: Input = { n: "x" };\nvoid [Clean, bad];\n',
        },
        [consumer],
      );
      const codes = service.getSemanticDiagnostics(consumer).map((d) => d.code);
      expect(codes).toContain(2322);
      expect(codes).not.toContain(2306);
    });

    it("stubs a failed .astro.mx too: valid module, no mappings, every import form resolves", () => {
      const fileName = "/project/broken.astro.mx";
      const source =
        "---\nexport const helper = 1;\nexport interface Input { a: 1 }\n---\n<await=value>oops</await>\n";
      const plugin = createAmxLanguagePlugin(ts);
      const virtual = plugin.createVirtualCode?.(
        fileName,
        AMX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );
      expect(virtual?.mappings).toEqual([]);
      const stub = virtual?.snapshot.getText(0, virtual.snapshot.getLength());
      expect(stub).toContain("export default");
      const consumer = [
        'import Broken, { helper, Input } from "./stub.ts";',
        'import type { Input as T } from "./stub.ts";',
        'import * as NS from "./stub.ts";',
        "const t: T = 1; const i: Input = 2; void [Broken, helper, NS, t, i];",
      ].join("\n");
      const files: Record<string, string> = {
        "/project/stub.ts": stub ?? "",
        "/project/index.ts": consumer,
      };
      const host = ts.createCompilerHost({});
      const read = host.readFile.bind(host);
      host.readFile = (f) => files[f] ?? read(f);
      host.directoryExists = () => true;
      host.fileExists = (f) => f in files || ts.sys.fileExists(f);
      host.getSourceFile = (f, lang) =>
        files[f] === undefined
          ? undefined
          : ts.createSourceFile(f, files[f], lang);
      const program = ts.createProgram(
        ["/project/index.ts"],
        {
          strict: true,
          noEmit: true,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          noLib: true,
          allowImportingTsExtensions: true,
        },
        host,
      );
      const codes = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName === "/project/index.ts")
        .map((d) => d.code);
      expect(codes).toEqual([]);
    });
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
      markoCompiler().compileSync;
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

  it("keeps the type arguments inside an attribute method's body in the type-check virtual code (decision 140)", () => {
    // Marko builds the attribute-method shorthand's `FunctionExpression` node
    // itself (there is no literal `function (…) { … }` in the source), so it
    // carries no `start`/`end`/`loc`, and `expr()` in packages/core/src/core.ts
    // prints it from the AST. Marko's `stripTypes` pass (the default for
    // `output: "html"`) erases `typeParameters` and annotations from that AST
    // before any host sees it — so a generic call inside an attribute-method
    // body used to lose its type arguments. The virtual code is the one place
    // that matters for type checking, and the preact host's `typeCheck` mode
    // sets `stripTypes: false`, so here they survive; the runtime compile
    // still erases them (`packages/hosts/preact/src/type-check.test.ts`).
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
    expect(generated).toContain("pick<string>(5)");
  });
});

describe("declared attribute-tag values in the emitted TypeScript", () => {
  const solidDirectory = `${here}/fixtures/solid-policy`;
  const preactDirectory = `${here}/fixtures/preact-policy`;
  const solidCard = [
    'import type { AttrTag } from "@mxlang/solid";',
    "export interface Input {",
    '  b?: AttrTag<{ as: "renderable" }>;',
    '  row?: AttrTag<{ as: "renderable"; params: [count: number] }>;',
    "  tab?: AttrTag<{ attrs: { title: string } }>;",
    "}",
    "export default function RenderCard(_input: Input) { return null; }",
  ].join("\n");
  const preactCard = [
    "export interface Input {",
    '  b?: AttrTag<{ as: "renderable" }>;',
    '  row?: AttrTag<{ as: "renderable"; params: [count: number] }>;',
    "  tab?: AttrTag<{ attrs: { title: string } }>;",
    "}",
    "<div/>",
  ].join("\n");

  function solidCaller(...views: string[]): Record<string, string> {
    return {
      [`${solidDirectory}/RenderCard.solid.mx`]: solidCard,
      [`${solidDirectory}/RenderCaller.solid.mx`]: [
        'import RenderCard from "./RenderCard.solid.mx";',
        ...views.map(
          (view, index) =>
            `export const view${index} = (show: boolean) => (\n${view}\n);`,
        ),
      ].join("\n"),
    };
  }

  function preactCaller(...views: string[]): Record<string, string> {
    return {
      [`${preactDirectory}/RenderCard.mx`]: preactCard,
      [`${preactDirectory}/RenderCaller.mx`]: [
        'import RenderCard from "./RenderCard.mx"',
        "export interface Input { show: boolean }",
        ...views,
      ].join("\n"),
    };
  }

  const valid = {
    text: "<RenderCard>\n<@b>\nB\n</@b>\n</RenderCard>",
    element: "<RenderCard>\n<@b>\n<strong>B</strong>\n</@b>\n</RenderCard>",
    params:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<RenderCard>\n<@row|count|>\n<strong>${count.toFixed(1)}</strong>\n</@row>\n</RenderCard>",
    data: '<RenderCard>\n<@tab title="a"/>\n</RenderCard>',
  };

  it.each([
    [
      "solid",
      solidCaller(
        valid.text,
        valid.element,
        valid.params,
        valid.data,
        "<RenderCard>\n<if=show>\n<@b>\n<strong>B</strong>\n</@b>\n</if>\n</RenderCard>",
      ),
      `${solidDirectory}/RenderCaller.solid.mx`,
    ],
    [
      "preact",
      preactCaller(
        valid.text,
        valid.element,
        valid.params,
        valid.data,
        "<RenderCard>\n<if=input.show>\n<@b>\n<strong>B</strong>\n</@b>\n</if>\n</RenderCard>",
      ),
      `${preactDirectory}/RenderCaller.mx`,
    ],
  ])(
    "accepts every valid %s caller of a declared renderable, params and data tag",
    (host, files, caller) => {
      const checked = emittedDiagnostics(files, caller, host);

      // Every value carries the check, so an empty list is not vacuous.
      expect(checked.code.match(/\bsatisfies\b/g)).toHaveLength(5);
      expect(checked.diagnostics).toEqual([]);
    },
  );

  it.each([
    [
      "solid",
      solidCaller(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
        "<RenderCard>\n<@row|count|>\n<strong>${count.toUpperCase()}</strong>\n</@row>\n</RenderCard>",
      ),
      `${solidDirectory}/RenderCaller.solid.mx`,
    ],
    [
      "preact",
      preactCaller(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
        "<RenderCard>\n<@row|count|>\n<strong>${count.toUpperCase()}</strong>\n</@row>\n</RenderCard>",
      ),
      `${preactDirectory}/RenderCaller.mx`,
    ],
  ])(
    "rejects a %s caller that misuses a declared param",
    (host, files, caller) => {
      const checked = emittedDiagnostics(files, caller, host);

      expect(checked.diagnostics).toEqual([
        {
          code: 2339,
          text: "Property 'toUpperCase' does not exist on type 'number'.",
        },
      ]);
    },
  );

  it.each([
    ["solid", solidCaller("<RenderCard>\n<@tab title=1/>\n</RenderCard>")],
    ["preact", preactCaller("<RenderCard>\n<@tab title=1/>\n</RenderCard>")],
  ])("rejects a %s caller with a wrong attribute type", (host, files) => {
    const caller = Object.keys(files)[1] as string;
    const checked = emittedDiagnostics(files, caller, host);

    // One mistake, two reports: `satisfies` rejects the value at the
    // attribute, and the JSX prop then rejects the value it was given.
    expect(checked.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      2322, 2322,
    ]);
    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.text).join("\n"),
    ).toContain("Type 'number' is not assignable to type 'string'.");
  });

  it.each([
    [
      "an accessor",
      "export const value = () => 1 satisfies () => number;",
      [1360],
    ],
    [
      "a parenthesized accessor",
      "export const value = (() => 1) satisfies () => number;",
      [],
    ],
    [
      "a conditional",
      "declare const show: boolean;\nexport const value = show ? () => 1 : undefined satisfies () => number;",
      [1360],
    ],
  ])(
    "documents that `satisfies` binds tighter than %s",
    (_shape, source, codes) => {
      const fileName = `${solidDirectory}/precedence.ts`;
      const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        types: [],
      };
      const host = ts.createCompilerHost(options);
      const getSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (name, languageVersion, ...rest) =>
        name === fileName
          ? ts.createSourceFile(name, source, languageVersion, true)
          : getSourceFile(name, languageVersion, ...rest);
      const program = ts.createProgram({
        rootNames: [fileName],
        options,
        host,
      });

      expect(
        program
          .getSemanticDiagnostics(program.getSourceFile(fileName))
          .map((diagnostic) => diagnostic.code),
      ).toEqual(codes);
    },
  );
});

describe("hidden type errors in the Solid virtual code (solid-virtual-code-hidden-errors)", () => {
  const solidDirectory = `${here}/fixtures/solid-hidden-errors`;

  it("does not report TS2304 for `Show`, emitted by `<if>` with no import", () => {
    const files = {
      [`${solidDirectory}/if.solid.mx`]: [
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if.solid.mx`,
      "solid",
    );

    expect(checked.diagnostics).toEqual([]);
  });

  it("does not report TS2322/implicit-any for `onKeyDown`/`onDblClick` handlers", () => {
    const files = {
      [`${solidDirectory}/events.solid.mx`]: [
        "export default function C() {",
        "  return (",
        "    <div",
        "      onKeyDown=(e) => e.key",
        "      onDblClick=(e) => e.detail",
        "    >text</div>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/events.solid.mx`,
      "solid",
    );

    expect(checked.diagnostics).toEqual([]);
  });

  it("still surfaces a real type error inside a `<Show>` child, mapped to source", () => {
    const files = {
      [`${solidDirectory}/if-error.solid.mx`]: [
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
        "      <div>${(1).toUpperCase()}</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-error.solid.mx`,
      "solid",
    );
    expect(checked.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      2339,
    ]);
  });

  it("still surfaces a real type error in a handler parameter, mapped to source", () => {
    const files = {
      [`${solidDirectory}/events-error.solid.mx`]: [
        "export default function C() {",
        "  return <div onKeyDown=(e: string) => e.length>text</div>;",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/events-error.solid.mx`,
      "solid",
    );

    expect(checked.diagnostics.length).toBeGreaterThan(0);
  });

  it("does not append a duplicate `Show` import for a multi-line user import", () => {
    const files = {
      [`${solidDirectory}/if-multiline-import.solid.mx`]: [
        "import {",
        "  Show,",
        '} from "solid-js";',
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-multiline-import.solid.mx`,
      "solid",
    );

    expect(checked.diagnostics).toEqual([]);
    expect(checked.code.match(/"solid-js"/g)?.length).toBe(1);
  });

  it("still imports `Show` when the user's own import aliases it away", () => {
    const files = {
      [`${solidDirectory}/if-aliased-import.solid.mx`]: [
        'import { Show as MyShow } from "./local-show.ts";',
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-aliased-import.solid.mx`,
      "solid",
    );

    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
    expect(checked.code).toContain('import { Show } from "solid-js"');
  });

  it("does not append `Show` when the file binds it with a local `const`", () => {
    const files = {
      [`${solidDirectory}/if-local-const.solid.mx`]: [
        "const Show = (props: { when: unknown; children: unknown }) =>",
        "  props.when ? props.children : null;",
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-local-const.solid.mx`,
      "solid",
    );

    expect(checked.code.match(/from "solid-js"/g)).toBeNull();
    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
  });

  it("still imports `Show` when the file only declares `type Show = ...`, a type-only name", () => {
    // A `type` alias introduces no value, so `<Show>` in the emitted JSX
    // still needs the built-in import — this must not be treated the same
    // as a local `const Show` (the previous test).
    const files = {
      [`${solidDirectory}/if-type-alias.solid.mx`]: [
        "type Show = { when: unknown; children: unknown };",
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-type-alias.solid.mx`,
      "solid",
    );

    expect(checked.code).toContain('import { Show } from "solid-js"');
    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
  });

  it("still imports `Show` when the file only declares `interface Show { ... }`, a type-only name", () => {
    const files = {
      [`${solidDirectory}/if-interface.solid.mx`]: [
        "interface Show { when: unknown; children: unknown }",
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-interface.solid.mx`,
      "solid",
    );

    expect(checked.code).toContain('import { Show } from "solid-js"');
    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
  });

  it("does not append `Show` when the file binds it with `declare const Show`, a value binding", () => {
    // `declare const` introduces a real value binding (Babel parses it as an
    // ordinary `VariableDeclaration` with a `declare` flag), unlike `type`/
    // `interface` above, so it suppresses the built-in import the same way
    // an ordinary `const Show = ...` does.
    const files = {
      [`${solidDirectory}/if-declare-const.solid.mx`]: [
        "declare const Show: (props: { when: unknown; children: unknown }) => unknown;",
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-declare-const.solid.mx`,
      "solid",
    );

    expect(checked.code.match(/from "solid-js"/g)).toBeNull();
    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
  });

  it("handles a mix of multi-line, aliased and locally-bound names in one file", () => {
    const files = {
      [`${solidDirectory}/mixed-bindings.solid.mx`]: [
        "import {",
        "  For,",
        '} from "solid-js";',
        'import { Show as MyShow } from "./local-show.ts";',
        "export interface Input { items: string[]; show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <div>",
        "      <for|item| of=input.items>",
        "        <div>item</div>",
        "      </for>",
        "      <if=input.show>",
        "        <div>shown</div>",
        "      </if>",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/mixed-bindings.solid.mx`,
      "solid",
    );

    // `For` is already bound (multi-line import) plus the appended `Show`.
    expect(checked.code.match(/"solid-js"/g)?.length).toBe(2);
    // `Show` is needed (the user's `Show` binds to a different local name).
    expect(checked.code).toContain('import { Show } from "solid-js"');
    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
  });

  it("still imports `Show` when the user has only a type-only import of it", () => {
    const files = {
      [`${solidDirectory}/if-type-only-import.solid.mx`]: [
        'import type { Show } from "some-types-only-module";',
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-type-only-import.solid.mx`,
      "solid",
    );

    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
    expect(checked.code).toContain('import { Show } from "solid-js"');
  });

  it("still imports `Show` when only an inline `type` specifier names it", () => {
    const files = {
      [`${solidDirectory}/if-inline-type-specifier.solid.mx`]: [
        'import { type Show, For } from "some-types-only-module";',
        "export interface Input { show: boolean; items: string[]; }",
        "export default function C(input: Input) {",
        "  return (",
        "    <div>",
        "      <for|item| of=input.items>",
        "        <div>item</div>",
        "      </for>",
        "      <if=input.show>",
        "        <div>shown</div>",
        "      </if>",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-inline-type-specifier.solid.mx`,
      "solid",
    );

    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
    // `For` is a real value binding from the user's import — not re-imported.
    expect(checked.code.match(/"solid-js"/g)?.length).toBe(1);
    expect(checked.code).toContain('import { Show } from "solid-js"');
  });

  it("does not append `Show` when a namespace import merely shadows it indirectly", () => {
    const files = {
      [`${solidDirectory}/if-namespace-import.solid.mx`]: [
        'import * as SolidJs from "solid-js";',
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  SolidJs;",
        "  return (",
        "    <if=input.show>",
        "      <div>shown</div>",
        "    </if>",
        "  );",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-namespace-import.solid.mx`,
      "solid",
    );

    // The namespace import binds only `SolidJs`, never `Show` — the built-in
    // import is still needed and appended.
    expect(
      checked.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain(2304);
    expect(checked.code).toContain('import { Show } from "solid-js"');
  });

  it("does not append `Show` when the file has its own default-imported `Show`", () => {
    const files = {
      [`${solidDirectory}/if-default-import.solid.mx`]: [
        'import Show from "./my-own-show.ts";',
        "export interface Input { show: boolean; }",
        "export default function C(input: Input) {",
        "  return <Show when=input.show><div>shown</div></Show>;",
        "}",
      ].join("\n"),
    };
    const checked = emittedDiagnostics(
      files,
      `${solidDirectory}/if-default-import.solid.mx`,
      "solid",
    );

    expect(checked.code.match(/"solid-js"/g)).toBeNull();
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
          plugin.getLanguageId?.("/project/src/page.astro.mx") === "astromx",
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
          plugin.getLanguageId?.("/project/src/page.astro.mx") === "astromx",
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
  it("recognizes .astro.mx and exposes composed TSX virtual code", () => {
    const source = [
      "---",
      "const items = [1, 2, 3];",
      "---",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<for|item| of=items><p>${item}</p></for>",
    ].join("\n");
    const plugin = createAmxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      "/src/page.astro.mx",
      AMX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );

    expect(plugin.getLanguageId("/src/page.astro.mx")).toBe("astromx");
    expect(plugin.getLanguageId("/src/page.astro")).toBeUndefined();
    if (!virtual) throw new Error("Expected AstroMX virtual code");
    expect(virtual.languageId).toBe("typescriptreact");
    expect(virtual.snapshot.getText(0, virtual.snapshot.getLength())).toContain(
      "? [...mxList] : [])(items).map((item) =>",
    );
    expect(virtual.mappings.length).toBeGreaterThan(0);
    expect(plugin.typescript?.extraFileExtensions).toEqual([
      {
        extension: "astro.mx",
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
      "/src/column.astro.mx",
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
      filename: "/src/partial.astro.mx",
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
      "function Card(input: Input): string {",
      '  return "";',
      "}",
      "",
      "export default Card;",
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

/**
 * Type-checks the TypeScript one MX file compiles to and returns every
 * diagnostic TypeScript raises in it.
 *
 * `createPluginService` cannot stand in for this. It reports through Volar,
 * which drops a diagnostic whose position has no mapping, and most of an
 * attribute-tag value is generated code: a check applied to the wrong
 * expression fails there without anyone seeing it.
 */
function emittedDiagnostics(
  files: Record<string, string>,
  caller: string,
  host: string,
): { code: string; diagnostics: Array<{ code: number; text: string }> } {
  const readSource = (fileName: string) => files[fileName];
  const solidMx = createSolidMxLanguagePlugin(ts, { readSource });
  const mx = createMxLanguagePlugin(ts, { readSource });
  const emitted = new Map<string, string>();
  for (const [fileName, source] of Object.entries(files)) {
    const snapshot = ts.ScriptSnapshot.fromString(source);
    const context = { getAssociatedScript: () => undefined };
    const virtual = fileName.endsWith(".solid.mx")
      ? solidMx.createVirtualCode?.(
          fileName,
          SOLID_MX_LANGUAGE_ID,
          snapshot,
          context,
        )
      : mx.createVirtualCode?.(fileName, MX_LANGUAGE_ID, snapshot, context);
    if (!virtual) throw new Error(`Expected virtual code for ${fileName}`);
    const compileErrors = [
      ...solidMx.getCompileDiagnostics(fileName),
      ...mx.getCompileDiagnostics(fileName),
    ].filter((diagnostic) => diagnostic.category === "error");
    if (compileErrors.length > 0) {
      throw new Error(
        `${fileName} did not compile: ${compileErrors[0]?.message}`,
      );
    }
    emitted.set(
      `${fileName}.tsx`,
      virtual.snapshot.getText(0, virtual.snapshot.getLength()),
    );
  }

  const repoRoot = join(here, "..", "..", "..", "..");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    jsxImportSource: host === "solid" ? "@solidjs/web" : "preact",
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: [],
    baseUrl: repoRoot,
    paths: {
      "@mxlang/core": [join(repoRoot, "packages/core/src/index.ts")],
      "@mxlang/preact": [join(repoRoot, "packages/hosts/preact/src/index.ts")],
      "@mxlang/solid": [join(repoRoot, "packages/hosts/solid/src/index.ts")],
      "@mxlang/parser": [join(repoRoot, "packages/parser/src/public.d.ts")],
    },
    ignoreDeprecations: "6.0",
  };
  const compilerHost = ts.createCompilerHost(options);
  const fileExists = compilerHost.fileExists.bind(compilerHost);
  const readFile = compilerHost.readFile.bind(compilerHost);
  const getSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.fileExists = (fileName) =>
    emitted.has(fileName) || fileExists(fileName);
  compilerHost.readFile = (fileName) =>
    emitted.get(fileName) ?? readFile(fileName);
  compilerHost.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = emitted.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(
          fileName,
          text,
          languageVersion,
          true,
          ts.ScriptKind.TSX,
        );
  };
  compilerHost.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      const resolved = `${join(dirname(containingFile), literal.text)}.tsx`;
      if (literal.text.endsWith(".mx") && emitted.has(resolved)) {
        return {
          resolvedModule: {
            resolvedFileName: resolved,
            extension: ts.Extension.Tsx,
            isExternalLibraryImport: false,
          },
        };
      }
      return {
        resolvedModule: ts.resolveModuleName(
          literal.text,
          containingFile,
          options,
          compilerHost,
        ).resolvedModule,
      };
    });

  const rootName = `${caller}.tsx`;
  const program = ts.createProgram({
    rootNames: [rootName],
    options,
    host: compilerHost,
  });
  const file = program.getSourceFile(rootName);
  if (!file) throw new Error(`Expected a source file for ${rootName}`);
  return {
    code: emitted.get(rootName) ?? "",
    diagnostics: [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ].map((diagnostic) => ({
      code: diagnostic.code,
      text: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    })),
  };
}

function createPluginService(
  files: Record<string, string>,
  rootFiles: string[],
): ts.LanguageService {
  return createMutablePluginService(files, rootFiles).service;
}

function createMutablePluginService(
  files: Record<string, string>,
  rootFiles: string[],
  hooks: {
    refreshDiagnostics?: () => void;
    log?: (m: string) => void;
    /** No tsconfig on disk: the real worker then checks under defaults. */
    inferredProject?: boolean;
    /** Per-file `isScriptOpen` (test-only); every file is open by default. */
    isOpen?: (fileName: string) => boolean;
  } = {},
): {
  service: ts.LanguageService;
  project: { close(): void };
  setFile(fileName: string, source: string): void;
} {
  const snapshots = new Map(
    Object.entries(files).map(([fileName, source]) => [
      fileName,
      ts.ScriptSnapshot.fromString(source),
    ]),
  );
  const versions = new Map(Object.keys(files).map((fileName) => [fileName, 0]));
  const repoRoot = join(here, "..", "..", "..", "..");
  const options: ts.CompilerOptions = {
    strict: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    allowArbitraryExtensions: true,
    allowImportingTsExtensions: true,
    baseUrl: repoRoot,
    paths: {
      "@mxlang/core": [join(repoRoot, "packages/core/src/index.ts")],
      "@mxlang/html": [join(repoRoot, "packages/targets/html/src/index.ts")],
      "@mxlang/preact": [join(repoRoot, "packages/hosts/preact/src/index.ts")],
      "@mxlang/solid": [join(repoRoot, "packages/hosts/solid/src/index.ts")],
      "@mxlang/parser": [join(repoRoot, "packages/parser/src/public.d.ts")],
    },
    ignoreDeprecations: "6.0",
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => rootFiles,
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
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
    projectKind: hooks.inferredProject
      ? ts.server.ProjectKind.Inferred
      : ts.server.ProjectKind.Configured,
    getProjectName: () => "/project/tsconfig.json",
    getCurrentDirectory: () => "/project",
    getScriptVersion: (fileName: string) => String(versions.get(fileName) ?? 0),
    getScriptInfo: (fileName: string) => {
      const snapshot = snapshots.get(fileName);
      return snapshot
        ? {
            getSnapshot: () => snapshot,
            isScriptOpen: () => hooks.isOpen?.(fileName) ?? true,
          }
        : undefined;
    },
    readFile: host.readFile,
    fileExists: host.fileExists,
    readDirectory: host.readDirectory,
    useCaseSensitiveFileNames: () => true,
    refreshDiagnostics: () => hooks.refreshDiagnostics?.(),
    close: () => undefined,
    getCanonicalFileName: (fileName: string) => fileName,
    getModuleResolutionCache: () => undefined,
    projectService: {
      host: ts.sys,
      logger: { info: (message: string) => hooks.log?.(message) },
    },
  };
  const info = {
    project,
    languageService,
    languageServiceHost: host,
    serverHost: ts.sys,
    config: {},
    session: {
      change: ({ file }: { file: string }) => {
        versions.set(file, (versions.get(file) ?? 0) + 1);
      },
    },
  } as unknown as ts.server.PluginCreateInfo;

  const service = pluginFactory({ typescript: ts }).create(info);
  return {
    service,
    project,
    setFile(fileName, source) {
      snapshots.set(fileName, ts.ScriptSnapshot.fromString(source));
      versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
    },
  };
}

describe(".ng.mx language plugin", () => {
  const dir = `${here}/fixtures/angular-ngmx`;
  const stub = [
    "export function Component(_: object): ClassDecorator {",
    "  return () => undefined;",
    "}",
  ].join("\n");
  const component = (template: string, body: string) =>
    [
      'import { Component } from "./stub.ts";',
      "",
      "@Component({",
      '  selector: "app-x",',
      `  template: ${template},`,
      "})",
      `export class XComponent { ${body} }`,
    ].join("\n");

  function diagnosticsOf(source: string, fixtureDir = dir) {
    const file = `${fixtureDir}/x.component.ng.mx`;
    const consumer = `${fixtureDir}/consumer.ts`;
    const service = createPluginService(
      {
        [file]: source,
        [`${fixtureDir}/stub.ts`]: stub,
        [consumer]: 'import "./x.component.ng.mx";\n',
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);
    return {
      file,
      diagnostics: [
        ...service.getSyntacticDiagnostics(file),
        ...service.getSemanticDiagnostics(file),
      ],
    };
  }

  const lineCol = (diagnostic: ts.Diagnostic, source: string) => {
    const before = source.slice(0, diagnostic.start ?? 0).split("\n");
    return { line: before.length, column: (before.at(-1) ?? "").length };
  };

  it("routes .ng.mx to its own language id, not the page plugin", () => {
    const plugin = createNgMxLanguagePlugin(ts);
    expect(plugin.getLanguageId?.(`${dir}/x.component.ng.mx`)).toBe(
      NG_MX_LANGUAGE_ID,
    );
    expect(plugin.getLanguageId?.(`${dir}/x.mx`)).toBeUndefined();
    expect(plugin.getLanguageId?.(`${dir}/x.solid.mx`)).toBeUndefined();
    const mx = createMxLanguagePlugin(ts);
    expect(mx.getLanguageId?.(`${dir}/x.component.ng.mx`)).toBeUndefined();
    expect(mx.getLanguageId?.(`${dir}/x.mx`)).toBe(MX_LANGUAGE_ID);
  });

  it("reports no diagnostics for a clean file", () => {
    const { diagnostics } = diagnosticsOf(
      component("<p>${n}</p>", "n: number = 1;"),
    );
    expect(diagnostics).toEqual([]);
  });

  it("positions a class-body type error in the .ng.mx", () => {
    const source = component("<p>${n}</p>", 'n: number = "s";');
    const { diagnostics } = diagnosticsOf(source);
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    const error = diagnostics.find((d) => d.code === 2322);
    expect(error).toBeDefined();
    const line = source.split("\n").findIndex((l) => l.includes("n: number"));
    expect(lineCol(error as ts.Diagnostic, source)).toEqual({
      line: line + 1,
      column: source.split("\n")[line]?.indexOf("n: number") as number,
    });
  });

  it("keeps positions after a template region that changes the line's length", () => {
    // The region lowers to a longer/shorter literal; the class below it must
    // still map to its own source column.
    const source = component(
      "<ul><for|p| of=people by=(p => p.id)><li>${p.name}</li></for></ul>",
      'people = [{ id: 1, name: "a" }]; bad: string = 1;',
    );
    const { diagnostics } = diagnosticsOf(source);
    const error = diagnostics.find((d) => d.code === 2322);
    expect(error).toBeDefined();
    const pos = lineCol(error as ts.Diagnostic, source);
    const lines = source.split("\n");
    expect(pos.line).toBe(lines.length);
    expect(pos.column).toBe((lines.at(-1) as string).indexOf("bad"));
  });

  describe("Angular template diagnostics through the real plugin wiring", () => {
    const ngDir = join(here, "..", "fixtures", "ng-project");
    const bad = [
      'import { Component } from "@angular/core";',
      "@Component({",
      '  selector: "app-x",',
      "  standalone: true,",
      "  template: <p>${user.nmae}</p>,",
      "})",
      "export class XComponent { user = { name: 'a' }; }",
    ].join("\n");

    /** Worker processes this process has forked (the harness's real workers). */
    const workerPids = () => {
      try {
        return execFileSync("pgrep", [
          "-P",
          String(process.pid),
          "-f",
          "ng-worker",
        ])
          .toString()
          .split("\n")
          .filter(Boolean);
      } catch {
        return []; // pgrep exits 1 when nothing matches
      }
    };
    const until = async (cond: () => boolean, ms = 30_000) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    it("a known-bad .ng.mx yields source 'angular' TS2339 from getSemanticDiagnostics (silent-zero guard)", async () => {
      const file = `${ngDir}/x.component.ng.mx`;
      const consumer = `${ngDir}/consumer.ts`;
      let refreshed = 0;
      const { service, project } = createMutablePluginService(
        { [file]: bad, [consumer]: 'import "./x.component.ng.mx";\n' },
        [consumer],
        {
          refreshDiagnostics: () => {
            refreshed += 1;
          },
          inferredProject: true,
        },
      );
      try {
        // The first request compiles the file and arms the idle timer; it
        // carries no Angular diagnostics yet (they are asynchronous).
        service.getSemanticDiagnostics(file);
        await until(() => refreshed > 0);
        const found = service
          .getSemanticDiagnostics(file)
          .filter((d) => d.source === "angular");
        expect(found.length).toBeGreaterThanOrEqual(1);
        expect(found[0]?.code).toBe(2339);
        expect(found[0]?.start).toBe(bad.indexOf("user.nmae"));
      } finally {
        project.close();
      }
    }, 90_000);

    it("keeps positioned template errors when a .ng.mx calls a tags/ component", async () => {
      const fixture = join(
        here,
        "..",
        "..",
        "tsc",
        "src",
        "fixtures",
        "ng-diag-tag-import",
      );
      const file = join(fixture, "src", "x.component.ng.mx");
      const tag = join(fixture, "tags", "user-card.mx");
      const consumer = join(fixture, "consumer.ts");
      const source = readFileSync(file, "utf8");
      let refreshed = 0;
      const { service, project } = createMutablePluginService(
        {
          [file]: source,
          [tag]: readFileSync(tag, "utf8"),
          [consumer]:
            'import "./src/x.component.ng.mx";\nimport "./tags/user-card.mx";\n',
        },
        [consumer],
        {
          refreshDiagnostics: () => {
            refreshed += 1;
          },
          inferredProject: true,
        },
      );
      try {
        service.getSemanticDiagnostics(file);
        await until(() => refreshed > 0);
        const found = service.getSemanticDiagnostics(file);
        expect(
          found.map((d) => ({ code: d.code, message: d.messageText })),
        ).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ code: -991010 })]),
        );
        const typeError = found.find(
          (d) => d.source === "angular" && d.code === 2339,
        );
        expect(typeError).toBeDefined();
        expect(typeError?.start).toBe(source.indexOf("title.nmae"));
        const attributeError = found.find(
          (d) => d.source === "angular" && d.code === -998002,
        );
        expect(attributeError?.start).toBe(source.indexOf("lable=title"));
        expect(service.getSyntacticDiagnostics(tag)).toEqual([]);
      } finally {
        project.close();
      }
    }, 90_000);

    it("checks a .ng.mx that was compiled while closed once the editor asks about it", async () => {
      const file = `${ngDir}/x.component.ng.mx`;
      const consumer = `${ngDir}/consumer.ts`;
      let open = false;
      let refreshed = 0;
      const before = workerPids().length;
      const { service, project } = createMutablePluginService(
        { [file]: bad, [consumer]: 'import "./x.component.ng.mx";\n' },
        [consumer],
        {
          refreshDiagnostics: () => {
            refreshed += 1;
          },
          inferredProject: true,
          isOpen: (f) => open && f === file,
        },
      );
      try {
        // Compiled while closed (the program holds every .ng.mx): no check.
        service.getSemanticDiagnostics(file);
        await new Promise((r) => setTimeout(r, 2_000));
        expect(refreshed).toBe(0);
        expect(workerPids().length).toBe(before);
        // The file opens; no recompile happens, only the editor's request.
        open = true;
        service.getSemanticDiagnostics(file);
        await until(() => refreshed > 0);
        const found = service
          .getSemanticDiagnostics(file)
          .filter((d) => d.source === "angular");
        expect(found[0]?.code).toBe(2339);
      } finally {
        project.close();
      }
    }, 90_000);

    it("project.close() kills the worker and leaves no exit listener behind", async () => {
      const file = `${ngDir}/x.component.ng.mx`;
      const consumer = `${ngDir}/consumer.ts`;
      const listeners = process.listenerCount("exit");
      const before = workerPids().length;
      let refreshed = 0;
      const { service, project } = createMutablePluginService(
        { [file]: bad, [consumer]: 'import "./x.component.ng.mx";\n' },
        [consumer],
        {
          refreshDiagnostics: () => {
            refreshed += 1;
          },
          inferredProject: true,
        },
      );
      service.getSemanticDiagnostics(file);
      await until(() => refreshed > 0);
      expect(workerPids().length).toBeGreaterThan(before);
      expect(process.listenerCount("exit")).toBe(listeners);
      project.close();
      await until(() => workerPids().length === before, 10_000);
      expect(process.listenerCount("exit")).toBe(listeners);
    }, 90_000);
  });

  describe("retained compiles (mx-tsc's template diagnostics)", () => {
    const file = `${dir}/x.component.ng.mx`;
    const compileOn = (
      plugin: ReturnType<typeof createNgMxLanguagePlugin>,
      source: string,
    ) =>
      plugin.createVirtualCode?.(
        file,
        NG_MX_LANGUAGE_ID,
        ts.ScriptSnapshot.fromString(source),
        { getAssociatedScript: () => undefined },
      );

    it("keeps nothing unless asked: an editor must not hold every compile", () => {
      const plugin = createNgMxLanguagePlugin(ts);
      compileOn(plugin, component("<p>${n}</p>", "n: number = 1;"));
      expect(plugin.getCompiledNgMx()).toEqual([]);
    });

    it("keeps the latest successful compile per file when asked", () => {
      const plugin = createNgMxLanguagePlugin(ts, { retainCompiled: true });
      compileOn(plugin, component("<p>${n}</p>", "n: number = 1;"));
      const second = component("<p>${m}</p>", "m: number = 2;");
      compileOn(plugin, second);
      const kept = plugin.getCompiledNgMx();
      expect(kept).toHaveLength(1);
      expect(kept[0]?.fileName).toBe(file);
      expect(kept[0]?.source).toBe(second);
      expect(kept[0]?.result.code).toContain("{{ m }}");
    });

    it("leaves a no-mapping stub module when the compile fails (ts2306-cascade)", () => {
      const plugin = createNgMxLanguagePlugin(ts);
      const virtual = compileOn(
        plugin,
        component("<p>${n</p>", "export class Box<T> { n: number = 1; }"),
      );
      expect(virtual?.mappings).toEqual([]);
      const text = virtual?.snapshot.getText(0, virtual.snapshot.getLength());
      expect(text).toContain("export default");
      expect(text).toContain("Box");
    });

    it("drops a file whose recompile fails: a stale compile must not be checked", () => {
      const plugin = createNgMxLanguagePlugin(ts, { retainCompiled: true });
      compileOn(plugin, component("<p>${n}</p>", "n: number = 1;"));
      expect(plugin.getCompiledNgMx()).toHaveLength(1);
      compileOn(plugin, component("<p>${n</p>", "n: number = 1;"));
      expect(plugin.getCompiledNgMx()).toEqual([]);
    });
  });

  it("maps a template expression back to its start in the .ng.mx", () => {
    const source = component(
      "<p>${user.name.toUpperCase()}</p>",
      "user = { name: 'a' };",
    );
    const file = `${dir}/x.component.ng.mx`;
    const plugin = createNgMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      file,
      NG_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    if (!virtual) throw new Error("Expected virtual code");
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    const expression = "user.name.toUpperCase()";
    const inside = generated.indexOf(expression) + 5;
    const hit = virtual.mappings.find((mapping) => {
      const start = mapping.generatedOffsets[0] ?? 0;
      const length = mapping.generatedLengths?.[0] ?? mapping.lengths[0] ?? 0;
      return inside >= start && inside < start + length;
    });
    expect(hit).toBeDefined();
    expect(hit?.sourceOffsets[0]).toBe(source.indexOf(expression));
  });

  it("no longer hits the angular 'not wired' guard for .ng.mx", () => {
    const { diagnostics } = diagnosticsOf(component("<p>hi</p>", ""));
    expect(
      diagnostics.some((d) => String(d.messageText).includes("not wired")),
    ).toBe(false);
  });

  it("surfaces an invalid package.json#mx.angular as a positioned error, not a crash", () => {
    const bad = `${here}/fixtures/angular-ngmx-bad-config`;
    const { diagnostics } = diagnosticsOf(component("<p>hi</p>", ""), bad);
    const config = diagnostics.filter((d) =>
      String(d.messageText).includes("notAKey"),
    );
    expect(config).toHaveLength(1);
    expect(config[0]?.category).toBe(ts.DiagnosticCategory.Error);
    expect(config[0]?.start).toBe(0);
    // Names the file the author has to fix, not just the key.
    expect(String(config[0]?.messageText)).toContain(`${bad}/package.json`);
  });

  it("names package.json and the key for a wrongly typed config value", () => {
    const bad = `${here}/fixtures/angular-ngmx-bad-type`;
    const { diagnostics } = diagnosticsOf(component("<p>hi</p>", ""), bad);
    const config = diagnostics.filter((d) =>
      String(d.messageText).includes("tagSelectorPrefix"),
    );
    expect(config).toHaveLength(1);
    const text = String(config[0]?.messageText);
    expect(text).toContain(`${bad}/package.json`);
    expect(text).toContain("mx.angular.tagSelectorPrefix");
  });

  it("keeps the host-policy guard for angular .mx pages", () => {
    const angularFile = `${here}/fixtures/angular-policy/card.mx`;
    const plugin = createMxLanguagePlugin(ts);
    plugin.createVirtualCode?.(
      angularFile,
      MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString("<div>hi</div>"),
      { getAssociatedScript: () => undefined },
    );
    expect(plugin.getSyntaxError(angularFile)?.message).toContain(
      "the angular host is not wired into @mxlang/typescript-plugin yet",
    );
  });
});

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

describe("host-policy diagnostics through tsserver", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    clearScanCache();
  });

  /** A real directory holding `package.json`: host resolution reads the disk. */
  function packageDir(packageJson: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mx-ts-host-policy-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), packageJson);
    return dir;
  }

  const SOURCES: Record<string, string> = {
    "page.mx": "<div>hi</div>\n",
    "page.solid.mx": "export const X = 1;\n",
    "x.component.ng.mx": "export class X {}\n",
  };

  /** One tsserver project (one plugin instance) over `dir`'s `fileName`. */
  function project(dir: string, fileName: string) {
    const file = join(dir, fileName);
    const consumer = join(dir, "index.ts");
    const mutable = createMutablePluginService(
      {
        [file]: SOURCES[fileName] ?? "<div>hi</div>\n",
        [consumer]: `import "./${fileName}";\n`,
      },
      [consumer],
    );
    return {
      file,
      /** Builds the project, then asks for the file's own diagnostics. */
      diagnostics() {
        mutable.service.getSemanticDiagnostics(consumer);
        return mutable.service.getSyntacticDiagnostics(file);
      },
      /** An edit of the `.mx` itself (same text, new version). */
      touch() {
        mutable.setFile(file, `${SOURCES[fileName] ?? ""}\n`);
      },
    };
  }

  function hostPolicyDiagnostics(dir: string, fileName: string) {
    return project(dir, fileName).diagnostics();
  }

  const UNKNOWN = '{\n  "mx": {\n    "host": "vue"\n  }\n}\n';
  const FIXED = '{ "mx": { "host": "html" } }';

  it.each(Object.keys(SOURCES))(
    "reports target mismatch as TS80003 plus a TS80001 pointer on %s",
    (fileName) => {
      const dir = packageDir(
        JSON.stringify({ mx: { host: "solid", target: "html" } }),
      );
      const diagnostics = hostPolicyDiagnostics(dir, fileName);
      expect(diagnostics.find((d) => d.code === 80003)).toMatchObject({
        start: 0,
        category: ts.DiagnosticCategory.Error,
      });
      expect(
        diagnostics.some(
          (d) =>
            d.code === 80001 &&
            String(d.messageText).startsWith("target not resolved: see "),
        ),
      ).toBe(true);
    },
  );

  it("unknown-target errors clear when the same-service file recompiles", () => {
    const dir = packageDir('{ "mx": { "target": "bogus" } }');
    const p = project(dir, "page.mx");
    expect(p.diagnostics().find((d) => d.code === 80003)?.category).toBe(
      ts.DiagnosticCategory.Error,
    );
    writeFileSync(join(dir, "package.json"), '{ "mx": { "target": "html" } }');
    p.touch();
    expect(p.diagnostics()).toEqual([]);
  });

  it("puts an unknown mx.host on the .mx file at 1:1, as a warning in the LS's text", () => {
    const dir = packageDir(UNKNOWN);

    const [diagnostic, ...rest] = hostPolicyDiagnostics(dir, "page.mx");

    expect(rest).toEqual([]);
    expect(diagnostic).toMatchObject({
      start: 0,
      length: 0,
      source: "mx",
      code: 80003,
      category: ts.DiagnosticCategory.Warning,
    });
    // The LS's shape: `<package.json>:line:col: <message>`.
    expect(String(diagnostic?.messageText)).toMatch(
      new RegExp(
        `^${join(dir, "package.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:3:13: unknown mx\\.host "vue"; valid hosts: html`,
      ),
    );
  });

  it("puts a malformed package.json on the .mx file as a warning naming the path once", () => {
    const dir = packageDir('{ "mx": { "host": "html", }');
    const manifest = join(dir, "package.json");

    // Babel (under Marko's compiler) may also fail on the unparseable
    // package.json depending on the cwd; that error is not what is asserted.
    const diagnostic = hostPolicyDiagnostics(dir, "page.mx").find(
      (d) => d.code === 80003,
    );

    expect(diagnostic?.category).toBe(ts.DiagnosticCategory.Warning);
    const text = String(diagnostic?.messageText);
    expect(text.startsWith(`${manifest}:1:`)).toBe(true);
    expect(text).toContain("could not be parsed as JSON");
    expect(text.split(manifest).length - 1).toBe(1);
  });

  it("reports nothing for a valid host", () => {
    const dir = packageDir(FIXED);

    expect(hostPolicyDiagnostics(dir, "page.mx")).toEqual([]);
  });

  it("reports on a .ng.mx too (a24: the unknown host sits beside Angular files)", () => {
    const dir = packageDir('{ "mx": { "host": "angualr" } }');

    const diagnostics = hostPolicyDiagnostics(dir, "x.component.ng.mx");

    expect(
      diagnostics.some(
        (d) =>
          d.code === 80003 &&
          String(d.messageText).includes('Did you mean "angular"?'),
      ),
    ).toBe(true);
  });

  it("reports on a .solid.mx, with that file kind's source", () => {
    const dir = packageDir(UNKNOWN);

    const diagnostic = hostPolicyDiagnostics(dir, "page.solid.mx").find(
      (d) => d.code === 80003,
    );

    expect(diagnostic).toMatchObject({
      source: "solidmx",
      category: ts.DiagnosticCategory.Warning,
      start: 0,
    });
    expect(String(diagnostic?.messageText)).toContain('unknown mx.host "vue"');
  });

  it("keeps two projects apart: one bad host in A does not reach B, before or after A is asked again", () => {
    const bad = packageDir(UNKNOWN);
    const good = packageDir(FIXED);
    const a = project(bad, "page.mx");
    const b = project(good, "page.mx");

    expect(a.diagnostics()).toHaveLength(1);
    expect(b.diagnostics()).toHaveLength(0);
    expect(a.diagnostics()).toHaveLength(1);
    expect(b.diagnostics()).toHaveLength(0);
  });

  it("clears the warning in the same service once package.json is fixed and the .mx is edited", () => {
    const dir = packageDir(UNKNOWN);
    const p = project(dir, "page.mx");
    expect(p.diagnostics()).toHaveLength(1);

    writeFileSync(join(dir, "package.json"), FIXED);
    p.touch();

    expect(p.diagnostics()).toEqual([]);
  });

  it("pins a known limit: fixing package.json alone leaves the warning until the .mx is edited", () => {
    // The plugin does not watch package.json (the host choice itself is as
    // stale), so the warning lingers. A package.json watch is a follow-up;
    // when it lands, this test is meant to flip to `toEqual([])`.
    const dir = packageDir(UNKNOWN);
    const p = project(dir, "page.mx");
    expect(p.diagnostics()).toHaveLength(1);

    writeFileSync(join(dir, "package.json"), FIXED);

    expect(p.diagnostics()).toHaveLength(1);
  });
});

describe("TS80001 text carries one position base", () => {
  const dir = `${here}/fixtures/angular-ngmx`;
  const BABEL_SUFFIX = /\s*\(\d+:\d+\)\s*$/;
  const OPENER = /opening "span" tag at \d+:\d+$/;

  function ts80001(fileName: string, source: string): string[] {
    const consumer = `${dirname(fileName)}/consumer.ts`;
    const service = createPluginService(
      {
        [fileName]: source,
        [`${dir}/stub.ts`]:
          "export function Component(_: object): ClassDecorator { return () => undefined; }",
        [consumer]: `import "./${fileName.split("/").pop()}";\n`,
      },
      [consumer],
    );
    service.getSemanticDiagnostics(consumer);
    return service
      .getSyntacticDiagnostics(fileName)
      .filter((diagnostic) => diagnostic.code === 80001)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
  }

  it("a .solid.mx mismatch keeps ` at L:C` and drops Babel's ` (L:C)`", () => {
    const [message, ...rest] = ts80001(
      `${dir}/broken.solid.mx`,
      "export const A = <div><span>oops</div>;\n",
    );
    expect(rest).toEqual([]);
    expect(message).toMatch(OPENER);
    expect(message).not.toMatch(BABEL_SUFFIX);
  });

  it("a .ng.mx region error keeps ` at L:C` and drops Babel's ` (L:C)`", () => {
    const [message, ...rest] = ts80001(
      `${dir}/x.component.ng.mx`,
      [
        'import { Component } from "./stub.ts";',
        "@Component({",
        '  selector: "app-x",',
        "  template: <div><span>oops</div>,",
        "})",
        "export class XComponent {}",
      ].join("\n"),
    );
    expect(rest).toEqual([]);
    expect(message).toMatch(OPENER);
    expect(message).not.toMatch(BABEL_SUFFIX);
  });

  it("the language plugin's own diagnostic is already stripped", () => {
    const fileName = `${dir}/broken.solid.mx`;
    const plugin = createSolidMxLanguagePlugin(ts);
    plugin.createVirtualCode?.(
      fileName,
      SOLID_MX_LANGUAGE_ID,
      ts.ScriptSnapshot.fromString("export const A = <div><span>oops</div>;\n"),
      { getAssociatedScript: () => undefined },
    );
    const [diagnostic] = plugin.getCompileDiagnostics(fileName);
    expect(diagnostic?.message).toMatch(OPENER);
    expect(plugin.getSyntaxError(fileName)?.message).not.toMatch(BABEL_SUFFIX);
  });
});
