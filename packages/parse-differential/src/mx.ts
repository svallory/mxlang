/**
 * The MX tree in the neutral form (`neutral.ts`).
 */
import type { InterimDocument } from "../../parser/src/frontend/interim.ts";
import {
  code,
  type NDocument,
  type NNode,
  type NTag,
  text,
} from "./neutral.ts";

// biome-ignore lint/suspicious/noExplicitAny: walks every node shape
type Node = any;

const HEAD = ["typeArgs", "var", "args", "typeParams", "params"] as const;

export function projectMx(document: InterimDocument): NDocument {
  // The template error is what the tree differential compares (today's
  // parse throws on it). The first front-end error (PR 2b, ast \u00a73.13)
  // rides separately: today's Marko-front compile throws it the same way,
  // so the error branch may compare against it — the tree beside it stays
  // comparable.
  const template = document.errors.find((e) => e.origin === "template");
  const front = document.errors.find((e) => e.origin === "front-end");
  const atoms: { start: number; line: string }[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (node.type === "MxAtom") {
      atoms.push({
        start: node.start,
        line: `:${node.name}@[${node.start},${node.end})`,
      });
      return;
    }
    for (const field of Object.values(node)) walk(field);
  };
  walk(document.body);
  return {
    atoms: atoms.sort((a, b) => a.start - b.start).map((a) => a.line),
    body: document.body.map(child),
    error: template
      ? `${template.code} [${template.start},${template.end}) ${JSON.stringify(template.message)}`
      : null,
    frontEndError: front
      ? `${front.code} [${front.start},${front.end}) ${JSON.stringify(front.message)}`
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
        detail: `${node.escape ? "" : "unescaped "}${code(node.expression.source, node.expression.start)}`,
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
  const at = `@[${node.name.span.start},${node.name.span.end})`;
  if (node.type === "MxAttributeTag") return `@${node.name.value}${at}`;
  if (node.name.kind === "static")
    return `${JSON.stringify(node.name.value)}${at}`;
  if (node.name.kind === "unnamed") return `(unnamed)${at}`;
  // A dynamic name compares by text only (see rules.ts, "not compared").
  return `dynamic ${text(node.name.expression.source)}`;
}

function value(item: Node): string {
  if (!item) return "";
  if (item.type === "MxMethod") {
    return ` method ${text(item.source)}@[${item.start},${item.end})`;
  }
  return ` ${code(item.source, item.start)}`;
}

function tag(node: Node): NTag {
  // An empty head part (`||`, `()`) is not projected: today's tree cannot
  // tell it from an absent one.
  const head = HEAD.filter(
    (key) => node[key] && node[key].source.trim() !== "",
  ).map((key) => `${key} ${code(node[key].source, node[key].start)}`);
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
        return `${sugarLine(item.sigil, JSON.stringify(item.value.value))}@${span}${item.operator ? ` ${item.operator}` : ""}${value(item.default)}${item.args ? ` args ${code(item.args.source, item.args.start)}` : ""}`;
      case "MxSpreadAttribute":
        return `spread ${span} ${code(item.value.source, item.value.start)}`;
      case "MxComment":
        return `comment ${item.kind} ${span}`;
      default: {
        const name =
          item.name === null ? "(default)" : JSON.stringify(item.name);
        const args = item.args
          ? ` args ${code(item.args.source, item.args.start)}`
          : "";
        // Rule A2 (decision 170): MX's own split fields, not a re-derived
        // slice of `name`.
        const modSpan =
          item.modifier === null || item.modifier === undefined
            ? ""
            : ` mod=${JSON.stringify(item.modifier)}@[${item.modifierSpan.start},${item.modifierSpan.end})`;
        return `attr ${name} ${span} name=[${item.nameSpan.start},${item.nameSpan.end})${modSpan}${item.operator ? ` ${item.operator}` : ""}${value(item.value)}${args}`;
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
