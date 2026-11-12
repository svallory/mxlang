// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Expression values are mapped to their authored source: a component prop
 * value, an attribute expression and a `${}` text expression each carry a
 * mapping whose source slice is the expression and whose generated slice is
 * the text emitted for it. An atom a dialect builds is a different length in
 * the generated text, so it maps per atom: the atom rows run core's atom
 * fixture dialect (sigil `~`), re-exported by a dialect package the temp
 * project depends on, which claims `.atom.mx`. Mapping only: the emitted code
 * is the code it was before.
 */
function pairs(
  source: string,
  file = "/fixtures/values.mx",
): { code: string; pairs: string[][] } {
  const { code, mappings } = compile(source, file);
  return {
    code,
    pairs: mappings.map((m) => [
      source.slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]),
  };
}

const MODULE = join(
  import.meta.dirname,
  "../../../core/src/fixtures/syntax/atom-fixture.ts",
);

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-html-atom-")));
  const dialect = join(dir, "node_modules", "atom-dialect");
  mkdirSync(dialect, { recursive: true });
  writeFileSync(
    join(dialect, "package.json"),
    JSON.stringify({
      name: "atom-dialect",
      mx: {
        dialect: {
          id: "atom",
          name: "Fixture",
          extensions: [".atom.mx"],
          module: "./index.cjs",
        },
      },
    }),
  );
  writeFileSync(
    join(dialect, "index.cjs"),
    `module.exports = require(${JSON.stringify(MODULE)});\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      devDependencies: { "atom-dialect": "0.0.0" },
    }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const atomPairs = (source: string) => pairs(source, join(dir, "page.atom.mx"));

const IMPORT = 'import Field from "./field.mx"\n';

describe("html expression values", () => {
  it.each([
    ["a component prop value", `${IMPORT}<Field count=n + 1/>`, "n + 1"],
    ["a component spread", `${IMPORT}<Field ...rest/>`, "rest"],
    ["an attribute expression", "<input value=missing/>", "missing"],
    ["a class attribute", '<div class=["a", b]/>', '["a", b]'],
    ["a `${}` text expression", "<p>${missing}</p>", "missing"],
    ["a raw `$!{}` text expression", "<p>$!{missing}</p>", "missing"],
    ["an attribute beside a spread", "<div title=t ...rest/>", "t"],
    ["a textarea value", "<textarea value=v/>", "v"],
  ])("maps %s", (_name, source, expression) => {
    expect(pairs(source).pairs).toContainEqual([expression, expression]);
  });

  it.each([
    [
      "a nested atom in a component prop",
      `${IMPORT}<Field modes=[~strict, ~lose]/>`,
      ["~strict", "~lose"],
    ],
    ["an atom in an attribute", "<input value=f(~a, b)/>", ["~a"]],
    ["an atom in a `${}` expression", "<p>${f(~t, u)}</p>", ["~t"]],
    ["an atom beside a spread", "<div title=f(~a, b) ...rest/>", ["~a"]],
  ])("maps %s per atom", (_name, source, atoms) => {
    const result = atomPairs(source);
    for (const atom of atoms) {
      expect(result.pairs).toContainEqual([
        atom,
        JSON.stringify(atom.slice(1)),
      ]);
    }
  });

  it("maps the text after an atom to its own offset, not drifted", () => {
    const source = "<p>${f(~t, afterAtom)}</p>";
    expect(atomPairs(source).pairs).toContainEqual([
      ", afterAtom)",
      ", afterAtom)",
    ]);
  });
});

/**
 * The type-check projection (`typeCheck: true`, compiled for tooling and
 * never run) puts every authored expression in the module and maps it to the
 * text the author wrote, so an error in it is reported there and not at
 * "MX-generated code". An angle assertion (`<T>x`) is printed `(x as T)`: a
 * tool checking the module as TSX would read `<T>` as a JSX tag.
 */
function checked(source: string): { code: string; pairs: string[][] } {
  const { code, mappings } = compile(source, "/fixtures/checked.mx", {
    typeCheck: true,
  });
  return {
    code,
    pairs: mappings.map((m) => [
      source.slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]),
  };
}

/** Semantic diagnostics (codes) of `code` as one in-memory module. */
function diagnosticCodes(code: string): number[] {
  const name = "/virtual/check.ts";
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...rest) =>
    file === name
      ? ts.createSourceFile(file, code, languageVersion)
      : getSourceFile(file, languageVersion, ...rest);
  const program = ts.createProgram([name], options, host);
  return program.getSemanticDiagnostics().map((d) => d.code);
}

describe("html type-check projection", () => {
  it.each([
    ["an inert tag's default value", "<id=x/>", "x"],
    [
      "an inert tag's default value with an angle assertion",
      "<id=(<string>x)/>",
      "x",
    ],
    ["a `<log>` expression", "<log=missing/>", "missing"],
    [
      "a `<let valueChange>` expression",
      "<let/v=1 valueChange=missing/>",
      "missing",
    ],
    ["a `<let>` initial value", "<let/v=initial/>", "initial"],
    ["a `<const>` initial value", "<const/y=input.zzg/>${y}", "input.zzg"],
    [
      "a `<const>` initial value under an angle assertion",
      "<const/y=(<string>input.zzg)/>${y}",
      "input.zzg",
    ],
  ])("maps %s to its authored text", (_name, source, expression) => {
    expect(checked(source).pairs).toContainEqual([expression, expression]);
  });

  it("prints an inert tag's default value once, without changing the build", () => {
    const source = "<id=x/>";
    expect(checked(source).code).toContain("void (x);");
    expect(compile(source, "/fixtures/checked.mx").code).not.toContain(
      "void (x)",
    );
  });

  it.each([
    ["f(<string>x)", "f((x as string))"],
    ["(<string>x).length", "((x as string)).length"],
    [
      "(<number>(<unknown>x)).toFixed()",
      "(((x as unknown) as number)).toFixed()",
    ],
  ])("prints the angle assertion in `%s` as `as`", (expression, printed) => {
    const result = checked(`<const/y=${expression}/>\${y}`);
    expect(result.code).toContain(`const y = ${printed};`);
    expect(result.pairs).toContainEqual([expression, printed]);
  });

  it.each([
    ["a `<const>`", "<const/c: string = n/>${c}", "const c: string = n;"],
    ["a `<let>`", "<let/c: string = n/>${c}", "const c: string = n;"],
  ])(
    "keeps the annotation of %s, mapped to the type",
    (_name, source, line) => {
      const result = checked(source);
      expect(result.code).toContain(line);
      expect(result.pairs).toContainEqual(["string", "string"]);
      expect(compile(source, "/fixtures/checked.mx").code).toContain(
        "const c = n;",
      );
    },
  );

  it("does not report TS2367 on the lone-spread guard when the values are not booleans", () => {
    const source = "<div ...rest/>";
    const result = checked(source);
    expect(result.pairs).toContainEqual(["rest", "rest"]);
    // The projection's `=== false` guard over a `Record<string, string>`'s
    // values is a TS2367 unless the entries are read as `any`.
    const codes = diagnosticCodes(
      `declare const rest: Record<string, string>;\n${result.code.replace(/^export default[^\n]*\n?/, "")}`,
    );
    expect(codes).not.toContain(2367);
    expect(compile(source, "/fixtures/checked.mx").code).toContain(
      "Object.entries(rest ?? {})",
    );
  });
});
