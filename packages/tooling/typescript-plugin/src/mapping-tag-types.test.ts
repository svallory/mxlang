import * as core from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMutablePluginService } from "./fixtures/plugin-service.ts";
import { createHtmlMappings } from "./mx-language.ts";

const prefix = "export interface Input { a: string; b: boolean }\n";
const probes = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["const", "<const<string>/y=input.a/>${y}"],
  ["let", "<let<string>/y=input.a/>"],
  ["if", "<if<string>=input.b>t</if>"],
  ["element", "<p<string>>x</p>"],
  [
    "define",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    '<define/Foo<T>|{ v }: { v: string }|><p>${v}</p></define><Foo v="x"/>',
  ],
  ["imported generic", 'import Foo from "./foo"\n<Foo<string> v="x"/>'],
] as const;
const foo =
  "export default function Foo<T>({ v }: { v: T }): string { return String(v); }";
const documents = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames);
const file = "/project/tag-types.mx";
const rawFile = "/project/projection.tsx";

function compile(source: string, typeCheck: boolean) {
  const targets = builtinLookup();
  const descriptor = targets.target("html");
  if (!descriptor?.load) throw new Error("missing html compiler");
  return descriptor
    .load(core)
    .compileModule(source, file, { typeCheck, targets });
}

function mappings(source: string, compiled: ReturnType<typeof compile>) {
  return createHtmlMappings(
    source,
    file,
    compiled.code,
    false,
    undefined,
    compiled.mappings,
  );
}

function diagnosticSet(diagnostics: readonly ts.Diagnostic[]) {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

describe("tag types in the mapping re-lower", { timeout: 60_000 }, () => {
  it.each(probes)(
    "keeps build, mapping and service diagnostics consistent for %s",
    (_, probe) => {
      const source = prefix + probe;
      const untyped = source.replace("<string>", "").replace("<T>", "");
      // Both runtime and type-check compilation already erase tag containers.
      expect(compile(source, false).code).toBe(compile(untyped, false).code);
      const compiled = compile(source, true);
      expect(compiled.code).toBe(compile(untyped, true).code);

      const consumer = "/project/consumer.ts";
      const { service, project, setFile } = createMutablePluginService(
        {
          [file]: source,
          [consumer]: 'import "./tag-types.mx";',
          "/project/foo.ts": foo,
          "/project/tsconfig.json": "{}",
          [rawFile]: compiled.code,
        },
        [consumer, rawFile],
        { documentRegistry: documents },
      );
      try {
        // A real importer ensures Volar loads each template as a module.
        expect(diagnosticSet(service.getSemanticDiagnostics(consumer))).toEqual(
          [],
        );
        expect(diagnosticSet(service.getSyntacticDiagnostics(file))).toEqual(
          [],
        );
        expect(service.getSemanticDiagnostics(file)).toEqual([]);
        expect(mappings(source, compiled).length).toBeGreaterThan(0);
        expect(service.getSyntacticDiagnostics(rawFile)).toEqual([]);
        expect(service.getSemanticDiagnostics(rawFile)).toEqual([]);

        // A genuine semantic error must survive the mapping pass and point at
        // the authored property, not generated scaffolding or the tag head.
        const broken = `${source}\n<p>\${input.missing}</p>`;
        const brokenCompile = compile(broken, true);
        expect(mappings(broken, brokenCompile).length).toBeGreaterThan(0);
        setFile(file, broken);
        setFile(rawFile, brokenCompile.code);
        expect(diagnosticSet(service.getSyntacticDiagnostics(file))).toEqual(
          [],
        );
        const diagnostics = service.getSemanticDiagnostics(file);
        expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
          2339,
        ]);
        expect(diagnostics[0]?.start).toBe(broken.indexOf("missing"));
        expect(diagnostics[0]?.length).toBe("missing".length);
        // Compare the diagnostics from the typeCheck compile's raw TSX with
        // the same source through the real service's independent mapping pass.
        expect(diagnosticSet(diagnostics)).toEqual(
          diagnosticSet(service.getSemanticDiagnostics(rawFile)),
        );
      } finally {
        project.close();
        service.dispose();
      }
    },
  );

  it.each([
    ["as", "input.a as number", 2352, "input.a as number"],
    ["satisfies", "input.a satisfies number", 1360, "satisfies"],
    ["non-null", "input.a!.missing", 2339, "missing"],
  ] as const)(
    "retains %s wrappers and their exact mappings",
    (_, expression, code, token) => {
      const source = `${prefix}<p<string>>${"${"}${expression}}</p>`;
      const compiled = compile(source, true);
      expect(compiled.code).toContain(expression);
      const mapped = mappings(source, compiled);
      const generatedAt = compiled.code.indexOf(expression);
      const sourceAt = source.indexOf(expression);
      expect(
        mapped.some((mapping) => {
          const generatedOffset = mapping.generatedOffsets[0];
          const sourceOffset = mapping.sourceOffsets[0];
          const length = mapping.lengths[0];
          return (
            generatedOffset !== undefined &&
            sourceOffset !== undefined &&
            length !== undefined &&
            generatedOffset <= generatedAt &&
            generatedOffset + length >= generatedAt + expression.length &&
            sourceOffset + generatedAt - generatedOffset === sourceAt
          );
        }),
      ).toBe(true);
      const { service, project } = createMutablePluginService(
        {
          [file]: source,
          "/project/consumer.ts": 'import "./tag-types.mx";',
          "/project/tsconfig.json": "{}",
        },
        ["/project/consumer.ts"],
        { documentRegistry: documents },
      );
      try {
        expect(diagnosticSet(service.getSyntacticDiagnostics(file))).toEqual(
          [],
        );
        const diagnostics = service.getSemanticDiagnostics(file);
        expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
          code,
        ]);
        expect(diagnostics[0]?.start).toBe(source.indexOf(token));
        expect(diagnostics[0]?.length).toBe(token.length);
      } finally {
        project.close();
        service.dispose();
      }
    },
  );
});
