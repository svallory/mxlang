/**
 * The MX tree in the neutral form (`neutral.ts`).
 */
import type { InterimDocument } from "../../parser/src/frontend/interim.ts";
import { type NDocument, type NNode, type NTag, text } from "./neutral.ts";

// biome-ignore lint/suspicious/noExplicitAny: walks every node shape
type Node = any;

const HEAD = ["typeArgs", "var", "args", "typeParams", "params"] as const;

export function projectMx(document: InterimDocument): NDocument {
  const template = document.errors.find((e) => e.origin === "template");
  return {
    body: document.body.map(child),
    error: template
      ? `${template.code} [${template.start},${template.end}) ${JSON.stringify(template.message)}`
      : null,
  };
}

function child(node: Node): NNode {
  const span = [node.start, node.end] as const;
  switch (node.type) {
    case "MxTag":
    case "MxReturn":
    case "MxAttributeTag":
      return tag(node);
    case "MxText":
      return { kind: "text", span, detail: "" };
    case "MxPlaceholder":
      return {
        kind: "placeholder",
        span,
        detail: `${node.escape ? "" : "unescaped "}${text(node.expression.source)}`,
      };
    case "MxScriptlet":
      return { kind: "scriptlet", span, detail: "" };
    case "MxComment":
      return { kind: "comment", span, detail: node.kind };
    case "MxCDATA":
      return { kind: "cdata", span, detail: JSON.stringify(node.value) };
    case "MxDoctype":
      return { kind: "doctype", span, detail: JSON.stringify(node.value) };
    case "MxDeclaration":
      return { kind: "declaration", span, detail: JSON.stringify(node.value) };
    case "MxModuleStatement":
      return {
        kind: "statement",
        span: [node.start, node.untrimmedEnd],
        detail: `${node.keyword} trimmedEnd=${node.end}`,
      };
    default:
      throw new Error(`unknown node ${node.type}`);
  }
}

export function sugarLine(sigil: string, value: string, extra = ""): string {
  return `sugar ${sigil}${value}${extra}`;
}

function tagName(node: Node): string {
  if (node.type === "MxAttributeTag") return `@${node.name.value}`;
  if (node.name.kind === "static") return JSON.stringify(node.name.value);
  if (node.name.kind === "unnamed") return "(unnamed)";
  return `dynamic ${text(node.name.expression.source)}`;
}

function value(item: Node): string {
  if (!item) return "";
  if (item.type === "MxMethod") return ` method ${text(item.source)}`;
  return ` ${text(item.source)}`;
}

function tag(node: Node): NTag {
  // An empty head part (`||`, `()`) is not projected: today's tree cannot
  // tell it from an absent one.
  const head = HEAD.filter(
    (key) => node[key] && node[key].source.trim() !== "",
  ).map((key) => `${key} ${text(node[key].source)}`);
  const tagSugar = node.shorthands.map((s: Node) =>
    s.value.kind === "static"
      ? sugarLine(s.sigil, JSON.stringify(s.value.value))
      : sugarLine(s.sigil, `dynamic ${text(s.value.template.source)}`),
  );
  const order = (line: string) =>
    line.startsWith("sugar #") ? 0 : line.startsWith("sugar .") ? 1 : 2;
  const sugar = tagSugar
    .map((line: string, i: number) => ({ line, i }))
    .sort(
      (a: { line: string; i: number }, b: { line: string; i: number }) =>
        order(a.line) - order(b.line) || a.i - b.i,
    )
    .map((x: { line: string }) => x.line);
  const attrs = node.attributes.map((item: Node) => {
    const span = `[${item.start},${item.end})`;
    switch (item.type) {
      case "MxShorthand":
        return `${sugarLine(item.sigil, JSON.stringify(item.value.value))}${item.operator ? ` ${item.operator}` : ""}${value(item.default)}`;
      case "MxSpreadAttribute":
        return `spread ${span} ${text(item.value.source)}`;
      case "MxComment":
        return `comment ${item.kind} ${span}`;
      default: {
        const name =
          item.name === null ? "(default)" : JSON.stringify(item.name);
        const args = item.args ? ` args ${text(item.args.source)}` : "";
        return `attr ${name} ${span}${item.operator ? ` ${item.operator}` : ""}${value(item.value)}${args}`;
      }
    }
  });
  return {
    kind: "tag",
    name: tagName(node),
    span: [node.start, node.end],
    head,
    sugar,
    attrs,
    children: (node.body ?? []).map(child),
  };
}
