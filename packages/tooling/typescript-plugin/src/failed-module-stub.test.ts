import ts from "typescript";
import { describe, expect, it } from "vitest";
import { failedModuleStub } from "./failed-module-stub.ts";

/** Type-check `consumer` against `stub` in memory; returns consumer error codes. */
function consumerCodes(stub: string, consumer: string): number[] {
  const files: Record<string, string> = {
    "/project/stub.ts": stub,
    "/project/other.ts":
      "export const fromStar = 1;\nexport type StarT<A> = A;\n",
    "/project/index.ts": consumer,
  };
  const host = ts.createCompilerHost({});
  const read = host.readFile.bind(host);
  host.readFile = (f) => files[f] ?? read(f);
  host.directoryExists = () => true;
  host.fileExists = (f) => f in files;
  host.getSourceFile = (f, lang) =>
    files[f] === undefined ? undefined : ts.createSourceFile(f, files[f], lang);
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
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === "/project/index.ts")
    .map((d) => d.code);
}

function parseErrors(text: string): number {
  const file = ts.createSourceFile("/stub.ts", text, ts.ScriptTarget.ESNext);
  return (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics
    .length;
}

const EVERY_FORM = [
  'import S, { Box, make, Color, Input, helper } from "./stub.ts";',
  'import type { Box as BoxT, Input as InputT } from "./stub.ts";',
  'import * as NS from "./stub.ts";',
  "const b: Box<string> = new Box<string>('x');",
  "const m = make<number>(1);",
  "const i: Input<number> = null as never;",
  "const t: BoxT<string, number> = null as never; const u: InputT = null as never;",
  "const n: NS.Box<number, 2> = new NS.Box(1);",
  "const c = Color.Red; const d = S(); const h = [helper, NS.helper];",
  "type Mod = typeof import('./stub.ts'); const dyn = null as unknown as Mod; dyn.make<string>('z');",
  "export { b, m, i, t, u, n, c, d, h, dyn };",
].join("\n");

describe("failedModuleStub", () => {
  it("absorbs generic types, generic new and generic calls through every import form", () => {
    const stub = failedModuleStub(
      [
        "export class Box<T> { v!: T }",
        "export function make<T>(x: T): T { return x }",
        "export enum Color { Red }",
        "export interface Input<T> { v: T }",
        "export const helper = 1;",
      ].join("\n"),
    );
    expect(consumerCodes(stub, EVERY_FORM)).toEqual([]);
  });

  it("does not miscount type parameters containing =>", () => {
    const stub = failedModuleStub(
      "export interface Box<A extends () => void, B> { a: A; b: B }",
    );
    expect(
      consumerCodes(
        stub,
        'import type { Box } from "./stub.ts";\nexport const x: Box<() => void, 1> = null as never;',
      ),
    ).toEqual([]);
  });

  it("keeps later exports when a mid-edit export has no name yet", () => {
    const stub = failedModuleStub("export type\nexport const helper = 1;\n");
    expect(parseErrors(stub)).toBe(0);
    expect(stub).not.toMatch(/\bexport (declare )?const export\b/);
    expect(
      consumerCodes(
        stub,
        'import { helper } from "./stub.ts";\nexport const x = helper;',
      ),
    ).toEqual([]);
  });

  it("always emits a stub that parses, whatever the source", () => {
    const garbage = [
      "",
      "export",
      "export type",
      "export class extends",
      "export { f as if }",
      "export { default as x, type }",
      "export const {",
      "export const [a, , b",
      "export function* ",
      "export default",
      "export * from",
      'export * as from "x"',
      "export enum\nexport interface\n",
      "export const { a: { b }, ...rest } = x",
      "\u0000export const  x",
      "export async function while() {}",
    ];
    for (const source of garbage) {
      expect(
        parseErrors(failedModuleStub(source)),
        JSON.stringify(source),
      ).toBe(0);
    }
  });

  it("copies export-star re-exports verbatim", () => {
    const stub = failedModuleStub(
      'export * from "./other.ts";\nexport * as ns from "./other.ts";\n',
    );
    expect(
      consumerCodes(
        stub,
        'import { fromStar, ns, type StarT } from "./stub.ts";\nexport const x: StarT<number> = fromStar + ns.fromStar;',
      ),
    ).toEqual([]);
  });

  it("stubs destructured exports", () => {
    const stub = failedModuleStub(
      "export const { alpha, b: beta, c = 1, ...rest } = obj;\nexport const [first, , third] = arr;",
    );
    expect(
      consumerCodes(
        stub,
        'import { alpha, beta, c, rest, first, third } from "./stub.ts";\nexport const x = [alpha, beta, c, rest, first, third];',
      ),
    ).toEqual([]);
  });

  it("does not leak the name of `export default function Named`", () => {
    const stub = failedModuleStub("export default function Named() {}");
    expect(stub).not.toContain("Named");
    expect(
      consumerCodes(stub, 'import { Named } from "./stub.ts";\nvoid Named;'),
    ).not.toEqual([]);
  });
});
