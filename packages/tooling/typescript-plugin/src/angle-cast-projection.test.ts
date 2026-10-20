// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template fixtures
// biome-ignore-all lint/style/useTemplate: keep MX placeholder syntax literal
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@mxlang/core";
import { builtinLookup, lookupFor, resolveTargetPolicy } from "@mxlang/targets";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ANGLE_INPUT,
  ATTRIBUTE_CAST_RANGES,
  angleProbesFor,
  checkedLiteralProbesFor,
  HTML_COMMENT_HELPER_ERROR,
  OPERATOR_PROBES,
  VALID_ANGLE_PROBES,
  withMissingType,
} from "./fixtures/angle-cast-probes.ts";
import { createMutablePluginService } from "./fixtures/plugin-service.ts";
import { createHtmlMappings } from "./mx-language.ts";

const targets = builtinLookup();
function projection(source: string, file: string) {
  const descriptor = targets.target("html");
  if (!descriptor?.load) throw new Error("missing html target");
  return descriptor
    .load(core)
    .compileModule(source, file, { typeCheck: true, targets });
}
const message = (d: ts.Diagnostic) =>
  ts.flattenDiagnosticMessageText(d.messageText, "\n");

describe("angle assertions in the real plugin service", () => {
  it.each(["html", "preact", "react", "hono"])(
    "checks every emitted %s container at its authored operand",
    (host) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-angle-editor-")));
      symlinkSync(
        join(import.meta.dirname, "../../../..", "node_modules"),
        join(dir, "node_modules"),
        "dir",
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "angle-test", mx: { host, strict: false } }),
      );
      // One program per host, not one fresh program for every changed buffer.
      const files: Record<string, string> = {};
      const add = (name: string, probe: string) => {
        const file = join(dir, `${name}.mx`);
        files[file] = ANGLE_INPUT + probe;
        return file;
      };
      const probes = angleProbesFor(host).map(([name, probe], i) => ({
        name,
        file: add(`probe-${i}`, probe),
        type: add(`type-${i}`, withMissingType(probe)),
      }));
      const valid = VALID_ANGLE_PROBES.map((probe, i) =>
        add(`valid-${i}`, probe),
      );
      const wrong = [
        "<string>input.num",
        "<string>  input.num",
        "<string /* > */> /* operand */ (input.num)",
      ].map((assertion, i) => ({
        assertion,
        file: add(`wrong-${i}`, "<p>${" + assertion + "}</p>"),
      }));
      const operators = OPERATOR_PROBES.map(([probe, code, cast], i) => ({
        file: add(`operator-${i}`, probe),
        code,
        cast,
      }));
      const dynamic = [false, true].map((cast, i) => ({
        file: add(
          `dynamic-${i}`,
          "static const Cmp = (props: unknown) => null;\n<section><${" +
            (cast ? "<any>input.zz" : "input.zz") +
            "}/><${" +
            (cast ? "<any>input.text" : "input.text") +
            "}/><${Cmp}/></section>",
        ),
        cast,
      }));
      const ranges = [
        "<for|i| from=input.zz to=3 by=String>${i}</for>",
        "<for|i| from=0 to=3 step=input.zz by=String>${i}</for>",
        "<for|i| from=(<number>input.zz) to=3 by=String>${i}</for>",
      ]
        // The html range emitter does not emit step= (also true on main).
        // N1 concerns the JSX emitter's duplicated from/step evaluations.
        .filter((probe) => host !== "html" || !probe.includes(" step="))
        .map((probe, i) => add(`range-${i}`, probe));
      const highlights = add(
        "range-highlights",
        "<for|i| from=input.num to=3 by=String>${i}</for>",
      );
      const literals = checkedLiteralProbesFor(host).map(
        ([probe, printed, cast], i) => ({
          file: add(`literal-${i}`, probe),
          printed,
          cast,
        }),
      );
      const wrappedKeys =
        host === "html"
          ? []
          : [
              '("id" as any)',
              '(<any>"id")',
              '("id" as string)',
              '(<Missing>"id")',
            ].map((key, i) => {
              const file = add(`wrapped-key-${i}`, "");
              files[file] =
                "export interface Input { list: { id: string }[] }\n" +
                `<for|row| of=input.list by=${key}><p/></for>`;
              return { file, key };
            });
      const attributeRange =
        host === "html"
          ? undefined
          : add(
              "attribute-range",
              "<define/L|{item}: {item?: any}|/><L><for|i| from=(<number>input.zz) to=3 step=(<number>input.zz)><@item n=i/></for></L>",
            );
      const attributeCasts = ATTRIBUTE_CAST_RANGES.map((probe, i) =>
        add(`attribute-casts-${i}`, probe),
      );
      const consumer = join(dir, "consumer.ts");
      files[consumer] = Object.keys(files)
        .map((file) => `import ${JSON.stringify(file)};`)
        .join("\n");
      files[join(dir, "tsconfig.json")] = "{}";
      const { service, project } = createMutablePluginService(files, [
        consumer,
      ]);
      try {
        for (const { name, file, type } of probes) {
          const source = files[file] ?? "";
          expect(
            service
              .getSyntacticDiagnostics(file)
              .map((d) => [d.code, message(d)]),
            name,
          ).toEqual([]);
          const diagnostics = service.getSemanticDiagnostics(file);
          expect(
            diagnostics
              .filter((d) => d.code === 2339 && message(d).includes("'zz'"))
              .map((d) => [d.start, d.length]),
            name,
          ).toEqual([[source.indexOf("zz"), 2]]);
          expect(
            diagnostics
              .filter(
                (d) =>
                  !(
                    name === "html-comment" &&
                    d.code === 7006 &&
                    HTML_COMMENT_HELPER_ERROR.test(message(d))
                  ),
              )
              .map(message)
              .join("\n"),
            name,
          ).not.toMatch(/generated|approximate/);
          const missing = service
            .getSemanticDiagnostics(type)
            .filter((d) => d.code === 2304 && message(d).includes("Missing"));
          expect(
            missing.map((d) => [d.start, d.length]),
            `${name}: moved type`,
          ).toEqual([[(files[type] ?? "").indexOf("Missing"), 7]]);
        }
        for (const file of valid) {
          expect(
            service
              .getSyntacticDiagnostics(file)
              .map((d) => [d.code, message(d)]),
            file,
          ).toEqual([]);
          expect(
            service
              .getSemanticDiagnostics(file)
              .map((d) => [d.code, message(d)]),
            file,
          ).toEqual([]);
        }
        for (const { assertion, file } of wrong) {
          const diagnostics = service
            .getSemanticDiagnostics(file)
            .filter((d) => d.code === 2352);
          expect(
            diagnostics.map((d) => [d.start, d.length]),
            assertion,
          ).toEqual([
            [(files[file] ?? "").indexOf(assertion), assertion.length],
          ]);
        }
        for (const { file, code, cast } of operators) {
          const diagnostics = service.getSemanticDiagnostics(file);
          expect(
            diagnostics.map((d) => [d.code, d.start, d.length, message(d)]),
            file,
          ).toEqual([
            [
              code,
              (files[file] ?? "").indexOf(cast),
              cast.length,
              expect.not.stringMatching(/generated|approximate/),
            ],
          ]);
        }
        // Evaluate all literal rows before asserting, so a mutation exposes
        // every affected row rather than stopping at the first lost wrapper.
        expect(
          literals.map(({ file }) => ({
            source: files[file],
            codes: service
              .getSemanticDiagnostics(file)
              .map((d) => d.code)
              .sort(),
          })),
        ).toEqual(
          literals.map(({ file, cast }) => ({
            source: files[file],
            codes: cast ? (host === "html" ? [2352] : [2322, 2352]) : [],
          })),
        );
        for (const { file, printed, cast } of literals) {
          const source = files[file] ?? "";
          expect(service.getSyntacticDiagnostics(file)).toEqual([]);
          const diagnostics = service.getSemanticDiagnostics(file);
          expect(
            diagnostics
              .filter((d) => d.code === 2352)
              .map((d) => [d.code, d.start, d.length, message(d)]),
            source,
          ).toEqual(
            cast
              ? [
                  [
                    2352,
                    source.indexOf(cast),
                    cast.length,
                    expect.not.stringMatching(/generated|approximate/),
                  ],
                ]
              : [],
          );
          // A numeric id is also invalid on JSX hosts, independently of the
          // invalid cast; valid literal probes must introduce no TS2322.
          expect(
            diagnostics.filter((d) => d.code !== 2352).map((d) => d.code),
          ).toEqual(cast && host !== "html" ? [2322] : []);
          const policy = resolveTargetPolicy(file);
          const configured = lookupFor(policy);
          const descriptor = configured.target(policy.target);
          if (!descriptor?.load) throw new Error("missing target");
          const checked = descriptor.load(core).compileModule(source, file, {
            typeCheck: true,
            targets: configured,
          }).code;
          expect(checked, source).toContain(printed);
          // A bare root value uses dynamic-tag dispatch; this direct text
          // guard belongs to interpolation inside an element.
          if (host === "preact" && source.includes("<p>${"))
            expect(checked).toContain(
              source.includes("<unknown>")
                ? "__mxRenderable((`t` as unknown))"
                : "__mxRenderable(`t` as unknown)",
            );
        }
        for (const { file, key } of wrappedKeys) {
          const source = files[file] ?? "";
          expect(service.getSyntacticDiagnostics(file), key).toEqual([]);
          expect(
            service
              .getSemanticDiagnostics(file)
              .map((d) => [d.code, d.start, d.length, message(d)]),
            key,
          ).toEqual(
            key.includes("Missing")
              ? [
                  [
                    2304,
                    source.indexOf("Missing"),
                    7,
                    expect.not.stringMatching(/generated|approximate/),
                  ],
                ]
              : [],
          );
          const policy = resolveTargetPolicy(file);
          const configured = lookupFor(policy);
          const descriptor = configured.target(policy.target);
          if (!descriptor?.load) throw new Error("missing target");
          const compiler = descriptor.load(core);
          const compile = (text: string, typeCheck: boolean) =>
            compiler.compileModule(text, file, {
              typeCheck,
              targets: configured,
            }).code;
          expect(compile(source, false), key).toBe(
            compile(source.replace(key, '"id"'), false),
          );
          const checked = compile(source, true);
          expect(checked, key).toContain("void (");
          expect(checked, key).toContain(", row.id)");
        }
        for (const file of attributeCasts) {
          const source = files[file] ?? "";
          expect(service.getSyntacticDiagnostics(file)).toEqual([]);
          expect(
            service
              .getSemanticDiagnostics(file)
              .map((d) => [d.code, d.start, d.length, message(d)]),
            source,
          ).toEqual(
            [source.indexOf("zz"), source.lastIndexOf("zz")].map((at) => [
              2339,
              at,
              2,
              expect.not.stringMatching(/generated|approximate/),
            ]),
          );
        }
        if (attributeRange) {
          const source = files[attributeRange] ?? "";
          expect(service.getSyntacticDiagnostics(attributeRange)).toEqual([]);
          // Count every diagnostic: repeated generated evaluations must not
          // add a fallback at <L>, nor a duplicate at either authored zz.
          expect(
            service
              .getSemanticDiagnostics(attributeRange)
              .map((d) => [d.code, d.start, d.length, message(d)]),
            host,
          ).toEqual(
            [source.indexOf("zz"), source.lastIndexOf("zz")].map((at) => [
              2339,
              at,
              2,
              expect.not.stringMatching(/generated|approximate/),
            ]),
          );
        }
        for (const file of ranges) {
          const source = files[file] ?? "";
          // Main reports an exact error plus an unmapped whole-tag fallback
          // for a plain repeated range value. Preserve that no-angle identity;
          // only projected values gain the supplemental occurrence mapping.
          const expected = [[source.indexOf("zz"), 2]];
          if (host !== "html" && !source.includes("<number>")) {
            expected.push([
              source.indexOf("<for"),
              source.length - source.indexOf("<for"),
            ]);
          }
          expect(
            service
              .getSemanticDiagnostics(file)
              .filter((d) => d.code === 2339)
              .map((d) => [d.start, d.length]),
            file,
          ).toEqual(expected);
        }
        const highlightSource = files[highlights] ?? "";
        const highlighted = service
          .getDocumentHighlights(
            highlights,
            highlightSource.indexOf("num to"),
            [highlights],
          )
          ?.flatMap((d) => d.highlightSpans.map((s) => s.textSpan));
        expect(
          highlighted?.filter(
            (s) => s.start === highlightSource.indexOf("num to"),
          ),
        ).toHaveLength(1);
        for (const { file } of dynamic) {
          const source = files[file] ?? "";
          expect(
            service
              .getSemanticDiagnostics(file)
              .filter((d) => d.code === 2339)
              .map((d) => [d.start, d.length]),
          ).toEqual([[source.indexOf("zz"), 2]]);
          for (const token of ["input.text", "Cmp}/>"]) {
            const at = source.indexOf(token) + (token === "input.text" ? 7 : 1);
            expect(
              service.getQuickInfoAtPosition(file, at),
              token,
            ).toBeDefined();
            const definitions = service.getDefinitionAtPosition(file, at);
            expect(
              definitions?.some(
                (d) =>
                  d.fileName === file &&
                  d.textSpan.start ===
                    source.indexOf(token === "input.text" ? "text:" : "Cmp ="),
              ),
              token,
            ).toBe(true);
          }
        }
      } finally {
        service.dispose();
        project.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // One program now checks the entire host matrix (rather than rebuilding
    // one per probe). Preact still needs ~6 s cold, so the default 5 s budget
    // cannot cover the complete matrix; the gate runs it beside other
    // typescript-plugin files on a loaded box (25.9 s observed), so keep a wide
    // margin.
    60_000,
  );

  it("preserves the known unchecked inert-id projection", () => {
    const file = "/project/id.mx";
    const source = ANGLE_INPUT + "<id=(<string>input.zz)/>";
    expect(projection(source, file).code).toBe(
      projection(ANGLE_INPUT + "<id/>", file).code,
    );
    const { service, project } = createMutablePluginService(
      { [file]: source, "/project/consumer.ts": 'import "./id.mx";' },
      ["/project/consumer.ts"],
    );
    try {
      expect(service.getSyntacticDiagnostics(file)).toEqual([]);
      expect(service.getSemanticDiagnostics(file)).toEqual([]);
    } finally {
      service.dispose();
      project.close();
    }
  });

  it("uses synthetic whole-cast endpoints only for diagnostics", () => {
    const source = ANGLE_INPUT + "<p>${<string>input.num}</p>";
    const file = "/project/angle-endpoints.mx";
    const compiled = projection(source, file);
    const mappings = createHtmlMappings(
      source,
      file,
      compiled.code,
      false,
      undefined,
      compiled.mappings,
      undefined,
      undefined,
      targets,
    );
    const endpoints = mappings.filter(
      (mapping) =>
        mapping.lengths.length === 2 &&
        mapping.lengths.every((length) => length === 0),
    );
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints)
      expect(endpoint.data).toEqual({ verification: true });
  });

  it("keeps the mapping reparse and compile in agreement", () => {
    for (const [name, probe] of angleProbesFor("html")) {
      const source = ANGLE_INPUT + probe;
      const file = "/project/angle-agreement.mx";
      const compiled = projection(source, file);
      const mappings = createHtmlMappings(
        source,
        file,
        compiled.code,
        false,
        undefined,
        compiled.mappings,
        undefined,
        undefined,
        targets,
      );
      const at = source.indexOf("zz");
      expect(
        mappings.some((mapping) => {
          const sourceStart = mapping.sourceOffsets[0] ?? 0;
          const generatedStart = mapping.generatedOffsets[0] ?? 0;
          const length = mapping.lengths[0] ?? 0;
          return (
            at >= sourceStart &&
            at + 2 <= sourceStart + length &&
            compiled.code.slice(
              generatedStart + at - sourceStart,
              generatedStart + at - sourceStart + 2,
            ) === "zz"
          );
        }),
        name,
      ).toBe(true);
    }
  });
});
