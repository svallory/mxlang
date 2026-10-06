import type {
  MxBodyMode,
  MxFrontEndOptions,
  MxStatementKeyword,
} from "@mxlang/babel/mx-ast";

/** The language's six statement keywords (ast §3.10). */
export const SIX: ReadonlySet<MxStatementKeyword> = new Set([
  "import",
  "export",
  "static",
  "server",
  "client",
  "class",
]);

/** A fixed shape table for tests: the html family's text, preserve and void elements and the core void tags (ast §3.12). */
const SHAPES: Record<string, MxBodyMode> = {
  title: "parsed-text",
  "html-comment": "parsed-text",
  script: "parsed-text-preserve",
  style: "parsed-text-preserve",
  textarea: "parsed-text-preserve",
  "html-script": "parsed-text-preserve",
  "html-style": "parsed-text-preserve",
  pre: "preserve",
  input: "void",
  br: "void",
  img: "void",
  area: "void",
  let: "void",
  const: "void",
  id: "void",
  lifecycle: "void",
  log: "void",
  debug: "void",
  return: "void",
};

export const tagShape = (name: string): MxBodyMode => SHAPES[name] ?? "html";

export const OPTIONS: MxFrontEndOptions = { statementKeywords: SIX, tagShape };
