import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type MxWarning, TranslateError } from "@mxlang/core";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";
import { compileModule, serializeDataDocument } from "./compile.ts";
import { parseData } from "./parse.ts";
import type { DataDocument, SerializedDataDocument } from "./tree.ts";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mx-data-compile-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const fixturePath = join(here, "../fixtures/ash-resource/post.mx");
const mash = readFileSync(fixturePath, "utf8");

/** Every expression site: tag and attr-tag attrs and args, spread, `${}`, `<if>`/`<for>`/`<const>`. */
const RICH = `import { x } from "./x.ts"
export interface Input { n: number }
static const k = 1

// a line comment
<!-- an html comment -->
<card.big.wide#main title="t" count=n+1 flag v:=bound ...rest>
  <fn(a, b)|p, q|>x</fn>
  <@header level=1 title=\`h\${n}\`>
    heading \${n} and $!{raw}
  </@header>
  <if=(n > 1)>
    <small>many</small>
  </if>
  <else-if=n === 1>
    <small>one</small>
  </else-if>
  <else>
    <small>none</small>
  </else>
  <for|item, i| of=items by="id">\${item}</for>
  <for|k, v| in=obj><li>\${k}\${v}</li></for>
  <for|i| from=0 to=10 step=2><span>\${i}</span></for>
  <const/total=items.length * 2/>
  <ünï-tag a="é😀"/>
  <ünï:tag b="1"/>
</card>
`;

/** Every `DataExpr`-shaped object in `value`, with the path it was found at. */
function exprsIn(
  value: unknown,
  path = "$",
): { path: string; expr: Record<string, unknown> }[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, i) => exprsIn(child, `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own =
    "code" in record && "shape" in record && "span" in record
      ? [{ path, expr: record }]
      : [];
  return [
    ...own,
    ...Object.entries(record).flatMap(([key, child]) =>
      exprsIn(child, `${path}.${key}`),
    ),
  ];
}

/** Every key at every depth. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysIn(child),
  ]);
}

function parsed(source: string, filename: string): DataDocument {
  const { tree, diagnostics } = parseData(source, filename);
  if (!tree) throw new Error(JSON.stringify(diagnostics));
  return tree;
}

/** Writes the emitted module to a temp dir and imports it. */
let counter = 0;
async function importEmitted(code: string): Promise<SerializedDataDocument> {
  const file = join(work, `emitted-${counter++}.ts`);
  writeFileSync(file, code);
  return (await import(pathToFileURL(file).href)).default;
}

/**
 * TypeScript's diagnostics for `files` written side by side in a fresh temp
 * dir, with no path mapping and no repo package resolvable: only what the
 * files themselves import.
 */
function typeErrors(name: string, files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(work, `typecheck-${name}-`));
  const names = Object.keys(files).map((file) => join(dir, file));
  for (const [file, code] of Object.entries(files))
    writeFileSync(join(dir, file), code);
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    types: [],
  };
  const program = ts.createProgram(names, options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("compileModule on the mash fixture", () => {
  const filename = fixturePath;
  const result = compileModule(mash, filename, {});

  it("returns a module, no dependencies and no map", () => {
    expect(typeof result.code).toBe("string");
    expect(result.dependencies).toEqual([]);
    expect(result.map).toBeUndefined();
    expect(result.mappings).toBeUndefined();
  });

  it("emits a module whose default export deep-equals the serialized tree", async () => {
    const emitted = await importEmitted(result.code);
    const tree = parsed(mash, filename);
    expect(emitted).toEqual(serializeDataDocument(tree));
    expect(emitted.kind).toBe("document");
    expect(emitted.filename).toBe(filename);
  });

  it("keeps code, shape and span on every expression (the fixture has many)", async () => {
    const emitted = await importEmitted(result.code);
    const tree = parsed(mash, filename);
    const before = exprsIn(tree);
    const after = exprsIn(emitted);
    expect(after.length).toBe(before.length);
    expect(after.length).toBeGreaterThan(10);
    for (const [i, { path, expr }] of after.entries()) {
      const original = before[i]?.expr as Record<string, unknown>;
      expect(before[i]?.path).toBe(path);
      expect(expr.code, path).toBe(original.code);
      expect(expr.shape, path).toBe(original.shape);
      expect(expr.span, path).toEqual(original.span);
      expect(Object.keys(expr).sort(), path).toEqual(["code", "shape", "span"]);
    }
  });

  it("has no `node` key anywhere in the emitted value", async () => {
    const emitted = await importEmitted(result.code);
    expect(keysIn(emitted)).not.toContain("node");
    // The source tree does have them: the strip is what removed them.
    expect(keysIn(parsed(mash, filename))).toContain("node");
  });

  it("is JSON-compatible: nothing is lost through a JSON round trip", async () => {
    const emitted = await importEmitted(result.code);
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(emitted);
  });

  it("slicing the authored source by an emitted span still works", async () => {
    const emitted = await importEmitted(result.code);
    const [first] = emitted.children;
    expect(first?.kind).toBe("tag");
    if (first?.kind !== "tag") return;
    const text = mash.slice(first.span.sourceStart, first.span.sourceEnd);
    expect(text.startsWith('resource="post"')).toBe(true);
  });

  it("imports nothing: the module is self-contained", () => {
    expect(result.code).not.toMatch(/^\s*import\b/m);
    expect(result.code).not.toContain("@mxlang");
  });

  it("type-checks alone, with no repo package resolvable, and keeps literal types", () => {
    expect(
      typeErrors("mash", {
        "post.mx.ts": result.code,
        "use.ts": `import tree from "./post.mx.ts";
export const kind: "document" = tree.kind;
export const first: "tag" = tree.children[0].kind;
`,
      }),
    ).toEqual([]);
  });

  it("the isolated check is live: a wrong use of the literal type fails", () => {
    const errors = typeErrors("mash-bad", {
      "post.mx.ts": result.code,
      "use.ts": `import tree from "./post.mx.ts";
export const kind: "tag" = tree.kind;
`,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("is assignable to SerializedDataDocument (checked inside the repo)", () => {
    const dir = mkdtempSync(join(work, "assignable-"));
    writeFileSync(join(dir, "post.mx.ts"), result.code);
    const use = join(dir, "use.ts");
    writeFileSync(
      use,
      `import type { SerializedDataDocument } from ${JSON.stringify(join(here, "tree.ts"))};
import tree from "./post.mx.ts";
export const doc: SerializedDataDocument = tree;
`,
    );
    const program = ts.createProgram([use], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      types: [],
    });
    expect(
      ts
        .getPreEmitDiagnostics(program, program.getSourceFile(use))
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
  });
});

describe("compileModule on every kind of node", () => {
  const filename = join(work, "rich.mx");
  const result = compileModule(RICH, filename, {});

  it("round-trips the whole tree", async () => {
    const emitted = await importEmitted(result.code);
    const tree = parsed(RICH, filename);
    expect(emitted).toEqual(serializeDataDocument(tree));
    expect(keysIn(emitted)).not.toContain("node");
  });

  it("strips the node from expressions in every position", async () => {
    const emitted = await importEmitted(result.code);
    const tree = parsed(RICH, filename);
    const sites = exprsIn(emitted).map((e) => e.path);
    const original = exprsIn(tree).map((e) => e.path);
    expect(sites).toEqual(original);
    // attrs, args, spread, ${}, if tests, for heads, key, const init.
    for (const wanted of [".attrs[", ".args[", ".test", ".head.", ".init"]) {
      expect(
        sites.some((p) => p.includes(wanted)),
        wanted,
      ).toBe(true);
    }
    expect(sites.length).toBeGreaterThan(15);
  });

  it("keeps non-expression data: statements, comments, text, unicode, shorthand", async () => {
    const emitted = await importEmitted(result.code);
    expect(emitted.statements.map((s) => s.kind)).toEqual([
      "import",
      "export",
      "static",
    ]);
    expect(JSON.stringify(emitted)).toContain("ünï-tag");
    // Decision 146: a non-ASCII `tag:name` splits into the tag `ünï` and
    // `name="tag"`.
    expect(JSON.stringify(emitted)).toContain('"name":"ünï"');
    expect(JSON.stringify(emitted)).toContain('"value":"tag"');
    expect(JSON.stringify(emitted)).toContain("é😀");
  });

  it("is deterministic: the same source gives the same module", () => {
    expect(compileModule(RICH, filename, {}).code).toBe(result.code);
  });

  it("type-checks too", () => {
    expect(typeErrors("rich", { "rich.mx.ts": result.code })).toEqual([]);
  });
});

describe("serializeDataDocument", () => {
  it("does not mutate the tree it is given", () => {
    const tree = parsed(mash, fixturePath);
    const before = keysIn(tree).filter((k) => k === "node").length;
    serializeDataDocument(tree);
    expect(keysIn(tree).filter((k) => k === "node").length).toBe(before);
    expect(before).toBeGreaterThan(0);
  });

  it("an empty document serializes to an empty document", () => {
    expect(serializeDataDocument(parsed("", "e.mx"))).toEqual({
      kind: "document",
      filename: "e.mx",
      statements: [],
      children: [],
    });
  });
});

describe("compileModule diagnostics", () => {
  it("a parse error is one positioned TranslateError, never a module", () => {
    let thrown: unknown;
    try {
      compileModule("<a b=\n", "bad.mx", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TranslateError);
    const error = thrown as TranslateError;
    expect(error.line).toBeGreaterThanOrEqual(1);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).not.toContain("bad.mx:");
  });

  it("a rejected construct reports its own position", () => {
    expect(() =>
      compileModule("<x>\n  <define/y/>\n</x>\n", "d.mx", {}),
    ).toThrow(TranslateError);
    try {
      compileModule("<a/>\n<b>\n  <return=1/>\n</b>\n", "r.mx", {});
      throw new Error("compiled");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslateError);
      expect((error as TranslateError).line).toBe(3);
      expect((error as TranslateError).message).toContain("return");
    }
  });

  it("matches the diagnostic parseData reports for the same source", () => {
    const source = "<a>\n  <try/>\n</a>\n";
    const { diagnostics } = parseData(source, "t.mx");
    const [expected] = diagnostics;
    try {
      compileModule(source, "t.mx", {});
      throw new Error("compiled");
    } catch (error) {
      const e = error as TranslateError;
      expect(e).toBeInstanceOf(TranslateError);
      expect(e.message).toBe(expected?.message);
      expect(e.line).toBe(expected?.line);
      expect(e.column).toBe(expected?.column);
    }
  });

  const DUPLICATE = '<x a="1" a="2"/>\n';

  it("warnings go to options.warnings and the module is still emitted", async () => {
    const warnings: MxWarning[] = [];
    const out = compileModule(DUPLICATE, "w.mx", { warnings });
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.line).toBe(1);
    expect(warnings[0]?.message.length).toBeGreaterThan(0);
    const emitted = await importEmitted(out.code);
    expect(emitted.children.length).toBe(1);
  });

  it("with no sink, warnings print to console.warn in core's format", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      compileModule(DUPLICATE, "w.mx", {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^w\.mx:1:\d+: /);
    } finally {
      warn.mockRestore();
    }
  });

  // The sibling form: core lowers a tag's children before its attributes, so
  // the duplicate warning of `<x a a><define/></x>` is never reached.
  it("warnings collected before an error stay in the caller's sink", () => {
    const warnings: MxWarning[] = [];
    expect(() =>
      compileModule('<x a="1" a="2"/>\n<define/y/>\n', "w.mx", { warnings }),
    ).toThrow(TranslateError);
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.message).toContain("duplicate attribute");
  });

  it("with no sink, warnings collected before an error still print", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        compileModule('<x a="1" a="2"/>\n<define/y/>\n', "w.mx", {}),
      ).toThrow(TranslateError);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("no warning means no sink write and no console output", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const warnings: MxWarning[] = [];
      compileModule("<x a=1/>\n", "ok.mx", { warnings });
      compileModule("<x a=1/>\n", "ok.mx", {});
      expect(warnings).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("customTags reach the data parse (a contract failure is a positioned error)", () => {
    expect(() =>
      compileModule('<attribute="title"/>\n', "c.mx", {
        customTags: {
          attribute: {
            attributes: { value: { type: "string", required: true } },
          } as never,
        },
      }),
    ).not.toThrow();
    expect(() =>
      compileModule('<attribute="title"/>\n', "c.mx", {
        customTags: {
          attribute: {
            attributes: {
              value: { type: "string", required: true },
              type: { type: "string", required: true },
            },
          } as never,
        },
      }),
    ).toThrow(/missing required attribute/);
  });

  it("strict and resolveImport do not change the output", () => {
    const base = compileModule(RICH, "s.mx", {});
    const resolveImport = vi.fn(() => "/nowhere.ts");
    expect(
      compileModule(RICH, "s.mx", { strict: true, resolveImport }).code,
    ).toBe(base.code);
    expect(resolveImport).not.toHaveBeenCalled();
  });
});
