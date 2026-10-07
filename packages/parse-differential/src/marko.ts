/**
 * Today's tree in the neutral form: `@marko/compiler`'s parse through
 * `@mxlang/core`'s `markoCompiler()`, with the html target's taglibs (MX's
 * core taglib and Marko's built-in element taglibs), as `parseFragment` and
 * `compileSource` obtain it, translating nothing. The mapping rules
 * (`rules.ts`) are applied here, each at the site its id names.
 */
import type { MxBodyMode } from "@mxlang/babel/mx-ast";
import { CORE_TAGLIB, markoCompiler } from "@mxlang/core";
import {
  code,
  type NDocument,
  type NLeaf,
  type NNode,
  type NTag,
  type Span,
  text,
} from "./neutral.ts";
import {
  lineStartsOf,
  offsetOf,
  rejoinAttributeName,
  splitAtFirstColon,
  splitChain,
  thrownTemplateError,
} from "./rules.ts";

// biome-ignore lint/suspicious/noExplicitAny: Marko's nodes are untyped
type Node = any;

const TRANSLATOR = {
  taglibs: [["mx-translator-core", CORE_TAGLIB]],
  tagDiscoveryDirs: [],
  translate: {},
};
const DIR = "/parse-differential";
const FILE = `${DIR}/input.mx`;
const STATEMENTS = new Set([
  "import",
  "export",
  "static",
  "server",
  "client",
  "class",
]);

function lookup(): Node {
  return markoCompiler().taglib.buildLookup(DIR, TRANSLATOR);
}

/** The html target's shape table, read from the same taglib lookup Marko parses with (A15: same input). */
export function markoTagShape(name: string): MxBodyMode {
  const options = lookup().getTag(name)?.parseOptions;
  if (!options) return "html";
  if (options.openTagOnly) return "void";
  if (options.text)
    return options.preserveWhitespace ? "parsed-text-preserve" : "parsed-text";
  return options.preserveWhitespace ? "preserve" : "html";
}

export interface MarkoResult {
  readonly document: NDocument;
  /** Marko text ranges, for rule `text-runs` (A13). */
  readonly texts: (readonly [number, number])[];
  /** Ranges of expressions today's tree holds as `MarkoParseError` (no atoms inside). */
  readonly failed?: readonly Span[];
  /** Set when today's path threw something that is not the template parser's error. */
  readonly crash?: string;
}

export function projectMarko(source: string): MarkoResult {
  const starts = lineStartsOf(source);
  const compiler = markoCompiler();
  lookup();
  let ast: Node;
  try {
    const config: Node = {
      output: "source",
      ast: true,
      translator: TRANSLATOR,
    };
    ast = compiler.compileSync(source, FILE, config).ast;
  } catch (error) {
    // Rule `template-error` (A10). Marko aggregates the expression errors it
    // collected (PR 3) before the template error, which comes last.
    const errors: Node[] | undefined = (error as Node)?.errors;
    const last = Array.isArray(errors) ? errors[errors.length - 1] : error;
    const thrown =
      thrownTemplateError(last, starts) ??
      thrownTemplateError(error as Node, starts);
    if (thrown) {
      return {
        document: {
          body: [],
          atoms: [],
          error: `[${thrown.start},${thrown.end}) ${JSON.stringify(thrown.message)}`,
        },
        texts: [],
      };
    }
    const message =
      String((error as Error)?.message ?? error)
        .split("\n")
        .find((l) => l.trim()) ?? "";
    return {
      document: { body: [], atoms: [], error: null },
      texts: [],
      crash: message.trim(),
    };
  }
  const texts: (readonly [number, number])[] = [];
  const ctx = { source, starts, texts };
  // Atoms (decision 156): today's parser hands Babel a numeric stand-in at
  // each atom, so an atom is a NumericLiteral whose source starts with `:`.
  const atoms: { start: number; line: string }[] = [];
  /** Expressions today's Babel could not parse: their atoms are not in today's tree. */
  const failed: Span[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    const node = value as Node;
    if (node.type === "MarkoParseError" && node.loc) {
      failed.push(spanOf(ctx, node));
    }
    const at = node.loc?.start?.index;
    if (
      node.type === "NumericLiteral" &&
      typeof at === "number" &&
      source[at] === ":"
    ) {
      const end = node.loc.end.index;
      atoms.push({
        start: at,
        line: `:${source.slice(at + 1, end)}@[${at},${end})`,
      });
    }
    for (const [key, field] of Object.entries(node)) {
      if (key !== "loc" && key !== "extra") walk(field);
    }
  };
  walk(ast.program);
  return {
    document: {
      body: children(ctx, ast.program.body, []),
      atoms: atoms.sort((x, y) => x.start - y.start).map((x) => x.line),
      error: null,
    },
    failed,
    texts,
  };
}

interface Ctx {
  source: string;
  starts: number[];
  texts: (readonly [number, number])[];
}

/** Rule `positions-from-loc` (A12). */
function spanOf(ctx: Ctx, node: Node): Span {
  const index = node.loc?.start?.index;
  if (typeof index === "number" && !node.type?.startsWith("Marko")) {
    return [index, node.loc.end.index];
  }
  // A node Marko never positioned (a tag whose close event never came):
  // printed as [-1,-1] so the difference shows.
  if (!node.loc) return [-1, -1];
  return [
    offsetOf(ctx.starts, node.loc.start),
    offsetOf(ctx.starts, node.loc.end),
  ];
}

/** The authored text of Babel nodes, from the first to the last, parentheses included. */
function nodesText(ctx: Ctx, nodes: Node[]): string {
  const range = nodesRange(ctx, nodes);
  if (!range) return "";
  return "source" in range
    ? range.source
    : ctx.source.slice(range.start, range.end);
}

/** The authored text of Babel nodes with its span, in the neutral form's `code` shape. */
function nodesCode(ctx: Ctx, nodes: Node[]): string {
  const range = nodesRange(ctx, nodes);
  if (!range) return code("", 0);
  if ("source" in range) {
    const [s] = spanOf(ctx, range.node);
    return code(range.source, s);
  }
  return code(ctx.source.slice(range.start, range.end), range.start);
}

function nodesRange(
  ctx: Ctx,
  nodes: Node[],
): { start: number; end: number } | { source: string; node: Node } | undefined {
  if (nodes.length === 0) return undefined;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (node.type === "MarkoParseError") return { source: node.source, node };
    // Babel nodes keep `loc.start.index` through Marko's clone, not `start`.
    let s: number = node.start ?? node.loc?.start.index;
    let e: number = node.end ?? node.loc?.end.index;
    if (typeof s !== "number" && node.loc) [s, e] = spanOf(ctx, node);
    const parenStart = node.extra?.parenStart;
    if (node.extra?.parenthesized && typeof parenStart === "number") {
      let depth = [...ctx.source.slice(parenStart, s)].filter(
        (c) => c === "(",
      ).length;
      while (depth > 0 && e < ctx.source.length) {
        if (ctx.source[e] === ")") depth--;
        e++;
      }
      s = parenStart;
    }
    start = Math.min(start, s);
    end = Math.max(end, e);
  }
  return { start, end };
}

/** Rule `attribute-tags-in-place` (A7): body and moved attribute tags, back in source order. */
function children(ctx: Ctx, body: Node[], moved: Node[]): NNode[] {
  const all = [...body, ...moved]
    .map((node) => ({ node, start: spanOf(ctx, node)[0] }))
    .sort((a, b) => a.start - b.start);
  const out: NNode[] = [];
  for (const { node } of all) {
    const projected = child(ctx, node);
    if (projected) out.push(projected);
  }
  return out;
}

function leaf(kind: NLeaf["kind"], span: Span, detail = ""): NLeaf {
  return { kind, span, detail };
}

function child(ctx: Ctx, node: Node): NNode | undefined {
  const span = spanOf(ctx, node);
  switch (node.type) {
    case "MarkoTag":
      return tag(ctx, node);
    case "MarkoText":
      ctx.texts.push(span);
      return leaf("text", span);
    case "MarkoPlaceholder":
      return leaf(
        "placeholder",
        span,
        `${node.escape === false ? "unescaped " : ""}${nodesCode(ctx, [node.value])}`,
      );
    case "MarkoScriptlet":
      return leaf("scriptlet", span);
    case "MarkoComment":
      return leaf("comment", span, node.kind);
    case "MarkoCDATA":
      return leaf("cdata", span, JSON.stringify(node.value));
    case "MarkoDocumentType":
      return leaf("doctype", span, JSON.stringify(node.value));
    case "MarkoDeclaration":
      return leaf("declaration", span, JSON.stringify(node.value));
    default:
      return leaf("text", span, `unknown ${node.type}`);
  }
}

function tag(ctx: Ctx, node: Node): NNode {
  const span = spanOf(ctx, node);
  const name = node.name;
  // Rule `statement-node` (A8, A18).
  if (
    name?.type === "StringLiteral" &&
    STATEMENTS.has(name.value) &&
    typeof node.rawValue === "string"
  ) {
    let end = span[1];
    while (end > span[0] && /\s/.test(ctx.source[end - 1] as string)) end--;
    return leaf("statement", span, `${name.value} trimmedEnd=${end}`);
  }
  const sugar: string[] = [];
  let projectedName: string;
  if (name.type === "StringLiteral") {
    const [s, e] = spanOf(ctx, name);
    if (name.value.startsWith("@")) projectedName = `${name.value}@[${s},${e})`;
    else if (s === e && name.value === "div")
      projectedName = `(unnamed)@[${s},${s})`; // rule `unnamed-tag` (A5)
    else {
      // Rule `split-name-sugar` (A6): the name splits at its first `:`.
      const [value, colon] = splitAtFirstColon(name.value);
      projectedName =
        value === ""
          ? `(unnamed)@[${s},${s})`
          : `${JSON.stringify(value)}@[${s},${s + value.length})`;
      if (colon) sugar.push(`sugar :${JSON.stringify(colon)}`);
    }
  } else {
    projectedName = `dynamic ${text(templateText(ctx, name))}`; // rule `dynamic-name` (A17)
  }

  // Rule `head-on-tag` (A11).
  const head: string[] = [];
  const part = (key: string, nodes: Node[] | null | undefined) => {
    const value = nodesText(ctx, nodes ?? []);
    if (value.trim() !== "") head.push(`${key} ${nodesCode(ctx, nodes ?? [])}`);
  };
  // A failed sub-parse leaves a `MarkoParseError` (in an array) in place of the node.
  const typeList = (value: Node) =>
    Array.isArray(value)
      ? value
      : value?.type === "MarkoParseError"
        ? [value]
        : value?.params;
  part("typeArgs", typeList(node.typeArguments));
  part("var", node.var ? [node.var] : null);
  part("args", node.arguments);
  part("typeParams", typeList(node.body?.typeParameters));
  part("params", node.body?.params);

  const items: { start: number; line: string }[] = [];
  const tagSugar: string[] = [];
  const comments = (list: Node[] | undefined) => {
    for (const comment of list ?? []) {
      const [s, e] = spanOf(ctx, comment);
      // Rule `open-tag-comments` (A14).
      items.push({
        start: s,
        line: `comment ${comment.type === "CommentBlock" ? "block" : "line"} [${s},${e})`,
      });
    }
  };
  for (const attr of node.attributes) {
    comments(attr.leadingComments);
    if (attr.type === "MarkoSpreadAttribute") {
      const [s, e] = spanOf(ctx, attr);
      items.push({
        start: s,
        line: `spread [${s},${e}) ${nodesCode(ctx, [attr.value])}`,
      });
    } else if (!attr.loc) {
      tagSugar.push(...unmerge(ctx, attr)); // rule `unmerge-shorthands` (A4)
    } else {
      items.push(...attribute(ctx, attr));
    }
    comments(attr.trailingComments);
  }
  comments(node.innerComments);
  items.sort((a, b) => a.start - b.start);
  const order = (line: string) =>
    line.startsWith("sugar #") ? 0 : line.startsWith("sugar .") ? 1 : 2;
  const allSugar = [...sugar, ...tagSugar]
    .map((line, i) => ({ line, i }))
    .sort((a, b) => order(a.line) - order(b.line) || a.i - b.i)
    .map((x) => x.line);
  const tagNode: NTag = {
    kind: "tag",
    name: projectedName,
    span,
    head,
    sugar: allSugar,
    attrs: items.map((i) => i.line),
    children: children(ctx, node.body?.body ?? [], node.attributeTags ?? []),
  };
  return tagNode;
}

/**
 * Rule `dynamic-name` (A17): a name Marko parsed as a whole template literal
 * keeps no position through the clone, so its text is rebuilt from its parts.
 */
function templateText(ctx: Ctx, node: Node): string {
  if (node.type !== "TemplateLiteral" || node.loc)
    return nodesText(ctx, [node]);
  let out = "";
  node.quasis.forEach((quasi: Node, i: number) => {
    out += quasi.value.raw;
    const expression = node.expressions[i];
    if (expression) out += `\${${nodesText(ctx, [expression])}}`;
  });
  return out;
}

/** Rule `unmerge-shorthands` (A4), with `split-name-sugar` (A6) on each static value. */
function unmerge(ctx: Ctx, attr: Node): string[] {
  const sigil = attr.name === "id" ? "#" : ".";
  const values: Node[] =
    attr.value.type === "ArrayExpression" ? attr.value.elements : [attr.value];
  const out: string[] = [];
  for (const value of values) {
    if (value.type === "StringLiteral") {
      for (const word of sigil === "."
        ? value.value.split(" ")
        : [value.value]) {
        const [head, colon] = splitAtFirstColon(word);
        if (head !== "") out.push(`sugar ${sigil}${JSON.stringify(head)}`);
        if (colon) out.push(`sugar :${JSON.stringify(colon)}`);
      }
    } else {
      out.push(`sugar ${sigil}dynamic ${text(templateText(ctx, value))}`);
    }
  }
  return out;
}

/** Whether `=` precedes the node: an authored `x=function…` value, not Marko's method (`onAttrMethod`). */
function afterEquals(ctx: Ctx, node: Node): boolean {
  let at = spanOf(ctx, node)[0] - 1;
  while (at >= 0 && /\s/.test(ctx.source[at] as string)) at--;
  return ctx.source[at] === "=";
}

function valueText(ctx: Ctx, value: Node): string {
  if (
    !value ||
    (value.type === "BooleanLiteral" && !value.loc && value.value === true)
  )
    return "";
  if (value.type === "FunctionExpression" && !afterEquals(ctx, value)) {
    const [s, e] = spanOf(ctx, value);
    return ` method ${text(ctx.source.slice(s, e))}@[${s},${e})`;
  }
  return ` ${nodesCode(ctx, [value])}`;
}

/** One authored Marko attribute: rules `rejoin-attribute-name` (A2), `default-attribute` (A3), `split-name-sugar` (A6). */
function attribute(ctx: Ctx, attr: Node): { start: number; line: string }[] {
  const [s, e] = spanOf(ctx, attr);
  const method =
    attr.value?.type === "FunctionExpression" && !afterEquals(ctx, attr.value);
  const operator = attr.bound ? " :=" : attr.value?.loc && !method ? " =" : "";
  const value = valueText(ctx, attr.value);
  const args = attr.arguments ? ` args ${nodesCode(ctx, attr.arguments)}` : "";
  if (attr.default === true) {
    if (attr.modifier == null) {
      return [
        {
          start: s,
          line: `attr (default) [${s},${e}) name=[${s},${s})${operator}${value}${args}`,
        },
      ];
    }
    // `:x` (A3): the attribute-position `:` sugar, spans from the name.
    const [word, colon] = splitAtFirstColon(attr.modifier);
    const cut = s + 1 + word.length;
    const lines = [`sugar :${JSON.stringify(word)}@[${s},${cut})`];
    if (colon !== undefined) {
      lines.push(
        `sugar :${JSON.stringify(colon)}@[${cut},${cut + 1 + colon.length})`,
      );
    }
    lines[lines.length - 1] += `${operator}${value}${args}`; // rule `sugar-arguments`
    return lines.map((line) => ({ start: s, line }));
  }
  // Rule A2 (decision 163 addendum 12): Marko's `name` is the head before
  // the last colon and `modifier` the tail; MX carries the head in
  // `name`/`nameSpan` plus the modifier and its own span — the neutral line
  // shows the split (the authored name, then the head's span) instead of a
  // rejoined string.
  const head = attr.name ?? "";
  const mod = attr.modifier;
  const authored = rejoinAttributeName(head, mod);
  if (authored.startsWith("#") || authored.startsWith(".")) {
    const lines: string[] = [];
    let at = s;
    for (const part of splitChain(authored)) {
      const [word, colon] = splitAtFirstColon(part.word);
      const cut = at + 1 + word.length;
      lines.push(`sugar ${part.sigil}${JSON.stringify(word)}@[${at},${cut})`);
      if (colon !== undefined) {
        lines.push(
          `sugar :${JSON.stringify(colon)}@[${cut},${cut + 1 + colon.length})`,
        );
      }
      at += 1 + part.word.length;
    }
    lines[lines.length - 1] += `${operator}${value}${args}`; // rule `sugar-arguments`
    return lines.map((line) => ({ start: s, line }));
  }
  // Rule A2: compare the split fields themselves. Marko's `name` is the head
  // before the last colon and `modifier` the tail; MX carries both plus their
  // spans, so the neutral line shows the split instead of a rejoined string.
  const modSpan =
    mod === null || mod === undefined
      ? ""
      : ` mod=${JSON.stringify(mod)}@[${s + head.length + 1},${s + head.length + 1 + mod.length})`;
  return [
    {
      start: s,
      line: `attr ${JSON.stringify(authored)} [${s},${e}) name=[${s},${s + head.length})${modSpan}${operator}${value}${args}`,
    },
  ];
}
