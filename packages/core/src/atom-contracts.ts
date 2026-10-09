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

import { attrLabel } from "./attr-label.ts";
import {
  type ClaimedFields,
  claimedFields,
  claimsAtomFields,
} from "./contract-fields.ts";
import { type Ctx, type Node, TranslateError } from "./core.ts";
import type {
  ContractDeclaration,
  CustomTag,
  CustomTagAttribute,
  TagCall,
} from "./custom-tags.ts";
import { nearestName } from "./did-you-mean.ts";
import type { Atom, Attr, AttributeTag } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { hasStaticName, tagNameOf } from "./tag-fields.ts";
import { attributeTagDeclarationFor } from "./wildcard-children.ts";

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

/**
 * The file scope: the default owner of a declaration, and the outermost link of
 * every resolution chain (decision 156 addendum 7). Also where a derived
 * declaration no tag anchors lands.
 */
const FILE_SCOPE = {};

function asList<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

function nodeName(node: Node): string {
  return hasStaticName(node) ? String(tagNameOf(node)) : "";
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

/** The scope that owns a declaration: the nearest ancestor named by `scope`, else the file. */
function findScopeOwner(
  chain: readonly Node[],
  scope: string | readonly string[] | undefined,
): object | undefined {
  if (scope === undefined) return FILE_SCOPE;
  const names = asList(scope);
  for (let i = chain.length - 2; i >= 0; i--) {
    if (names.includes(nodeName(chain[i]))) return chain[i] as object;
  }
  return undefined;
}

/** `findScopeOwner`, or the positioned error; with no `ctx` (completion) a missing scope just drops the declaration. */
function scopeOwner(
  ctx: Ctx | null,
  chain: readonly Node[],
  scope: string | readonly string[] | undefined,
  declared: { kind: string; name: string; span: SourceSpan },
  file: string | undefined,
): object | undefined {
  const owner = findScopeOwner(chain, scope);
  if (owner || !ctx) return owner;
  throw errorAt(
    ctx,
    `\`${declared.name}\` declares ${/^[aeiou]/.test(declared.kind) ? "an" : "a"} \`${declared.kind}\` scoped to ${orList(asList(scope))}, but has no such ancestor`,
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
  ctx: Ctx | null,
  facts: readonly ContractFact[],
  derived: readonly DerivedDeclaration[],
): Scopes {
  // A syntax module that claims `declares` declares the names itself.
  if (ctx && claimedFields(ctx.syntaxModule).tag.has("declares")) {
    return new Map();
  }
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
    const owner = scopeOwner(ctx, chain, entry.scope, decl, file);
    if (owner) pending.push({ owner, decl });
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
    if (owner) pending.push({ owner, decl });
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
    if (clash && !ctx) continue;
    if (clash && ctx) {
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

/** Most candidates a diagnostic lists before it says `+N more`. */
const CANDIDATE_CAP = 10;

/** `:a, :b, :c`, sorted, at most ten, then ` +N more`. */
export function atomList(names: readonly string[]): string {
  const sorted = [...names].sort();
  const shown = sorted.slice(0, CANDIDATE_CAP).map((name) => `:${name}`);
  const rest = sorted.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}

/** What a contract accepts, for a type error: ` (one of :a, :b)` or ` (a declared kind)`; empty for a bare atom. */
export function atomExpectation(declaration: {
  values?: readonly string[];
  ref?: string | readonly string[];
}): string {
  // A syntax module that claims `values` or `ref` (`contractFields`) gets
  // them unchecked: quote them only in the shape core gives them.
  const { values, ref } = declaration;
  if (Array.isArray(values) && values.every((v) => typeof v === "string")) {
    return ` (one of ${atomList(values)})`;
  }
  if (
    typeof ref === "string" ||
    (Array.isArray(ref) && ref.every((kind) => typeof kind === "string"))
  ) {
    return ` (a declared ${asList(ref).join(" or ")})`;
  }
  return "";
}

/** One name an atom can take, with the kind of its declaration when it is a `ref`. */
export interface AtomCandidate {
  name: string;
  kind?: string;
}

declare const atomFactsBrand: unique symbol;

/**
 * What `compileSource` records of a unit for tooling: an opaque value, the
 * input of `atomCandidates`. It holds names, kinds, spans and scope data only,
 * never syntax nodes or contract hooks, so keeping a result does not keep its
 * AST. Build it with `compileSource`; its shape is not public.
 */
export interface AtomFacts {
  readonly [atomFactsBrand]: true;
}

/** What a contract says about the names an atom may take. */
interface AtomContract {
  values?: readonly string[];
  pattern?: string;
  ref?: readonly string[];
}

/** One place an atom is written (or can be) in a call: where the cursor counts, and what the contract allows. */
interface AtomSlot {
  /** Spans that must all hold the cursor: the attribute tags around the attribute. */
  within: SourceSpan[];
  /** Where the attribute writes its value. */
  ranges: SourceSpan[];
  /** `null` when the attribute is not an atom. */
  contract: AtomContract | null;
}

interface CallFacts {
  span?: SourceSpan;
  /** Scope ids of the authored ancestors, outermost first, ending with the call's own node. */
  chain: number[];
  slots: AtomSlot[];
}

interface FactsData extends AtomFacts {
  calls: CallFacts[];
  declarations: Array<{
    scope: number;
    kind: string;
    name: string;
    span: SourceSpan;
  }>;
}

/** The id of the file scope in `FactsData`. */
const FILE_SCOPE_ID = 0;

/**
 * The names of `kinds` visible from a call: its scope owners innermost
 * first, the file scope last, each name once (the first kind that declared it).
 */
export function visibleNames<K>(
  scopes: Map<K, Map<string, ReadonlyArray<{ kind: string }>>>,
  chain: readonly K[],
  fileScope: K,
  kinds: readonly string[],
): AtomCandidate[] {
  const seen = new Set<string>();
  const found: AtomCandidate[] = [];
  for (const scope of [...chain].reverse().concat(fileScope)) {
    const names = scopes.get(scope);
    if (!names) continue;
    for (const [name, decls] of names) {
      const decl = decls.find((d) => kinds.includes(d.kind));
      if (!decl || seen.has(name)) continue;
      seen.add(name);
      found.push({ name, kind: decl.kind });
    }
  }
  return found;
}

/**
 * The names a contract accepts, which diagnostics and completion share so a
 * list never offers a name the checker rejects: `values` and `ref` together
 * intersect, `pattern` filters, and a contract with neither `values` nor `ref`
 * (a bare atom, or `pattern` alone) has no list. `visible` is what `ref` can
 * see at the call.
 */
function acceptedNames(
  contract: AtomContract,
  visible: readonly AtomCandidate[],
): AtomCandidate[] {
  const { values, pattern, ref } = contract;
  let pool: readonly AtomCandidate[];
  if (ref !== undefined) {
    pool = values
      ? visible.filter((candidate) => values.includes(candidate.name))
      : visible;
  } else if (values) {
    pool = values.map((name) => ({ name }));
  } else {
    return [];
  }
  if (pattern === undefined) return [...pool];
  const matcher = new RegExp(pattern);
  return pool.filter((candidate) => matcher.test(candidate.name));
}

function contractOf(declaration: CustomTagAttribute): AtomContract {
  const { values, pattern, ref } = declaration;
  return {
    values,
    pattern,
    ref: ref === undefined ? undefined : asList(ref),
  };
}

/** The text of an attribute written as a plain string (not an atom, not an expression), else undefined. */
export function plainStringOf(attr: Attr): string | undefined {
  if (attr.kind === "static") return attr.atom ? undefined : attr.value;
  if (attr.kind !== "dynamic") return undefined;
  const node = attr.value.node;
  return node?.type === "StringLiteral" && !node.extra?.mxAtom
    ? String(node.value)
    : undefined;
}

function checkAtom(
  ctx: Ctx,
  fact: ContractFact,
  scopes: Scopes,
  label: string,
  attrName: string,
  declaration: CustomTagAttribute,
  atom: Atom,
): void {
  const owner = `${label}: attribute \`${attrName}\``;
  const file = fact.call.loc.file;
  const { values, pattern, ref } = declaration;
  if (values && !values.includes(atom.name)) {
    const near = nearestName(atom.name, values);
    throw errorAt(
      ctx,
      `${owner}: \`:${atom.name}\` is not one of ${atomList(values)}${near ? `; did you mean \`:${near}\`?` : ""}`,
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
  const visible = visibleNames(scopes, fact.chain, FILE_SCOPE, kinds);
  if (visible.some((candidate) => candidate.name === atom.name)) return;
  const candidates = acceptedNames(contractOf(declaration), visible).map(
    (candidate) => candidate.name,
  );
  const near = nearestName(atom.name, candidates);
  const kindLabel = kinds.join(" or ");
  const listed = candidates.length
    ? `one of ${atomList(candidates)}`
    : "none declared";
  throw errorAt(
    ctx,
    `${owner}: \`:${atom.name}\` is not a declared ${kindLabel} here (${listed})${near ? `; did you mean \`:${near}\`?` : ""}`,
    atom.span,
    file,
  );
}

/**
 * A plain string where a `ref` atom is expected: the type error, raised once
 * the file's declarations exist so it can list the names the author may mean.
 */
function checkStringForRef(
  ctx: Ctx,
  fact: ContractFact,
  scopes: Scopes,
  label: string,
  attr: Exclude<Attr, { kind: "spread" }>,
  declaration: CustomTagAttribute,
  text: string,
): void {
  const visible = visibleNames(
    scopes,
    fact.chain,
    FILE_SCOPE,
    asList(declaration.ref),
  );
  const names = acceptedNames(contractOf(declaration), visible).map(
    (candidate) => candidate.name,
  );
  const listed = names.length ? `one of ${atomList(names)}` : "none declared";
  const message = `${label}: attribute ${attrLabel(attr)} must be atom, got string (${listed}); write it as \`:${text}\``;
  const file = fact.call.loc.file;
  const span = valueRanges(attr)[0];
  throw span
    ? errorAt(ctx, message, span, file)
    : new TranslateError(message, attr.loc.line, attr.loc.column, file);
}

/** `declaration` without the keys the file's syntax module claims (`contractFields`). */
function unclaimed(
  declaration: CustomTagAttribute,
  claimed: ClaimedFields,
): CustomTagAttribute {
  if (claimed.attribute.size === 0) return declaration;
  const own = { ...declaration } as Record<string, unknown>;
  for (const key of claimed.attribute) delete own[key];
  return own as CustomTagAttribute;
}

/** Queues a check for every atom of every contract attribute in `attrs`. */
function queueAttrs(
  ctx: Ctx,
  fact: ContractFact,
  scopes: Scopes,
  refs: Array<() => void>,
  label: string,
  attributes: CustomTag["attributes"],
  attrs: readonly Attr[],
): void {
  if (!attributes) return;
  for (const attr of attrs) {
    if (attr.kind === "spread" || !Object.hasOwn(attributes, attr.name)) {
      continue;
    }
    const written = attributes[attr.name];
    if (written?.type !== "atom") continue;
    const declaration = unclaimed(written, claimedFields(ctx.syntaxModule));
    if (
      declaration.values === undefined &&
      declaration.pattern === undefined &&
      declaration.ref === undefined
    ) {
      continue;
    }
    const text =
      declaration.ref === undefined ? undefined : plainStringOf(attr);
    if (text !== undefined) {
      refs.push(() =>
        checkStringForRef(ctx, fact, scopes, label, attr, declaration, text),
      );
      continue;
    }
    for (const atom of atomsOf(attr)) {
      refs.push(() =>
        checkAtom(ctx, fact, scopes, label, attr.name, declaration, atom),
      );
    }
  }
}

/** The same, for every attribute tag at any depth, labelled `<box>`: `<@row>`: .... */
function queueAttributeTags(
  ctx: Ctx,
  fact: ContractFact,
  scopes: Scopes,
  refs: Array<() => void>,
  label: string,
  declared: CustomTag["attributeTags"],
  tags: readonly AttributeTag[],
): void {
  if (!declared) return;
  for (const tag of tags) {
    const declaration = attributeTagDeclarationFor(declared, tag.name);
    if (!declaration) continue;
    const nested = `${label}: \`<@${tag.name}>\``;
    queueAttrs(
      ctx,
      fact,
      scopes,
      refs,
      nested,
      declaration.attributes,
      tag.attrs,
    );
    queueAttributeTags(
      ctx,
      fact,
      scopes,
      refs,
      nested,
      declaration.attributeTags,
      tag.attributeTags,
    );
  }
}

/** Declare every name of the file, then check every atom reference against them. */
export function checkAtomContracts(ctx: Ctx): void {
  // From here the facts are complete: every call of the unit has been seen.
  // Completion facts are core's built-in path only (lead ruling 14:29): a
  // syntax module that takes over the atom fields has none.
  if (!claimsAtomFields(claimedFields(ctx.syntaxModule))) {
    ctx.atomFacts = atomFactsOf(ctx);
  }
  const facts = ctx.contractFacts ? [...ctx.contractFacts.values()] : [];
  const derived = ctx.contractDerived ?? [];
  if (facts.length === 0 && derived.length === 0) return;
  const scopes = declare(ctx, facts, derived);
  const refs: Array<() => void> = [];
  for (const fact of facts) {
    const label = `\`<${fact.call.name}>\``;
    queueAttrs(
      ctx,
      fact,
      scopes,
      refs,
      label,
      fact.definition.attributes,
      fact.call.attrs,
    );
    queueAttributeTags(
      ctx,
      fact,
      scopes,
      refs,
      label,
      fact.definition.attributeTags,
      fact.call.attributeTags,
    );
  }
  for (const check of refs) check();
}

/** The facts of a file with no custom tag call. */
export function emptyAtomFacts(): AtomFacts {
  // SAFETY: the empty facts carry only the two always-present arrays; every
  // reader treats a missing entry as absent.
  return { calls: [], declarations: [] } as unknown as AtomFacts;
}

/**
 * The compact facts of a unit, for tooling (`CompileResult.atomFacts`): the
 * declarations `declare(null, ...)` resolves, scope owners as ids, and for each
 * call where its atoms sit. No node, `CustomTag` or hook is kept.
 */
export function atomFactsOf(ctx: Ctx): AtomFacts {
  const facts = ctx.contractFacts ? [...ctx.contractFacts.values()] : [];
  const scopes = declare(null, facts, ctx.contractDerived ?? []);
  const ids = new Map<object, number>([[FILE_SCOPE, FILE_SCOPE_ID]]);
  const idOf = <T extends object>(owner: T): number => {
    let id = ids.get(owner);
    if (id === undefined) {
      id = ids.size;
      ids.set(owner, id);
    }
    return id;
  };
  const calls = facts.map(({ definition, call, chain }) => {
    const slots: AtomSlot[] = [];
    collectSlots(
      definition.attributes,
      call.attrs,
      definition.attributeTags,
      call.attributeTags,
      [],
      slots,
    );
    return { span: call.span, chain: chain.map(idOf), slots };
  });
  const declarations: FactsData["declarations"] = [];
  for (const [owner, names] of scopes) {
    for (const decls of names.values()) {
      for (const { kind, name, span } of decls) {
        declarations.push({ scope: idOf(owner), kind, name, span });
      }
    }
  }
  // SAFETY: the built facts always carry both arrays; the interface's optional
  // fields are for consumers reading partial results.
  return { calls, declarations } as unknown as AtomFacts;
}

function covers(span: SourceSpan | undefined, offset: number): boolean {
  return (
    span !== undefined && span.sourceStart <= offset && offset <= span.sourceEnd
  );
}

/** Where `attr` writes its value: a whole-value atom's span, the string, or the expression and its atoms. */
function valueRanges(attr: Attr): SourceSpan[] {
  if (attr.kind === "spread" || attr.kind === "boolean") return [];
  if (attr.kind === "static") {
    const span = attr.atom ? attr.atom.span : attr.valueSpan;
    return span ? [span] : [];
  }
  return [
    ...(attr.value.span ? [attr.value.span] : []),
    ...(attr.value.atoms ?? []).map((atom) => atom.span),
  ];
}

/**
 * Every attribute that can hold the cursor, attributes of a level before its
 * attribute tags, at any depth: the first slot to match a position is the
 * attribute under it.
 */
function collectSlots(
  attributes: CustomTag["attributes"],
  attrs: readonly Attr[],
  declared: CustomTag["attributeTags"],
  tags: readonly AttributeTag[],
  within: SourceSpan[],
  slots: AtomSlot[],
): void {
  for (const attr of attrs) {
    if (attr.kind === "spread" || !attributes) continue;
    if (!Object.hasOwn(attributes, attr.name)) continue;
    const ranges = valueRanges(attr);
    if (ranges.length === 0) continue;
    const declaration = attributes[attr.name];
    slots.push({
      within,
      ranges,
      contract: declaration?.type === "atom" ? contractOf(declaration) : null,
    });
  }
  if (!declared) return;
  for (const tag of tags) {
    const declaration = attributeTagDeclarationFor(declared, tag.name);
    if (!declaration || !tag.span) continue;
    collectSlots(
      declaration.attributes,
      tag.attrs,
      declaration.attributeTags,
      tag.attributeTags,
      [...within, tag.span],
      slots,
    );
  }
}

/**
 * The atoms that can be written at `offset` (UTF-16, into the file the facts
 * came from): what the contract accepts (`values`, or the names of its `ref`
 * kinds visible from the call, innermost scope first and the file last, each
 * once, with the kind as `kind`; `values` and `ref` together intersect, and
 * `pattern` filters), so a listed name is one the checker accepts. Empty with
 * no contract, a bare `type: "atom"`, `pattern` alone, or when `offset` is not
 * in an attribute value. Never throws.
 */
export function atomCandidates(
  atomFacts: AtomFacts,
  offset: number,
): AtomCandidate[] {
  const { calls, declarations } = atomFacts as FactsData;
  let target: CallFacts | undefined;
  for (const call of calls) {
    if (
      covers(call.span, offset) &&
      (!target ||
        (call.span?.sourceStart ?? 0) >= (target.span?.sourceStart ?? 0))
    ) {
      target = call;
    }
  }
  const slot = target?.slots.find(
    (candidate) =>
      candidate.within.every((span) => covers(span, offset)) &&
      candidate.ranges.some((span) => covers(span, offset)),
  );
  if (!target || !slot?.contract) return [];
  const contract = slot.contract;
  if (contract.ref === undefined) return acceptedNames(contract, []);
  const scopes = new Map<number, Map<string, Array<{ kind: string }>>>();
  for (const { scope, name, kind } of declarations) {
    const names =
      scopes.get(scope) ?? new Map<string, Array<{ kind: string }>>();
    scopes.set(scope, names);
    const same = names.get(name) ?? [];
    names.set(name, same);
    same.push({ kind });
  }
  return acceptedNames(
    contract,
    visibleNames(scopes, target.chain, FILE_SCOPE_ID, contract.ref),
  );
}
