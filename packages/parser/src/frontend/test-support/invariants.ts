/**
 * The span invariant of the parser port's PR 2 (brief §1.2 B), checked over a
 * whole document: every span slices to the text the catalogue says it covers,
 * children are in source order, no child leaves its parent, siblings do not
 * overlap. Returns one line per violation; empty means the tree holds.
 */
import type { InterimDocument } from "../interim.ts";

// biome-ignore lint/suspicious/noExplicitAny: walks every node shape
type Node = any;

interface Span {
  start: number;
  end: number;
}

const CONTAINERS = new Set([
  "MxExpression",
  "MxStatements",
  "MxPattern",
  "MxArguments",
  "MxParameterList",
  "MxTypeArguments",
  "MxTypeParameters",
]);

export function checkInvariants(document: InterimDocument): string[] {
  const problems: string[] = [];
  const { source, base } = document;
  const text = (span: Span) =>
    source.slice(span.start - base.offset, span.end - base.offset);
  const fail = (path: string, message: string) =>
    problems.push(`${path}: ${message}`);

  const isSpan = (value: unknown): boolean =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Span).start === "number" &&
    typeof (value as Span).end === "number";

  const within = (path: string, inner: Span, outer: Span) => {
    if (inner.start < outer.start || inner.end > outer.end) {
      fail(
        path,
        `[${inner.start}, ${inner.end}) leaves its parent [${outer.start}, ${outer.end})`,
      );
    }
  };

  const ordered = (path: string, list: readonly Span[]) => {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1] as Span;
      const b = list[i] as Span;
      if (b.start < a.end) {
        fail(
          `${path}[${i}]`,
          `[${b.start}, ${b.end}) overlaps or precedes its sibling [${a.start}, ${a.end})`,
        );
      }
    }
  };

  const visit = (node: Node, path: string, parent: Span) => {
    if (!isSpan(node)) return;
    if (node.start > node.end)
      fail(path, `start ${node.start} > end ${node.end}`);
    if (node.type !== "MxParseError") within(path, node, parent);
    const slice = text(node);
    switch (node.type) {
      case "MxText":
        if (node.raw !== slice) fail(path, "raw is not the span's text");
        within(`${path}.valueSpan`, node.valueSpan, node);
        break;
      case "MxComment":
      case "MxCDATA":
      case "MxDoctype":
      case "MxDeclaration":
        if (node.value !== text(node.valueSpan)) {
          fail(path, "value is not the valueSpan's text");
        }
        within(`${path}.valueSpan`, node.valueSpan, node);
        break;
      case "MxAtom":
        if (slice[0] !== ":" || slice.slice(1) !== node.name) {
          fail(
            path,
            `atom span ${JSON.stringify(slice)} is not ":${node.name}"`,
          );
        }
        break;
      case "MxShorthand": {
        const sigil = slice[0];
        if (sigil !== node.sigil)
          fail(path, `starts with ${sigil}, not its sigil`);
        within(`${path}.value`, node.value.span, node);
        if (
          node.value.span.start !== node.start + 1 ||
          node.value.span.end !== node.end
        ) {
          fail(path, "value.span is not the token after its sigil");
        }
        if (
          node.value.kind === "static" &&
          node.value.value !== text(node.value.span)
        ) {
          fail(path, "static value is not its span's text");
        }
        break;
      }
      case "MxAttribute":
        if (node.name !== null && node.name !== text(node.nameSpan)) {
          fail(path, "name is not the nameSpan's text");
        }
        if (node.name === null && node.nameSpan.start !== node.nameSpan.end) {
          fail(path, "the default value's nameSpan is not zero-width");
        }
        within(`${path}.nameSpan`, node.nameSpan, node);
        break;
      case "MxMethod":
        if (node.source !== slice) fail(path, "source is not the span's text");
        break;
      case "MxModuleStatement":
        if (/\s$/.test(slice)) fail(path, "span is not right-trimmed");
        if (!slice.startsWith(node.keyword))
          fail(path, "does not start at its keyword");
        if (node.untrimmedEnd < node.end) fail(path, "untrimmedEnd before end");
        if (
          source
            .slice(node.end - base.offset, node.untrimmedEnd - base.offset)
            .trim() !== ""
        ) {
          fail(path, "untrimmedEnd adds more than whitespace");
        }
        break;
      case "MxTag":
      case "MxAttributeTag":
      case "MxReturn": {
        within(`${path}.openTag`, node.openTag, node);
        if (!node.concise && slice[0] !== "<")
          fail(path, "an HTML-mode tag does not start at <");
        if (node.openTag.start !== node.start)
          fail(path, "openTag does not start at the tag");
        if (node.closeTag) {
          within(`${path}.closeTag`, node.closeTag.span, node);
          if (!text(node.closeTag.span).startsWith("</"))
            fail(path, "closeTag is not at </");
          if (
            node.closeTag.nameSpan &&
            node.closeTag.name !== text(node.closeTag.nameSpan)
          ) {
            fail(path, "closeTag.name is not its span's text");
          }
        }
        if (node.type === "MxAttributeTag") {
          if (text(node.name.span) !== `@${node.name.value}`)
            fail(path, "name.span is not @name");
        } else if (node.name.kind === "static") {
          if (node.name.value !== text(node.name.span))
            fail(path, "name is not its span's text");
        } else if (node.name.kind === "unnamed") {
          if (node.name.span.start !== node.name.span.end)
            fail(path, "unnamed span not empty");
        }
        within(`${path}.name`, node.name.span, node);
        const head: Span[] = [];
        for (const key of ["typeArgs", "var", "args", "typeParams", "params"]) {
          if (node[key]) head.push(node[key].outer);
        }
        ordered(`${path}.shorthands`, node.shorthands);
        ordered(`${path}.attributes`, node.attributes);
        if (node.body) {
          ordered(`${path}.body`, node.body);
          const first = node.body[0];
          if (first && first.start < node.openTag.end) {
            fail(path, "first child starts inside the open tag");
          }
        }
        if (
          node.bodyMode === "void" &&
          (node.body !== null || node.closeTag !== null)
        ) {
          fail(path, "void tag with a body or close tag");
        }
        break;
      }
      default:
        if (CONTAINERS.has(node.type)) {
          if (node.source !== slice)
            fail(path, "source is not the span's text");
          within(`${path}.outer`, node, node.outer);
          ordered(`${path}.atoms`, node.atoms);
        }
    }
    for (const [key, value] of Object.entries(node)) {
      // A sugar's default has its own span after the token (ast §3.6).
      if (node.type === "MxShorthand" && key === "default") {
        if (value) visit(value, `${path}.default`, parent);
        continue;
      }
      if (
        key === "valueSpan" ||
        key === "openTag" ||
        key === "outer" ||
        key === "nameSpan"
      )
        continue;
      if (Array.isArray(value)) {
        value.forEach((child, i) => {
          if (isSpan(child)) visit(child, `${path}.${key}[${i}]`, node);
        });
      } else if (value && typeof value === "object") {
        if ("type" in value) visit(value, `${path}.${key}`, node);
        else if (key === "name" || key === "value") {
          // field shapes (MxTagName, MxShorthandValue) hold containers
          for (const [inner, held] of Object.entries(value as object)) {
            if (Array.isArray(held)) {
              held.forEach((child, i) => {
                if (child && typeof child === "object" && "type" in child) {
                  visit(child, `${path}.${key}.${inner}[${i}]`, node);
                }
              });
            } else if (held && typeof held === "object" && "type" in held) {
              visit(held, `${path}.${key}.${inner}`, node);
            }
          }
        }
      }
    }
  };

  const root = { start: document.start, end: document.end };
  if (document.end - document.start !== source.length) {
    fail("document", "span is not the source length");
  }
  ordered("body", document.body);
  document.body.forEach((child, i) => {
    visit(child, `body[${i}]`, root);
  });
  for (let i = 1; i < document.errors.length; i++) {
    const a = document.errors[i - 1];
    const b = document.errors[i];
    if (a && b && b.start < a.start && b.origin !== "template") {
      fail(`errors[${i}]`, "errors not ordered by start");
    }
  }
  return problems;
}

/** Every atom of every container in the document, in walk order. */
export function allAtoms(document: InterimDocument): Span[] {
  const found: Span[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (node.type === "MxAtom") {
      found.push({ start: node.start, end: node.end });
      return;
    }
    for (const field of Object.values(node)) walk(field);
  };
  walk(document.body);
  return found;
}
