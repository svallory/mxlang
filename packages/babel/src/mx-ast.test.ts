import { readFileSync } from "node:fs";
import type {
  Expression,
  FunctionParameter,
  LVal,
  SpreadElement,
  Statement,
  TSTypeParameterDeclaration,
  TSTypeParameterInstantiation,
} from "@babel/types";
import { expect, expectTypeOf, it } from "vitest";
import type {
  MxArguments,
  MxAtom,
  MxAttribute,
  MxAttributeTag,
  MxBodyMode,
  MxCDATA,
  MxChild,
  MxCloseTag,
  MxComment,
  MxDeclaration,
  MxDoctype,
  MxDocument,
  MxErrorCode,
  MxExpression,
  MxExpressionContainer,
  MxFragmentBase,
  MxFrontEndOptions,
  MxMethod,
  MxModuleStatement,
  MxNode,
  MxParameterList,
  MxParseError,
  MxPattern,
  MxPlaceholder,
  MxReturn,
  MxScriptlet,
  MxShorthand,
  MxShorthandValue,
  MxSpreadAttribute,
  MxStatementKeyword,
  MxStatements,
  MxTag,
  MxTagName,
  MxTagShape,
  MxText,
  MxTypeArguments,
  MxTypeParameters,
  Span,
} from "./mx-ast.ts";

const AST_MD = new URL(
  "../../../apps/docs/docs/architecture/ast.md",
  import.meta.url,
);
const SOURCE = new URL("./mx-ast.ts", import.meta.url);

function appendixRows(): { names: string[]; kind: string }[] {
  const md = readFileSync(AST_MD, "utf-8");
  const appendix = md.slice(md.indexOf("## Appendix A."));
  const rows: { names: string[]; kind: string }[] = [];
  for (const line of appendix.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").map((c) => c.trim());
    rows.push({
      names: [...(cells[1] ?? "").matchAll(/`(\w+)`/g)].map((m) => m[1] ?? ""),
      kind: cells[2] ?? "",
    });
  }
  return rows;
}

// `MxNodeHandle` is opaque and belongs to core's hook API (ast §6.4): the
// appendix lists it, this module does not define it.
const NOT_IN_THIS_MODULE = new Set(["MxNodeHandle"]);

// Every line that starts an export must declare a type or an interface: a
// value export, `export { … }`, `export * from` and `export default` all fail.
function exportLines(): string[] {
  return readFileSync(SOURCE, "utf-8")
    .split("\n")
    .filter((l) => /^export\b/.test(l));
}

function exportedNames(): string[] {
  return exportLines().map((l) => {
    const m = /^export (?:type|interface) (\w+)/.exec(l);
    if (!m) throw new Error(`not a type or interface export: ${l}`);
    return m[1] ?? "";
  });
}

const NODE_TYPES = [
  "MxDocument",
  "MxTag",
  "MxAttributeTag",
  "MxReturn",
  "MxText",
  "MxPlaceholder",
  "MxScriptlet",
  "MxComment",
  "MxCDATA",
  "MxDoctype",
  "MxDeclaration",
  "MxModuleStatement",
  "MxAttribute",
  "MxShorthand",
  "MxSpreadAttribute",
  "MxMethod",
  "MxParseError",
  "MxAtom",
  "MxExpression",
  "MxStatements",
  "MxPattern",
  "MxArguments",
  "MxParameterList",
  "MxTypeArguments",
  "MxTypeParameters",
] as const;

it("exports only types and interfaces, no value and no re-export", () => {
  expect(exportLines().length).toBeGreaterThan(30);
  for (const line of exportLines()) {
    expect(line).toMatch(/^export (?:type|interface) \w+/);
  }
});

it("exports every type Appendix A names, and nothing it does not", () => {
  const appendix = new Set(appendixRows().flatMap((r) => r.names));
  const exported = new Set(exportedNames());
  for (const name of appendix) {
    if (NOT_IN_THIS_MODULE.has(name)) continue;
    expect(exported, `${name} is in Appendix A but not exported`).toContain(
      name,
    );
  }
  for (const name of exported) {
    expect(appendix, `${name} is exported but not in Appendix A`).toContain(
      name,
    );
  }
});

it("MxNode['type'] is the set of node names marked 'node' in Appendix A", () => {
  expectTypeOf<MxNode["type"]>().toEqualTypeOf<(typeof NODE_TYPES)[number]>();
  const fromAppendix = appendixRows()
    // "generic base" (MxExpressionContainer) is not a node: no `type`.
    .filter((r) => r.kind.startsWith("node"))
    .flatMap((r) => r.names);
  expect(new Set(fromAppendix)).toEqual(new Set(NODE_TYPES));
  expect(fromAppendix).toHaveLength(NODE_TYPES.length);
});

it("MxErrorCode's MX_* members are the front-end rows of ast §3.13", () => {
  const md = readFileSync(AST_MD, "utf-8");
  const table = [...md.matchAll(/^ {3}\| `(MX_[A-Z_]+)` \|/gm)].map(
    (m) => m[1] ?? "",
  );
  const source = readFileSync(SOURCE, "utf-8");
  const declared = [...source.matchAll(/^ {2}\| "(MX_[A-Z_]+)"/gm)].map(
    (m) => m[1] ?? "",
  );
  expect(table).toHaveLength(14);
  expect(new Set(declared)).toEqual(new Set(table));
  expect(table).toContain("MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE");
});

it("MxErrorCode accepts template, Babel and MX codes and nothing else", () => {
  const codes: MxErrorCode[] = [
    "MISMATCHED_CLOSING_TAG",
    "BABEL_UnexpectedToken",
    "MX_SECOND_NAME",
    "MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE",
  ];
  expect(codes).toHaveLength(4);
  // @ts-expect-error lowering's codes are not MxParseError codes
  const lowering: MxErrorCode = "MX_DUPLICATE_DEFAULT";
  // @ts-expect-error not a code
  const unknown: MxErrorCode = "SOMETHING";
  expect([lowering, unknown]).toHaveLength(2);
});

// ---- fixtures --------------------------------------------------------------

const sp = (start: number, end: number): Span => ({ start, end });

function expr(start: number, end: number, source = ""): MxExpression {
  return {
    type: "MxExpression",
    start,
    end,
    source,
    outer: sp(start, end),
    node: null,
    error: null,
    atoms: [],
  };
}

const params = (start: number, end: number): MxParameterList => ({
  type: "MxParameterList",
  start,
  end,
  source: "",
  outer: sp(start - 1, end + 1),
  node: null,
  error: null,
  atoms: [],
});

const statements = (start: number, end: number): MxStatements => ({
  type: "MxStatements",
  start,
  end,
  source: "",
  outer: sp(start, end),
  node: null,
  error: null,
  atoms: [],
});

const tagFields: Omit<MxTag, "type" | "name" | "start" | "end"> = {
  typeArgs: null,
  var: null,
  args: null,
  typeParams: null,
  params: null,
  shorthands: [],
  attributes: [],
  body: null,
  bodyMode: "html",
  selfClosed: true,
  concise: false,
  openTag: sp(0, 11),
  closeTag: null,
  incomplete: false,
};

// ---- one satisfying literal per node, and the two ways to break it ---------

it("MxDocument (ast §3.1: `<p>x</p>`)", () => {
  const doc = {
    type: "MxDocument",
    start: 0,
    end: 8,
    body: [],
    errors: [],
    complete: true,
    source: "<p>x</p>",
    base: { offset: 0, line: 0, column: 0 },
  } satisfies MxDocument;
  expectTypeOf(doc).toMatchTypeOf<MxNode>();
  // @ts-expect-error missing `complete`
  const missing: MxDocument = { ...doc, complete: undefined };
  // @ts-expect-error wrong discriminator
  const wrong: MxDocument = { ...doc, type: "MxTag" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxTag (ast §3.2)", () => {
  const tag = {
    ...tagFields,
    type: "MxTag",
    start: 0,
    end: 11,
    name: { kind: "static", value: "br", span: sp(1, 3) },
  } satisfies MxTag;
  const { selfClosed: _s, ...rest } = tag;
  // @ts-expect-error missing `selfClosed`
  const missing: MxTag = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxTag = { ...tag, type: "MxReturn" };
  // @ts-expect-error `void` is the only body mode spelled this way
  const badMode: MxTag = { ...tag, bodyMode: "VOID" };
  expect([missing, wrong, badMode]).toHaveLength(3);
});

it("MxAttributeTag (ast §3.7: `<@head x=1>H</@head>`)", () => {
  const tag = {
    ...tagFields,
    type: "MxAttributeTag",
    start: 6,
    end: 26,
    name: { value: "head", span: sp(7, 12) },
  } satisfies MxAttributeTag;
  const { name: _n, ...rest } = tag;
  // @ts-expect-error missing `name`
  const missing: MxAttributeTag = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxAttributeTag = { ...tag, type: "MxTag" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxReturn (ast §3.14: `<return=x/>`)", () => {
  const ret = {
    ...tagFields,
    type: "MxReturn",
    start: 0,
    end: 11,
    name: { kind: "static", value: "return", span: sp(1, 7) },
  } satisfies MxReturn;
  const { name: _n, ...rest } = ret;
  // @ts-expect-error missing `name`
  const missing: MxReturn = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxReturn = { ...ret, type: "MxTag" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxText (ast §3.8: `<p>\\n  a</p>`)", () => {
  const text = {
    type: "MxText",
    start: 3,
    end: 7,
    value: "a",
    raw: "\n  a",
    valueSpan: sp(6, 7),
  } satisfies MxText;
  const { raw: _r, ...rest } = text;
  // @ts-expect-error missing `raw`
  const missing: MxText = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxText = { ...text, type: "MxComment" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxPlaceholder (ast §3.9: `<p>$!{html}</p>`)", () => {
  const ph = {
    type: "MxPlaceholder",
    start: 3,
    end: 11,
    escape: false,
    expression: expr(6, 10, "html"),
  } satisfies MxPlaceholder;
  const { expression: _e, ...rest } = ph;
  // @ts-expect-error missing `expression`
  const missing: MxPlaceholder = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxPlaceholder = { ...ph, type: "MxText" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxScriptlet (ast §3.10: `$ const z = 1;`)", () => {
  const s = {
    type: "MxScriptlet",
    start: 0,
    end: 14,
    block: false,
    code: statements(2, 14),
  } satisfies MxScriptlet;
  const { code: _c, ...rest } = s;
  // @ts-expect-error missing `code`
  const missing: MxScriptlet = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxScriptlet = { ...s, type: "MxModuleStatement" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxComment (ast §3.11: `<!-- a -->`)", () => {
  const c = {
    type: "MxComment",
    start: 0,
    end: 10,
    kind: "html",
    value: " a ",
    valueSpan: sp(4, 7),
  } satisfies MxComment;
  const { kind: _k, ...rest } = c;
  // @ts-expect-error missing `kind`
  const missing: MxComment = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxComment = { ...c, type: "MxCDATA" };
  // @ts-expect-error not a comment kind
  const badKind: MxComment = { ...c, kind: "hash" };
  expect([missing, wrong, badKind]).toHaveLength(3);
});

it("MxCDATA (ast §3.11: `<![CDATA[ d ]]>`)", () => {
  const c = {
    type: "MxCDATA",
    start: 0,
    end: 15,
    value: " d ",
    valueSpan: sp(9, 12),
  } satisfies MxCDATA;
  const { valueSpan: _v, ...rest } = c;
  // @ts-expect-error missing `valueSpan`
  const missing: MxCDATA = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxCDATA = { ...c, type: "MxComment" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxDoctype (ast §3.11: `<!doctype html>`)", () => {
  const d = {
    type: "MxDoctype",
    start: 0,
    end: 15,
    value: "doctype html",
    valueSpan: sp(2, 14),
  } satisfies MxDoctype;
  const { value: _v, ...rest } = d;
  // @ts-expect-error missing `value`
  const missing: MxDoctype = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxDoctype = { ...d, type: "MxDeclaration" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxDeclaration (ast §3.11: `<?xml v?>`)", () => {
  const d = {
    type: "MxDeclaration",
    start: 0,
    end: 9,
    value: "xml v",
    valueSpan: sp(2, 7),
  } satisfies MxDeclaration;
  const { value: _v, ...rest } = d;
  // @ts-expect-error missing `value`
  const missing: MxDeclaration = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxDeclaration = { ...d, type: "MxDoctype" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxModuleStatement (ast §3.10: `static const A = 1 // trailing`)", () => {
  const s = {
    type: "MxModuleStatement",
    start: 0,
    end: 30,
    keyword: "static",
    code: statements(7, 18),
    untrimmedEnd: 30,
  } satisfies MxModuleStatement;
  const { keyword: _k, ...rest } = s;
  // @ts-expect-error missing `keyword`
  const missing: MxModuleStatement = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxModuleStatement = { ...s, type: "MxScriptlet" };
  const { untrimmedEnd: _u, ...noEnd } = s;
  // @ts-expect-error missing `untrimmedEnd`
  const missingEnd: MxModuleStatement = noEnd;
  expect(missingEnd).toBeDefined();
  // @ts-expect-error not one of the six keywords
  const badKeyword: MxModuleStatement = { ...s, keyword: "let" };
  expect([missing, wrong, badKeyword]).toHaveLength(3);
});

it('MxAttribute (ast §3.5: `type="email"`, and the default value)', () => {
  const named = {
    type: "MxAttribute",
    start: 16,
    end: 28,
    name: "type",
    nameSpan: sp(16, 20),
    operator: "=",
    value: expr(21, 28, '"email"'),
    args: null,
  } satisfies MxAttribute;
  const defaulted = {
    ...named,
    name: null,
    nameSpan: sp(3, 3),
    start: 3,
  } satisfies MxAttribute;
  const { nameSpan: _n, ...rest } = named;
  // @ts-expect-error missing `nameSpan`
  const missing: MxAttribute = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxAttribute = { ...named, type: "MxShorthand" };
  // @ts-expect-error `:=` and `=` are the only operators
  const badOp: MxAttribute = { ...named, operator: "==" };
  expect([defaulted, missing, wrong, badOp]).toHaveLength(4);
});

it("MxMethod (ast §3.5a: `onInput(e) { set(e) }`)", () => {
  const m = {
    type: "MxMethod",
    start: 10,
    end: 24,
    async: false,
    typeParams: null,
    params: params(11, 12),
    body: statements(15, 23),
    source: "(e) { set(e) }",
  } satisfies MxMethod;
  const { body: _b, ...rest } = m;
  // @ts-expect-error missing `body`
  const missing: MxMethod = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxMethod = { ...m, type: "MxAttribute" };
  expect([missing, wrong]).toHaveLength(2);
});

it("MxSpreadAttribute (ast §3.5b: `<b ...rest/>`)", () => {
  const s = {
    type: "MxSpreadAttribute",
    start: 3,
    end: 10,
    value: expr(6, 10, "rest"),
  } satisfies MxSpreadAttribute;
  const { value: _v, ...rest } = s;
  // @ts-expect-error missing `value`
  const missing: MxSpreadAttribute = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxSpreadAttribute = { ...s, type: "MxAttribute" };
  expect([missing, wrong]).toHaveLength(2);
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: the test name quotes MX dynamic-shorthand syntax
it("MxShorthand (ast §3.6: `.c`, and a dynamic `.${x}`)", () => {
  const cls = {
    type: "MxShorthand",
    start: 2,
    end: 4,
    sigil: ".",
    position: "tag",
    value: { kind: "static", value: "c", span: sp(3, 4) },
    operator: null,
    default: null,
    args: null,
  } satisfies MxShorthand;
  const dynamic = {
    ...cls,
    end: 7,
    value: {
      kind: "dynamic",
      template: expr(3, 7),
      quasis: [sp(3, 3), sp(7, 7)],
      expressions: [expr(5, 6, "x")],
      span: sp(3, 7),
    },
  } satisfies MxShorthand;
  const { sigil: _s, ...rest } = cls;
  // @ts-expect-error missing `sigil`
  const missing: MxShorthand = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxShorthand = { ...cls, type: "MxAttribute" };
  // @ts-expect-error `@` is not a sigil
  const badSigil: MxShorthand = { ...cls, sigil: "@" };
  expect([dynamic, missing, wrong, badSigil]).toHaveLength(4);
});

it("MxParseError (ast §3.13: `<div></span>`)", () => {
  const e = {
    type: "MxParseError",
    start: 5,
    end: 12,
    code: "MISMATCHED_CLOSING_TAG",
    origin: "template",
    message: "closing tag does not match",
    context: null,
  } satisfies MxParseError;
  const { code: _c, ...rest } = e;
  // @ts-expect-error missing `code`
  const missing: MxParseError = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxParseError = { ...e, type: "MxAtom" };
  // @ts-expect-error the error carries `start`/`end`, not a `span` field
  const withSpan: MxParseError = { ...e, span: sp(5, 12) };
  // @ts-expect-error lowering is not an origin
  const badOrigin: MxParseError = { ...e, origin: "lowering" };
  expect([missing, wrong, withSpan, badOrigin]).toHaveLength(4);
});

it("MxAtom (ast §4.3: `:title` in `accept=[:title]`)", () => {
  const a = {
    type: "MxAtom",
    start: 15,
    end: 21,
    name: "title",
  } satisfies MxAtom;
  const { name: _n, ...rest } = a;
  // @ts-expect-error missing `name`
  const missing: MxAtom = rest;
  // @ts-expect-error wrong discriminator
  const wrong: MxAtom = { ...a, type: "MxText" };
  expect([missing, wrong]).toHaveLength(2);
});

it("the expression containers (ast §4.1)", () => {
  const e = expr(3, 4, "y");
  const pattern = { ...e, type: "MxPattern", node: null } satisfies MxPattern;
  const args = { ...e, type: "MxArguments", node: null } satisfies MxArguments;
  const typeArgs = {
    ...e,
    type: "MxTypeArguments",
    node: null,
  } satisfies MxTypeArguments;
  const typeParams = {
    ...e,
    type: "MxTypeParameters",
    node: null,
  } satisfies MxTypeParameters;
  expect([pattern, args, typeArgs, typeParams, params(1, 2)]).toHaveLength(5);

  const generic: MxExpressionContainer<string> = {
    start: 0,
    end: 1,
    source: "x",
    outer: sp(0, 1),
    node: "payload",
    error: null,
    atoms: [],
  };
  expectTypeOf(generic.node).toEqualTypeOf<string | null>();

  const { source: _s, ...noSource } = e;
  // @ts-expect-error missing `source`
  const missing: MxExpression = noSource;
  // @ts-expect-error wrong discriminator
  const wrong: MxExpression = { ...e, type: "MxStatements" };
  // @ts-expect-error a pattern container is not an expression container
  const crossed: MxPattern = e;
  // @ts-expect-error missing `atoms`
  const missingAtoms: MxStatements = { ...statements(0, 1), atoms: undefined };
  // @ts-expect-error wrong discriminator
  const wrongParams: MxParameterList = { ...params(1, 2), type: "MxPattern" };
  expect([missing, wrong, crossed, missingAtoms, wrongParams]).toHaveLength(5);
});

// ---- field shapes and unions ------------------------------------------------

it("field shapes: MxCloseTag, MxTagName, MxShorthandValue, MxFragmentBase", () => {
  const close = {
    span: sp(52, 58),
    name: "Row",
    nameSpan: sp(54, 57),
  } satisfies MxCloseTag;
  // @ts-expect-error missing `nameSpan`
  const noName: MxCloseTag = { span: sp(0, 1), name: null };
  expect([close, noName]).toHaveLength(2);

  const names = [
    { kind: "static", value: "input", span: sp(1, 6) },
    { kind: "dynamic", expression: expr(3, 4, "x"), span: sp(1, 5) },
    { kind: "unnamed", span: sp(1, 1) },
  ] satisfies MxTagName[];
  // @ts-expect-error `unnamed` has no `value`
  const bad: MxTagName = { kind: "unnamed", value: "x", span: sp(1, 1) };
  expect([names, bad]).toHaveLength(2);

  const value: MxShorthandValue = {
    kind: "static",
    value: "c",
    span: sp(3, 4),
  };
  // @ts-expect-error `dynamic` needs a template
  const badValue: MxShorthandValue = { kind: "dynamic", span: sp(3, 4) };
  expect([value, badValue]).toHaveLength(2);

  const base: MxFragmentBase = { offset: 0, line: 0, column: 0 };
  // @ts-expect-error missing `column`
  const badBase: MxFragmentBase = { offset: 0, line: 0 };
  expect([base, badBase]).toHaveLength(2);
});

it("body modes, tagShape and the front end's two inputs (ast §3.12, §7.1)", () => {
  const modes: MxBodyMode[] = [
    "html",
    "parsed-text",
    "preserve",
    "parsed-text-preserve",
    "void",
  ];
  const shape: MxTagShape = (name) => (name === "br" ? "void" : "html");
  const keywords: MxStatementKeyword[] = [
    "import",
    "export",
    "static",
    "server",
    "client",
    "class",
  ];
  const options = {
    statementKeywords: new Set<MxStatementKeyword>(["import", "static"]),
    tagShape: shape,
  } satisfies MxFrontEndOptions;
  expect(modes).toHaveLength(5);
  expect(keywords).toHaveLength(6);
  expect(options.tagShape("br")).toBe("void");
  // @ts-expect-error not a body mode
  const badMode: MxBodyMode = "text";
  // @ts-expect-error not a statement keyword
  const badKeyword: MxStatementKeyword = "let";
  // @ts-expect-error missing `tagShape`
  const badOptions: MxFrontEndOptions = { statementKeywords: new Set() };
  expect([badMode, badKeyword, badOptions]).toHaveLength(3);
});

it("MxChild is the child-list members and MxNode adds the rest (ast §3.0)", () => {
  expectTypeOf<MxChild["type"]>().toEqualTypeOf<
    | "MxTag"
    | "MxAttributeTag"
    | "MxReturn"
    | "MxText"
    | "MxPlaceholder"
    | "MxScriptlet"
    | "MxComment"
    | "MxCDATA"
    | "MxDoctype"
    | "MxDeclaration"
    | "MxModuleStatement"
  >();
  // @ts-expect-error an attribute is never a child
  const notChild: MxChild["type"] = "MxAttribute";
  expect(notChild).toBe("MxAttribute");
});

// ---- the contract of every node, from one table -----------------------------
//
// For each node type: the required-key set (every key of every node is
// required; ast tables say "Opt.: no" throughout), the nullable keys (those that
// take `null`), and one sample. Generated assertions per node (25 nodes):
//   type level: required keys equal; nullable keys equal; no writable field; no
//               mutable array field
//   runtime:    the sample's keys equal the required set; nullable keys are
//               keys of the sample
// = 6 assertions per node, 150 in all.

type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type IsNever<X> = [X] extends [never] ? true : false;
type NodeOf<K extends MxNode["type"]> = Extract<MxNode, { type: K }>;
type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
type NullableKeys<T> = {
  [K in keyof T]-?: null extends T[K] ? K : never;
}[keyof T];
type WritableKeys<T> = {
  [K in keyof T]-?: Eq<Pick<T, K>, { -readonly [Q in K]: T[K] }> extends true
    ? K
    : never;
}[keyof T];
// `node` is a Babel payload, which stays as Babel types it (decision 163
// addendum 6): its arrays are Babel's, not ours.
type MutableArrayKeys<T> = {
  [K in keyof T]-?: K extends "node"
    ? never
    : NonNullable<T[K]> extends unknown[]
      ? K
      : never;
}[keyof T];

const BASE = ["type", "start", "end"] as const;
const TAG_KEYS = [
  ...BASE,
  "name",
  "typeArgs",
  "var",
  "args",
  "typeParams",
  "params",
  "shorthands",
  "attributes",
  "body",
  "bodyMode",
  "selfClosed",
  "concise",
  "openTag",
  "closeTag",
  "incomplete",
] as const;
const TAG_NULLABLE = [
  "typeArgs",
  "var",
  "args",
  "typeParams",
  "params",
  "body",
  "closeTag",
] as const;
const CONTAINER_KEYS = [
  ...BASE,
  "source",
  "outer",
  "node",
  "error",
  "atoms",
] as const;
const CONTAINER_NULLABLE = ["node", "error"] as const;
const VALUE_KEYS = [...BASE, "value", "valueSpan"] as const;

const ROWS = {
  MxDocument: {
    required: [...BASE, "body", "errors", "complete", "source", "base"],
    nullable: [],
  },
  MxTag: { required: TAG_KEYS, nullable: TAG_NULLABLE },
  MxAttributeTag: { required: TAG_KEYS, nullable: TAG_NULLABLE },
  MxReturn: { required: TAG_KEYS, nullable: TAG_NULLABLE },
  MxText: { required: [...BASE, "value", "raw", "valueSpan"], nullable: [] },
  MxPlaceholder: { required: [...BASE, "escape", "expression"], nullable: [] },
  MxScriptlet: { required: [...BASE, "block", "code"], nullable: [] },
  MxComment: {
    required: [...BASE, "kind", "value", "valueSpan"],
    nullable: [],
  },
  MxCDATA: { required: VALUE_KEYS, nullable: [] },
  MxDoctype: { required: VALUE_KEYS, nullable: [] },
  MxDeclaration: { required: VALUE_KEYS, nullable: [] },
  MxModuleStatement: {
    required: [...BASE, "keyword", "code", "untrimmedEnd"],
    nullable: [],
  },
  MxAttribute: {
    required: [...BASE, "name", "nameSpan", "operator", "value", "args"],
    nullable: ["name", "operator", "value", "args"],
  },
  MxShorthand: {
    required: [
      ...BASE,
      "sigil",
      "position",
      "value",
      "operator",
      "default",
      "args",
    ],
    nullable: ["operator", "default", "args"],
  },
  MxSpreadAttribute: { required: [...BASE, "value"], nullable: [] },
  MxMethod: {
    required: [...BASE, "async", "typeParams", "params", "body", "source"],
    nullable: ["typeParams"],
  },
  MxParseError: {
    required: [...BASE, "code", "origin", "message", "context"],
    nullable: ["context"],
  },
  MxAtom: { required: [...BASE, "name"], nullable: [] },
  MxExpression: { required: CONTAINER_KEYS, nullable: CONTAINER_NULLABLE },
  MxStatements: { required: CONTAINER_KEYS, nullable: CONTAINER_NULLABLE },
  MxPattern: { required: CONTAINER_KEYS, nullable: CONTAINER_NULLABLE },
  MxArguments: { required: CONTAINER_KEYS, nullable: CONTAINER_NULLABLE },
  MxParameterList: { required: CONTAINER_KEYS, nullable: CONTAINER_NULLABLE },
  MxTypeArguments: { required: CONTAINER_KEYS, nullable: CONTAINER_NULLABLE },
  MxTypeParameters: { required: CONTAINER_KEYS, nullable: CONTAINER_NULLABLE },
} as const satisfies Record<
  MxNode["type"],
  { required: readonly string[]; nullable: readonly string[] }
>;
type Rows = typeof ROWS;

type Verdicts = {
  [K in keyof Rows]: [
    Eq<RequiredKeys<NodeOf<K>>, Rows[K]["required"][number]>,
    Eq<NullableKeys<NodeOf<K>>, Rows[K]["nullable"][number]>,
    IsNever<WritableKeys<NodeOf<K>>>,
    IsNever<MutableArrayKeys<NodeOf<K>>>,
  ];
};

// The nodes with at least one false verdict; `never` when the table holds.
type FailingNodes = {
  [K in keyof Verdicts]: false extends Verdicts[K][number] ? K : never;
}[keyof Verdicts];

const SAMPLES: { [K in MxNode["type"]]: NodeOf<K> } = (() => {
  const tag = {
    ...tagFields,
    start: 0,
    end: 11,
  };
  const container = <T extends MxNode["type"]>(type: T) =>
    ({ ...expr(3, 4, "y"), type, node: null }) as never as NodeOf<T>;
  const value = { start: 0, end: 1, value: "v", valueSpan: sp(0, 1) };
  return {
    MxDocument: {
      type: "MxDocument",
      start: 0,
      end: 8,
      body: [],
      errors: [],
      complete: true,
      source: "<p>x</p>",
      base: { offset: 0, line: 0, column: 0 },
    },
    MxTag: {
      ...tag,
      type: "MxTag",
      name: { kind: "static", value: "br", span: sp(1, 3) },
    },
    MxAttributeTag: {
      ...tag,
      type: "MxAttributeTag",
      name: { value: "head", span: sp(1, 6) },
    },
    MxReturn: {
      ...tag,
      type: "MxReturn",
      name: { kind: "static", value: "return", span: sp(1, 7) },
    },
    MxText: {
      type: "MxText",
      start: 3,
      end: 7,
      value: "a",
      raw: "\n  a",
      valueSpan: sp(6, 7),
    },
    MxPlaceholder: {
      type: "MxPlaceholder",
      start: 3,
      end: 11,
      escape: false,
      expression: expr(6, 10, "html"),
    },
    MxScriptlet: {
      type: "MxScriptlet",
      start: 0,
      end: 14,
      block: false,
      code: statements(2, 14),
    },
    MxComment: { ...value, type: "MxComment", kind: "html" },
    MxCDATA: { ...value, type: "MxCDATA" },
    MxDoctype: { ...value, type: "MxDoctype" },
    MxDeclaration: { ...value, type: "MxDeclaration" },
    MxModuleStatement: {
      type: "MxModuleStatement",
      start: 0,
      end: 30,
      keyword: "static",
      code: statements(7, 18),
      untrimmedEnd: 33,
    },
    MxAttribute: {
      type: "MxAttribute",
      start: 16,
      end: 28,
      name: "type",
      nameSpan: sp(16, 20),
      operator: "=",
      value: expr(21, 28, '"email"'),
      args: null,
    },
    MxShorthand: {
      type: "MxShorthand",
      start: 2,
      end: 4,
      sigil: ".",
      position: "tag",
      value: { kind: "static", value: "c", span: sp(3, 4) },
      operator: null,
      default: null,
      args: null,
    },
    MxSpreadAttribute: {
      type: "MxSpreadAttribute",
      start: 3,
      end: 10,
      value: expr(6, 10, "rest"),
    },
    MxMethod: {
      type: "MxMethod",
      start: 10,
      end: 24,
      async: false,
      typeParams: null,
      params: params(11, 12),
      body: statements(15, 23),
      source: "(e) { set(e) }",
    },
    MxParseError: {
      type: "MxParseError",
      start: 5,
      end: 12,
      code: "MISMATCHED_CLOSING_TAG",
      origin: "template",
      message: "closing tag does not match",
      context: null,
    },
    MxAtom: { type: "MxAtom", start: 15, end: 21, name: "title" },
    MxExpression: expr(3, 4, "y"),
    MxStatements: statements(2, 14),
    MxPattern: container("MxPattern"),
    MxArguments: container("MxArguments"),
    MxParameterList: params(1, 2),
    MxTypeArguments: container("MxTypeArguments"),
    MxTypeParameters: container("MxTypeParameters"),
  };
})();

it("every node: required keys, nullable keys, read-only fields and arrays", () => {
  // Names every node with a false type-level verdict; none may.
  expectTypeOf<FailingNodes>().toEqualTypeOf<never>();
  const nodes = Object.keys(ROWS) as (keyof Rows)[];
  expect(nodes).toHaveLength(25);
  expect(new Set(nodes)).toEqual(new Set(NODE_TYPES));
  let assertions = 0;
  for (const name of nodes) {
    const row = ROWS[name];
    const sample = SAMPLES[name] as unknown as Record<string, unknown>;
    expect(Object.keys(sample).sort(), `${name} keys`).toEqual(
      [...row.required].sort(),
    );
    for (const key of row.nullable) expect(sample, name).toHaveProperty(key);
    assertions += 2;
  }
  expect(assertions).toBe(50);
});

it("nullable fields take null and the others do not (spot checks of the table)", () => {
  const tag = SAMPLES.MxTag;
  const nulls = { ...tag, var: null, args: null, body: null, closeTag: null };
  expect(nulls.var).toBeNull();
  // @ts-expect-error `name` is never null
  const noName: MxTag = { ...tag, name: null };
  // @ts-expect-error `attributes` is never null
  const noAttrs: MxTag = { ...tag, attributes: null };
  expect([noName, noAttrs]).toHaveLength(2);
});

it("the AST is read-only in the type system (ast §4.1a)", () => {
  const tag = SAMPLES.MxTag;
  // @ts-expect-error fields are readonly
  tag.concise = true;
  // @ts-expect-error arrays are readonly
  tag.shorthands.push(SAMPLES.MxShorthand);
  // @ts-expect-error a container's fields are readonly
  SAMPLES.MxExpression.source = "z";
  // @ts-expect-error nested field shapes are readonly
  tag.openTag.start = 1;
  // @ts-expect-error a union member of a field shape is readonly too
  if (tag.name.kind === "static") tag.name.value = "x";
});

// ---- container payloads ------------------------------------------------------

it("each container holds the Babel payload ast §4.1 names", () => {
  expectTypeOf<NonNullable<MxExpression["node"]>>().toEqualTypeOf<Expression>();
  expectTypeOf<NonNullable<MxStatements["node"]>>().toEqualTypeOf<
    Statement[]
  >();
  expectTypeOf<NonNullable<MxPattern["node"]>>().toEqualTypeOf<LVal>();
  expectTypeOf<NonNullable<MxArguments["node"]>>().toEqualTypeOf<
    (Expression | SpreadElement)[]
  >();
  expectTypeOf<NonNullable<MxParameterList["node"]>>().toEqualTypeOf<
    FunctionParameter[]
  >();
  expectTypeOf<
    NonNullable<MxTypeArguments["node"]>
  >().toEqualTypeOf<TSTypeParameterInstantiation>();
  expectTypeOf<
    NonNullable<MxTypeParameters["node"]>
  >().toEqualTypeOf<TSTypeParameterDeclaration>();
  expect(true).toBe(true);
});
