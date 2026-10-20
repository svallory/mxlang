import * as core from "@mxlang/core";
import { builtinLookup } from "@mxlang/targets";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  createMutablePluginService,
  createPluginService,
} from "./fixtures/plugin-service.ts";

/**
 * `x satisfies T` in a template placeholder reaches the type-check module:
 * the authored TypeScript wrapper is kept in the projection the tools
 * type-check (html under `typeCheck`; the JSX hosts already kept it), so tsc
 * reports a failing `satisfies` at the authored position instead of silently
 * passing.
 */

interface Check {
  codes: number[];
  satisfiesDiagnostic?: ts.Diagnostic;
}

/** One `getSemanticDiagnostics` call, read once (the proxy warms per call). */
function check(service: ts.LanguageService, file: string): Check {
  const diagnostics = service.getSemanticDiagnostics(file);
  const codes = diagnostics.map((diagnostic) => diagnostic.code);
  const satisfiesDiagnostic = diagnostics.find((diagnostic) =>
    ts
      .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      .includes("does not satisfy"),
  );
  return { codes, satisfiesDiagnostic };
}

function serviceFor(
  fileName: string,
  source: string,
): { service: ts.LanguageService; file: string } {
  return {
    service: createPluginService(
      {
        [fileName]: source,
        "/project/tsconfig.json": "{}",
        "/project/consumer.ts": `import "./${fileName.split("/").pop()}";\n`,
      },
      ["/project/consumer.ts"],
    ),
    file: fileName,
  };
}

/** The same descriptor compile the plugin requests, before its mapping pass. */
function compileProjection(source: string): string {
  const targets = builtinLookup();
  const load = targets.target("html")?.load;
  if (!load) throw new Error("expected the html compiler");
  return load(core).compileModule(source, "/project/tag-types.mx", {
    typeCheck: true,
    targets,
  }).code;
}

// Each of these parsed before wrapper retention was enabled. Keep the full
// container strip's coverage, including casts below another wrapper.
const ANGLE_PROBES = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["expression/as", "<p>${(<string>input.a) as string}</p>"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["expression/satisfies", "<p>${(<string>input.a) satisfies string}</p>"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["expression/non-null", "<p>${(<string>input.a)!}</p>"],
  ["expression/attribute non-null", "<p title=(<string>input.a)!/>"],
  ["expression/attribute as", "<p title=(<string>input.a) as string/>"],
  ["expression/let satisfies", "<let/y=(<string>input.a) satisfies string/>"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
  ["expression/double cast", "<p>${<string><unknown>input.a}</p>"],
  ["pattern/const object", '<const/{ a = <string>"d" }=input/>'],
  ["pattern/let object", '<let/{ a = <string>"d" }=input/>'],
  ["pattern/const array", '<const/[ b = (<string>"d") ]=input.xs/>'],
  [
    "arguments/define call",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
    '<define/Foo|value = ""|><p>${value}</p></define><Foo(<string>input.a)/>',
  ],
] as const;

describe("satisfies in the type-check module", () => {
  it.each([
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
  ])("accepts a %s tag with type arguments in compile output", (_, probe) => {
    // Known editor mapping gap on main: see bead mx-pj34. This regression
    // pins the descriptor's compile output, not the separate re-lowering.
    const prefix = "export interface Input { a: string; b: boolean }\n";
    const code = compileProjection(prefix + probe);
    expect(code).toContain("function");
    expect(code).toBe(
      compileProjection(
        prefix + probe.replace("<string>", "").replace("<T>", ""),
      ),
    );
  });

  it("keeps a generic custom-tag call unchanged in compile output", () => {
    // Known editor mapping gap on main: see bead mx-pj34.
    const source = 'import Foo from "./foo"\n<Foo<string> v="x"/>';
    const code = compileProjection(source);
    expect(code).toContain("Foo");
    expect(code).toBe(compileProjection(source.replace("<string>", "")));
  });

  it.each(ANGLE_PROBES)(
    "keeps the main-compatible %s container valid TSX",
    (_, probe) => {
      const source = [
        "export interface Input { a: string; xs: string[] }",
        probe,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
        "<span>${input.zz}</span>",
      ].join("\n");
      const file = "/project/container.mx";
      const { service, setFile, project } = createMutablePluginService(
        {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
          [file]: source.replace("<span>${input.zz}</span>", ""),
          "/project/tsconfig.json": "{}",
          "/project/consumer.ts": 'import "./container.mx";\n',
        },
        ["/project/consumer.ts"],
      );
      try {
        // Invariant: these programs were valid before wrapper retention.
        expect(
          service.getSyntacticDiagnostics(file).map((d) => d.code),
        ).toEqual([]);
        expect(service.getSemanticDiagnostics(file).map((d) => d.code)).toEqual(
          [],
        );
        setFile(file, source);
        expect(
          service.getSyntacticDiagnostics(file).map((d) => d.code),
        ).toEqual([]);
        const diagnostics = service.getSemanticDiagnostics(file);
        // A malformed TSX projection used to hide the later real error under
        // spurious JSX/identifier diagnostics. No other errors are permitted.
        expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
          2339,
        ]);
        expect(diagnostics[0]?.start).toBe(source.indexOf("zz"));
        expect(diagnostics[0]?.length).toBe(2);
      } finally {
        project.close();
        service.dispose();
      }
    },
  );
  it("reports a failing `satisfies` in an html placeholder at the authored position", () => {
    const source = [
      "export interface Input { count: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "<span>${input.count satisfies string}</span>",
    ].join("\n");
    const { service, file } = serviceFor("/project/page.mx", source);

    const { codes, satisfiesDiagnostic } = check(service, file);
    expect(codes).toContain(1360);
    // The authored position inside the placeholder: the `satisfies`
    // keyword in the authored source, not an offset in the projection.
    expect(satisfiesDiagnostic?.start).toBe(
      source.indexOf("input.count satisfies") + "input.count ".length,
    );
    expect(satisfiesDiagnostic?.length).toBe("satisfies".length);
  });

  it("stays silent for a satisfying expression", () => {
    const source = [
      "export interface Input { count: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "<span>${input.count satisfies number}</span>",
    ].join("\n");
    const { service, file } = serviceFor("/project/ok.mx", source);

    expect(check(service, file).codes).not.toContain(1360);
  });

  it("checks the object literal through `satisfies` (excess property)", () => {
    const source = [
      "export interface Input { count: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "<span>${({ a: input.count } satisfies { b: number })}</span>",
    ].join("\n");
    const { service, file } = serviceFor("/project/excess.mx", source);

    const diagnostics = service.getSemanticDiagnostics(file);
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    // `{ a: number }` does not satisfy `{ b: number }`: the excess property
    // `a` is reported on the authored object literal.
    expect(codes).toContain(2353);
    const excess = diagnostics.find((diagnostic) => diagnostic.code === 2353);
    expect(excess?.start).toBe(source.indexOf("a: input.count"));
  });

  it("keeps nested satisfies in the projection", () => {
    const source = [
      "export interface Input { count: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "<span>${((input.count satisfies number) satisfies string)}</span>",
      "<if=input.count satisfies null>t</if>",
    ].join("\n");
    const { service, file } = serviceFor("/project/nested.mx", source);

    // Both failing `satisfies` sites report, each at its own authored
    // position: the outer wrapper in the placeholder, and the `<if>`
    // attribute's operand wrapper.
    const failing = service
      .getSemanticDiagnostics(file)
      .filter((diagnostic) => diagnostic.code === 1360);
    const starts = failing.map((diagnostic) => diagnostic.start);
    const placeholderAt = source.indexOf(") satisfies string") + 2;
    const ifAt = source.indexOf("count satisfies null") + "count ".length;
    expect(starts).toEqual(expect.arrayContaining([placeholderAt, ifAt]));
    expect(failing).toHaveLength(2);
  });

  it("checks `satisfies` on a `<const>` value", () => {
    const source = [
      "export interface Input { count: number }",
      "<const/y=input.count satisfies string/>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<span>${y}</span>",
    ].join("\n");
    const { service, file } = serviceFor("/project/const.mx", source);

    const { codes, satisfiesDiagnostic } = check(service, file);
    expect(codes).toContain(1360);
    expect(satisfiesDiagnostic?.start).toBe(
      source.indexOf("input.count satisfies") + "input.count ".length,
    );
  });

  it("reports a failing `as` assertion in an html placeholder", () => {
    const source = [
      "export interface Input { count: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "<span>${(input.count as string)}</span>",
    ].join("\n");
    const { service, file } = serviceFor("/project/as.mx", source);

    // Conversion of type 'number' to type 'string' may be a mistake.
    expect(check(service, file).codes).toContain(2352);
  });

  it("strips an angle-bracket cast so the TSX projection still parses", () => {
    const source = [
      "export interface Input { count: number }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "<p>${(<string>input.count)}</p>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
      "<span>${input.count.missing}</span>",
    ].join("\n");
    const { service, file } = serviceFor("/project/angle.mx", source);

    // The projection is checked as TSX, where a kept `<T>` parses as a JSX
    // tag and used to break the whole file (TS1002/TS1005/TS17002 with no
    // semantic diagnostics at all). The cast is stripped (unchecked) and
    // the rest of the file still reports a real type error placed after it.
    expect(service.getSyntacticDiagnostics(file)).toEqual([]);
    const diagnostics = service.getSemanticDiagnostics(file);
    const missing = diagnostics.find((diagnostic) => diagnostic.code === 2339);
    // TS 2339 lands on the property name, placed after the stripped cast.
    expect(missing?.start).toBe(source.indexOf("missing"));
    expect(missing?.length).toBe("missing".length);
  });
});
