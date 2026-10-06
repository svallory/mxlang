/**
 * The neutral projection of an MX tree (brief §1.2 C and D): one line per
 * node, indented by depth, carrying node kind, names, spans, raw text spans,
 * expression source text, attribute order, shorthand parts, statement kind
 * and error code and range. `MxText.value` and expression payloads are not
 * projected (PR 3), nor are the front end's `MX_*` errors (PR 2b).
 *
 * The tree differential (`packages/tests/parse-differential`) builds the same
 * form from today's Marko tree.
 */
import type { InterimDocument } from "../interim.ts";

// biome-ignore lint/suspicious/noExplicitAny: projects every node shape
type Node = any;

const r = (span: { start: number; end: number }) =>
  `[${span.start},${span.end})`;
const q = (text: string) => JSON.stringify(text);
const expr = (container: Node) => `${q(container.source)} ${r(container)}`;

export function projectDocument(document: InterimDocument): string[] {
  const out: string[] = [];
  for (const child of document.body) projectChild(child, 0, out);
  for (const error of document.errors) {
    if (
      error.code.startsWith("MX_") &&
      error.code !== "MX_FRONT_END_INTERNAL"
    ) {
      continue;
    }
    out.push(`error ${error.code} ${r(error)}`);
  }
  return out;
}

export function projectChild(node: Node, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  switch (node.type) {
    case "MxTag":
    case "MxReturn":
    case "MxAttributeTag": {
      out.push(`${pad}${tagLine(node)}`);
      projectHead(node, depth + 1, out);
      for (const child of node.body ?? []) projectChild(child, depth + 1, out);
      return;
    }
    case "MxText":
      out.push(`${pad}text ${r(node)}`);
      return;
    case "MxPlaceholder":
      out.push(
        `${pad}placeholder${node.escape ? "" : " unescaped"} ${r(node)} ${expr(node.expression)}`,
      );
      return;
    case "MxScriptlet":
      out.push(
        `${pad}scriptlet${node.block ? " block" : ""} ${r(node)} ${expr(node.code)}`,
      );
      return;
    case "MxModuleStatement":
      out.push(
        `${pad}statement ${node.keyword} ${r(node)} untrimmedEnd=${node.untrimmedEnd}`,
      );
      return;
    case "MxComment":
      out.push(
        `${pad}comment ${node.kind} ${r(node)} value=${r(node.valueSpan)}`,
      );
      return;
    case "MxCDATA":
    case "MxDoctype":
    case "MxDeclaration":
      out.push(
        `${pad}${node.type.slice(2).toLowerCase()} ${r(node)} value=${q(node.value)}`,
      );
      return;
    default:
      out.push(`${pad}unknown ${node.type}`);
  }
}

function tagName(node: Node): string {
  if (node.type === "MxAttributeTag")
    return `@${node.name.value} ${r(node.name.span)}`;
  const name = node.name;
  if (name.kind === "static") return `${q(name.value)} ${r(name.span)}`;
  if (name.kind === "unnamed") return `unnamed ${r(name.span)}`;
  return `dynamic ${r(name.span)} ${expr(name.expression)}`;
}

function tagLine(node: Node): string {
  const kind =
    node.type === "MxReturn"
      ? "return"
      : node.type === "MxAttributeTag"
        ? "attribute-tag"
        : "tag";
  const flags = [
    node.concise ? "concise" : "",
    node.selfClosed ? "self-closed" : "",
    node.incomplete ? "incomplete" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const close = node.closeTag
    ? ` close=${r(node.closeTag.span)}${node.closeTag.name === null ? " </>" : ` ${q(node.closeTag.name)}`}`
    : "";
  return `${kind} ${tagName(node)} ${r(node)} open=${r(node.openTag)}${close} mode=${node.bodyMode}${flags ? ` ${flags}` : ""}`;
}

function projectHead(node: Node, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  for (const key of ["typeArgs", "var", "args", "typeParams", "params"]) {
    if (node[key]) out.push(`${pad}${key} ${expr(node[key])}`);
  }
  for (const sugar of node.shorthands) out.push(`${pad}${sugarLine(sugar)}`);
  for (const item of node.attributes) {
    switch (item.type) {
      case "MxShorthand":
        out.push(`${pad}${sugarLine(item)}`);
        break;
      case "MxSpreadAttribute":
        out.push(`${pad}spread ${r(item)} ${expr(item.value)}`);
        break;
      case "MxComment":
        out.push(`${pad}comment ${item.kind} ${r(item)}`);
        break;
      default: {
        const name = item.name === null ? "default" : q(item.name);
        const parts = [
          `${pad}attr ${name} ${r(item)} name=${r(item.nameSpan)}`,
        ];
        if (item.operator) parts.push(item.operator);
        if (item.value) parts.push(valueText(item.value));
        if (item.args) parts.push(`args ${expr(item.args)}`);
        out.push(parts.join(" "));
      }
    }
  }
}

function valueText(value: Node): string {
  if (value.type === "MxMethod") {
    return `method${value.async ? " async" : ""} ${r(value)} params ${expr(value.params)} body ${expr(value.body)}`;
  }
  return `value ${expr(value)}`;
}

function sugarLine(node: Node): string {
  const value =
    node.value.kind === "static"
      ? q(node.value.value)
      : `dynamic ${r(node.value.span)} ${expr(node.value.template)}`;
  const parts = [`sugar ${node.position} ${node.sigil} ${value} ${r(node)}`];
  if (node.operator) parts.push(node.operator);
  if (node.default) parts.push(valueText(node.default));
  return parts.join(" ");
}
