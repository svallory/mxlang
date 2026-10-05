/**
 * Atom contracts (decision 156, ADR 156 section 4): the file-level half.
 *
 * A call's own shape (`type: "atom"` against a string, both ways) is checked
 * with the rest of its attributes in `custom-tags.ts`. What needs the whole
 * file lives here, in two phases that do not depend on source order:
 *
 * 1. **Declare.** Every call's `declares` entry, plus every `ctx.declare` an
 *    `analyze` hook made, becomes a declaration owned by a scope (a tag
 *    instance). Two of one name and kind in a scope clash.
 * 2. **Check.** Every atom of a contract attribute that states `values`,
 *    `pattern` or `ref` is checked; a `ref` resolves against every enclosing
 *    scope, innermost first. No tag "opens a context": a scope is an ancestor
 *    a declaration names, never a boundary a contract states.
 *
 * Single file only. A name `ref` cannot find in the file is an error; a
 * vocabulary that refers across files simply does not type that attribute
 * with `ref`.
 */

import { type Ctx, type Node, TranslateError } from "./core.ts";
import type {
  ContractDeclaration,
  CustomTag,
  CustomTagAttribute,
  TagCall,
} from "./custom-tags.ts";
import { nearestName } from "./did-you-mean.ts";
import type { Atom, Attr } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";

/** One custom tag call, with the authored tag instances around it. */
export interface ContractFact {
  definition: CustomTag;
  call: TagCall;
  /** Authored ancestors, outermost first, ending with the call's own node. */
  chain: Node[];
}

/** A name an `analyze` hook declared with `ctx.declare`. */
export interface DerivedDeclaration {
  kind: string;
  name: string;
  span: SourceSpan;
  scope?: string | string[];
}

interface Declaration {
  kind: string;
  name: string;
  span: SourceSpan;
  file?: string;
  uniqueWith: readonly string[];
}

/** Scope owner -> name -> declarations of that name (one per kind). */
type Scopes = Map<object, Map<string, Declaration[]>>;

/** The scope of a derived declaration no tag anchors. */
const FILE_SCOPE = {};

function asList<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

function nodeName(node: Node): string {
  return node?.name?.type === "StringLiteral" ? String(node.name.value) : "";
}

/** "`a`", "`a` or `b`", "`a`, `b` or `c`". */
function orList(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length < 2
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
}

export function positionAt(ctx: Ctx, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (const text of ctx.lines) {
    const lineEnd = lineStart + text.length;
    if (offset <= lineEnd) return { line, column: offset - lineStart };
    line++;
    lineStart = lineEnd + 1;
  }
  return {
    line: Math.max(1, ctx.lines.length),
    column: Math.max(0, offset - lineStart),
  };
}

function errorAt(
  ctx: Ctx,
  message: string,
  span: SourceSpan,
  file?: string,
  spans?: readonly SourceSpan[],
): TranslateError {
  const at = positionAt(ctx, span.sourceStart);
  const error = new TranslateError(message, at.line, at.column, file);
  if (spans) error.spans = spans;
  return error;
}

/** The name an attribute states as one atom or string, with where it was written. */
function statedName(
  attr: Attr | undefined,
): { name: string; span: SourceSpan } | null {
  if (!attr) return null;
  if (attr.kind === "static") {
    const span = attr.atom?.span ?? attr.valueSpan ?? attr.nameSpan;
    return { name: attr.atom?.name ?? attr.value, span };
  }
  if (attr.kind !== "dynamic") return null;
  const node = attr.value.node;
  if (node?.type !== "StringLiteral" || !attr.value.span) return null;
  const mark = node.extra?.mxAtom as { span: SourceSpan } | undefined;
  return { name: String(node.value), span: mark?.span ?? attr.value.span };
}

/** The atoms an attribute's value holds: a whole-value atom, or those inside its expression. */
function atomsOf(attr: Attr): readonly Atom[] {
  if (attr.kind === "static") return attr.atom ? [attr.atom] : [];
  if (attr.kind === "dynamic" || attr.kind === "bound") {
    return attr.value.atoms ?? [];
  }
  return [];
}

function pickEntry(
  declares: CustomTag["declares"],
  parent: string,
): ContractDeclaration | undefined {
  const entries = asList(declares);
  return (
    entries.find(
      (entry) =>
        entry.under !== undefined && asList(entry.under).includes(parent),
    ) ?? entries.find((entry) => entry.under === undefined)
  );
}

/** The tag instance that owns a declaration: the nearest ancestor named by `scope`, else the root. */
function scopeOwner(
  ctx: Ctx,
  chain: readonly Node[],
  scope: string | readonly string[] | undefined,
  declared: { kind: string; name: string; span: SourceSpan },
  file: string | undefined,
): object {
  if (scope === undefined) return chain[0] ?? FILE_SCOPE;
  const names = asList(scope);
  for (let i = chain.length - 2; i >= 0; i--) {
    if (names.includes(nodeName(chain[i]))) return chain[i] as object;
  }
  throw errorAt(
    ctx,
    `\`${declared.name}\` declares ${/^[aeiou]/.test(declared.kind) ? "an" : "a"} \`${declared.kind}\` scoped to ${orList(names)}, but has no such ancestor`,
    declared.span,
    file,
  );
}

function contains(outer: SourceSpan | undefined, inner: SourceSpan): boolean {
  return (
    outer !== undefined &&
    outer.sourceStart <= inner.sourceStart &&
    inner.sourceEnd <= outer.sourceEnd
  );
}

/** Phase 1: every declaration, in source order, into its scope. */
function declare(
  ctx: Ctx,
  facts: readonly ContractFact[],
  derived: readonly DerivedDeclaration[],
): Scopes {
  const pending: Array<{ owner: object; decl: Declaration }> = [];
  for (const { definition, call, chain } of facts) {
    if (!definition.declares) continue;
    const parent =
      chain.length > 1 ? nodeName(chain[chain.length - 2]) : "#root";
    const entry = pickEntry(definition.declares, parent);
    if (!entry) continue;
    const stated = statedName(
      call.attrs.find(
        (attr): attr is Exclude<Attr, { kind: "spread" }> =>
          attr.kind !== "spread" && attr.name === entry.from,
      ),
    );
    if (!stated) continue;
    const file = call.loc.file;
    const decl: Declaration = {
      kind: entry.kind,
      name: stated.name,
      span: stated.span,
      file,
      uniqueWith: entry.uniqueWith ?? [],
    };
    pending.push({
      owner: scopeOwner(ctx, chain, entry.scope, decl, file),
      decl,
    });
  }
  for (const item of derived) {
    // The tag that caused the derivation anchors the scope: the innermost
    // call whose span holds the declaration's span.
    let anchor: ContractFact | undefined;
    for (const fact of facts) {
      if (
        contains(fact.call.span, item.span) &&
        (!anchor ||
          (fact.call.span?.sourceStart ?? 0) >=
            (anchor.call.span?.sourceStart ?? 0))
      ) {
        anchor = fact;
      }
    }
    const decl: Declaration = {
      kind: item.kind,
      name: item.name,
      span: item.span,
      uniqueWith: [],
    };
    const owner = anchor
      ? scopeOwner(ctx, anchor.chain, item.scope, decl, anchor.call.loc.file)
      : item.scope === undefined
        ? FILE_SCOPE
        : scopeOwner(ctx, [], item.scope, decl, undefined);
    pending.push({ owner, decl });
  }
  pending.sort((a, b) => a.decl.span.sourceStart - b.decl.span.sourceStart);

  const scopes: Scopes = new Map();
  for (const { owner, decl } of pending) {
    const names = scopes.get(owner) ?? new Map<string, Declaration[]>();
    scopes.set(owner, names);
    const same = names.get(decl.name) ?? [];
    names.set(decl.name, same);
    const clash = same.find(
      (other) =>
        other.kind === decl.kind ||
        decl.uniqueWith.includes(other.kind) ||
        other.uniqueWith.includes(decl.kind),
    );
    if (clash) {
      const at = positionAt(ctx, clash.span.sourceStart);
      const label =
        clash.kind === decl.kind
          ? `\`${decl.kind}\``
          : `\`${decl.kind}\` (it clashes with the \`${clash.kind}\` of the same name)`;
      throw errorAt(
        ctx,
        `\`${decl.name}\` is already declared as ${label} at ${at.line}:${at.column + 1}`,
        decl.span,
        decl.file,
        [clash.span, decl.span],
      );
    }
    same.push(decl);
  }
  return scopes;
}

function checkAtom(
  ctx: Ctx,
  fact: ContractFact,
  scopes: Scopes,
  attrName: string,
  declaration: CustomTagAttribute,
  atom: Atom,
): void {
  const owner = `\`<${fact.call.name}>\`: attribute \`${attrName}\``;
  const file = fact.call.loc.file;
  const { values, pattern, ref } = declaration;
  if (values && !values.includes(atom.name)) {
    const near = nearestName(atom.name, values);
    throw errorAt(
      ctx,
      `${owner}: \`:${atom.name}\` is not one of ${values.map((v) => `:${v}`).join(", ")}${near ? `; did you mean \`:${near}\`?` : ""}`,
      atom.span,
      file,
    );
  }
  if (pattern !== undefined && !new RegExp(pattern).test(atom.name)) {
    throw errorAt(
      ctx,
      `${owner}: \`:${atom.name}\` does not match the pattern /${pattern}/`,
      atom.span,
      file,
    );
  }
  if (ref === undefined) return;
  const kinds = asList(ref);
  const visible = [...fact.chain].reverse();
  const candidates: string[] = [];
  for (const scope of visible) {
    const names = scopes.get(scope);
    if (!names) continue;
    for (const [name, decls] of names) {
      if (decls.some((decl) => kinds.includes(decl.kind)))
        candidates.push(name);
    }
  }
  if (candidates.includes(atom.name)) return;
  const near = nearestName(atom.name, candidates);
  const kindLabel = kinds.join(" or ");
  throw errorAt(
    ctx,
    `${owner}: \`:${atom.name}\` is not a declared ${kindLabel} here${near ? `; did you mean \`:${near}\`?` : ""}`,
    atom.span,
    file,
  );
}

/** Declare every name of the file, then check every atom reference against them. */
export function checkAtomContracts(ctx: Ctx): void {
  const facts = ctx.contractFacts ? [...ctx.contractFacts.values()] : [];
  const derived = ctx.contractDerived ?? [];
  if (facts.length === 0 && derived.length === 0) return;
  const scopes = declare(ctx, facts, derived);
  const refs: Array<() => void> = [];
  for (const fact of facts) {
    const attributes = fact.definition.attributes;
    if (!attributes) continue;
    for (const attr of fact.call.attrs) {
      if (attr.kind === "spread" || !Object.hasOwn(attributes, attr.name)) {
        continue;
      }
      const declaration = attributes[attr.name];
      if (declaration?.type !== "atom") continue;
      if (
        declaration.values === undefined &&
        declaration.pattern === undefined &&
        declaration.ref === undefined
      ) {
        continue;
      }
      for (const atom of atomsOf(attr)) {
        refs.push(() =>
          checkAtom(ctx, fact, scopes, attr.name, declaration, atom),
        );
      }
    }
  }
  for (const check of refs) check();
}
