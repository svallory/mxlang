import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, expectTypeOf, it } from "vitest";
import type {
  AttrTag,
  AttrTagAttrs,
  AttrTagConfig,
  AttrTagOf,
  AttrTagParams,
} from "./attr-tag.ts";
import { ATTR_TAG_RUNTIME } from "./attr-tag-runtime.ts";

/**
 * `Marko.AttrTag<T>` exactly as `marko` 6.4.4 declares it (`index.d.ts`, the
 * global `Marko` namespace). Core does not depend on `marko`, so the type is
 * copied here; a Marko bump that changes it must change this copy.
 */
type MarkoAttrTag<T> = T & {
  [Symbol.iterator](): Iterator<T>;
};

type Item = { a: number; content?: () => string };

it("types the record as the first occurrence plus the iteration members", () => {
  expectTypeOf<AttrTag<Item>["a"]>().toEqualTypeOf<number>();
  expectTypeOf<AttrTag<Item>["content"]>().toEqualTypeOf<
    (() => string) | undefined
  >();
  expectTypeOf<AttrTag<Item>["length"]>().toEqualTypeOf<number>();
  expectTypeOf<AttrTag<Item>["at"]>().returns.toEqualTypeOf<Item | undefined>();
  // `map` passes each occurrence and its index, and returns the mapped array.
  expectTypeOf((record: AttrTag<Item>) =>
    record.map((item, index) => {
      expectTypeOf(item).toEqualTypeOf<Item>();
      expectTypeOf(index).toEqualTypeOf<number>();
      return String(item.a);
    }),
  ).returns.toEqualTypeOf<string[]>();
  expectTypeOf<AttrTag<Item>["filter"]>().returns.toEqualTypeOf<Item[]>();
  expectTypeOf<AttrTag<Item>["toArray"]>().returns.toEqualTypeOf<Item[]>();
  expectTypeOf((record: AttrTag<Item>) => [...record]).returns.toEqualTypeOf<
    Item[]
  >();
});

it("is assignable to Marko's AttrTag<T>", () => {
  expectTypeOf<AttrTag<Item>>().toMatchTypeOf<MarkoAttrTag<Item>>();
  // biome-ignore lint/complexity/noBannedTypes: the default, an attribute tag with no attributes
  expectTypeOf<AttrTag>().toMatchTypeOf<MarkoAttrTag<{}>>();
  // Marko's record lacks the prototype members, so it is not an MX record.
  expectTypeOf<MarkoAttrTag<Item>>().not.toMatchTypeOf<AttrTag<Item>>();
});

it("keeps the deprecated config form exported and unchanged", () => {
  expectTypeOf<
    AttrTagOf<{ attrs: { title: string }; params: [count: number] }, string>
  >().toEqualTypeOf<
    { title: string } & { content?: (count: number) => string }
  >();
  expectTypeOf<AttrTagParams<{ params: [id: number] }>>().toEqualTypeOf<
    [id: number]
  >();
  expectTypeOf<AttrTagAttrs<{ attrs: { title: string } }>>().toEqualTypeOf<{
    title: string;
  }>();
  expectTypeOf<{ as: "data" }>().toMatchTypeOf<AttrTagConfig>();
});

// The fold builder takes `T` from where its result goes, so each `add` is
// checked against the declared attributes at the attribute: the directive
// sits on the `id` line, and an error anywhere else (or none) is reported.
it("checks each occurrence of a fold at its attribute", () => {
  const attrTag = fileURLToPath(new URL("./attr-tag.ts", import.meta.url));
  const file = fileURLToPath(new URL("./__fold-probe.ts", import.meta.url));
  const text = `import type { AttrTag } from ${JSON.stringify(attrTag)};
${ATTR_TAG_RUNTIME}
export const rows: AttrTag<{ id: number }> | undefined = __mxAttrTagsOf((add) => {
  add({ id: 1 });
  add({
    // @ts-expect-error
    id: "x",
  });
});
`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    lib: ["lib.es2022.d.ts"],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language) =>
    name === file
      ? ts.createSourceFile(name, text, language)
      : read(name, language);
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program, program.getSourceFile(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(diagnostics).toEqual([]);
});
