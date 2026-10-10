/**
 * `LoweredUnit`: what a dialect's `afterLower` is handed
 * (lang-ext-move-sugars-to-mesh slice a2, lead ruling Q2 A). A read-only
 * view of one lowered unit in generic terms: every custom tag call with its
 * contract and its attributes as written, the names `analyze` hooks declared
 * with `ctx.declare`, and the two ways to report. It names no syntax: a
 * module that gives contract keys a meaning (`contractFields`) checks them
 * here, from the public API only, so the module can live outside core.
 *
 * The view is built once per unit, when the first module hook runs, and is
 * frozen. Contract declarations (`ContractCall.contract`) are deep-frozen
 * copies of the registered plain data, so a module cannot change a contract
 * for the next compile; an expression's `node` is core's live node, to be
 * read, never written.
 */

import { positionAt } from "./atom-contracts.ts";
import { attrLabel } from "./attr-label.ts";
import { claimedFields, contractData } from "./contract-fields.ts";
import { type Ctx, mxSpanOf, type Node, TranslateError, warn } from "./core.ts";
import type {
  CustomTagAttributeTag,
  CustomTagAttributeTags,
} from "./custom-tags.ts";
import type { DialectNode } from "./dialect-registry.ts";
import type { Attr, AttributeTag } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { hasStaticName, tagNameOf } from "./tag-fields.ts";
import { attributeTagDeclarationFor } from "./wildcard-children.ts";

/** How `LoweredUnit.fail` raises its error (all optional). @unstable */
export interface LoweredUnitFailOptions {
  /**
   * Where the error is, a span inside the document. Without it the error is
   * file-level: no source position (line 0, column 0), as a registration
   * error is; `lowerSource` reports it at 1:0.
   */
  readonly at?: SourceSpan;
  /** A machine-readable code, carried on the error as `diagnosticCode`. */
  readonly code?: string;
  /** Further spans the error is about (a duplicate's first site), carried as `TranslateError.spans`. */
  readonly also?: readonly SourceSpan[];
}

/** A name an `analyze` hook declared with `ctx.declare(kind, name, { span, scope })`. @unstable */
export interface DeclaredName {
  readonly kind: string;
  readonly name: string;
  readonly span: SourceSpan;
  readonly scope?: string | readonly string[];
}

/**
 * A contract's declarations as plain data: `attributes`, `attributeTags` and
 * `children` as registered, plus the keys the file's dialect claims
 * (`contractFields.tag`) that the contract states. @unstable
 */
export interface ContractData {
  readonly attributes?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly attributeTags?: Readonly<Record<string, unknown>>;
  readonly children?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** What every written attribute carries. @unstable */
interface ContractAttrBase {
  readonly name: string;
  readonly nameSpan?: SourceSpan;
  /** How core's diagnostics name the attribute: `` `mode` ``, or `` `:email` (`name`) `` for one a sugar wrote. */
  readonly label: string;
  /** The token that wrote the attribute, when a sugar did (`:email`). */
  readonly authored?: string;
}

/** A string value: written as one, or claimed by a value row naming `mx:String`. @unstable */
export interface ContractString {
  readonly type: "mx:String";
  readonly value: string;
  /** The value as written: the string with its quotes. */
  readonly span?: SourceSpan;
}

/** An expression value, the node as lowered (marks included). @unstable */
export interface ContractExpression {
  readonly type: "mx:Expression";
  /**
   * The lowered expression node; `null` for one with no source. It is
   * core's live node, shared with the IR the host emits: read it, never
   * write it (it is not frozen).
   */
  readonly node: object | null;
  readonly code: string;
  readonly span?: SourceSpan;
  /** Written `name:=value`. */
  readonly bound?: true;
}

/**
 * Removal work, not part of the contract view: the leftover mark of a
 * whole-value atom or member the atom and member sugars wrote
 * (`ctx.attribute`'s `{ kind: "atom" | "member", name }`). It stays only
 * until the atoms-and-members dialect carries them as its own value
 * nodes; do not build on it. @unstable
 */
export interface ContractAtomOrMember {
  readonly type: "mx:Atom" | "mx:Member";
  readonly name: string;
  /** The atom or member token as written. */
  readonly span?: SourceSpan;
}

/**
 * An attribute's value in a contract view: a string, an expression, or the
 * node a value row claimed when its type lowered it to a string (frozen, as
 * its `parse` returned it; a claimed `mx:String` also carries `raw`,
 * `start` and `end`). A claimed node lowered to `ctx.expression` is the
 * value that expression makes, as if written there: `mx:Expression`, or
 * `mx:String` for a string literal (`mx:Atom` when it is atom-marked).
 * `ContractAtomOrMember` is removal work. Read `type`
 * first; `type` does not narrow a dialect's node, so check its key and cast.
 * @unstable
 */
export type ContractValue =
  | ContractString
  | ContractExpression
  | ContractAtomOrMember
  | DialectNode;

/**
 * One attribute of a call as written: its name and its value node, `null`
 * for a bare attribute (HTML's `true`); or a spread. @unstable
 */
export type ContractAttr =
  | (ContractAttrBase & { readonly value: ContractValue | null })
  | { readonly spread: true; readonly span?: SourceSpan };

/** An attribute tag of a call, at any depth, with the declaration it matched. @unstable */
export interface ContractAttributeTag {
  readonly name: string;
  readonly span?: SourceSpan;
  readonly nameSpan?: SourceSpan;
  readonly attrs: readonly ContractAttr[];
  readonly attributeTags: readonly ContractAttributeTag[];
  /** The declaration the parent's contract has for it (wildcards resolved); absent when it has none. */
  readonly contract?: ContractData;
}

/**
 * An authored tag around a call (or the call itself). `scope` is an opaque
 * identity for that tag instance: the same object wherever the instance
 * appears, so it keys a `Map` of what the instance owns. @unstable
 */
export interface ContractAncestor {
  /** The tag's name (`@row` for an attribute tag), `""` when it is dynamic. */
  readonly tag: string;
  readonly span?: SourceSpan;
  readonly scope: object;
}

/** One custom tag call with a declaration (a contract or a tag). @unstable */
export interface ContractCall {
  /** The canonical tag name (the contract's name for a wildcard match). */
  readonly tag: string;
  /** The whole call, body and closing tag included. */
  readonly span?: SourceSpan;
  readonly nameSpan?: SourceSpan;
  readonly contract: ContractData;
  readonly attrs: readonly ContractAttr[];
  readonly attributeTags: readonly ContractAttributeTag[];
  /** Authored ancestors, outermost first, ending with this call. */
  readonly ancestors: readonly ContractAncestor[];
}

/** One lowered unit, as a dialect's `afterLower` sees it. @unstable */
export interface LoweredUnit {
  /** The file being lowered. */
  readonly file: string;
  /** Its text; every span is a UTF-16 offset into it. */
  readonly source: string;
  /** Every custom tag call of the unit that has a declaration, in the order core lowered them. */
  readonly calls: readonly ContractCall[];
  /** What `analyze` hooks declared with `ctx.declare`, in call order. */
  readonly declared: readonly DeclaredName[];
  /** A positioned error in the module's own words; fatal, as core's own check is. */
  fail(message: string, options?: LoweredUnitFailOptions): never;
  /** A warning, at `at` (a span inside the document) or file-level. */
  warn(message: string, at?: SourceSpan): void;
}

/** One frozen identity per authored tag instance. */
const scopes = new WeakMap<object, object>();

function scopeOf(node: Node): object {
  let scope = scopes.get(node);
  if (!scope) {
    scope = Object.freeze({});
    scopes.set(node, scope);
  }
  return scope;
}

function freezeAll<T>(items: T[]): readonly T[] {
  return Object.freeze(items);
}

function attrOf(attr: Attr): ContractAttr {
  if (attr.kind === "spread") {
    return Object.freeze({ spread: true as const, span: attr.value.span });
  }
  const base = {
    name: attr.name,
    nameSpan: attr.nameSpan,
    label: attrLabel(attr),
    ...(attr.sugar !== undefined ? { authored: attr.sugar } : {}),
  };
  return Object.freeze({ ...base, value: contractValueOf(attr) });
}

/** The value node of a written attribute (`null` for a bare one). */
function contractValueOf(
  attr: Exclude<Attr, { kind: "spread" }>,
): ContractValue | null {
  if (attr.kind === "boolean") return null;
  if (attr.kind === "static") {
    if (attr.atom || attr.member) {
      const mark = (attr.atom ?? attr.member) as {
        name: string;
        span: SourceSpan;
      };
      return Object.freeze({
        type: attr.atom ? ("mx:Atom" as const) : ("mx:Member" as const),
        name: mark.name,
        span: mark.span,
      });
    }
    // The node a value row claimed, as parsed (frozen).
    if (attr.node) return attr.node;
    return Object.freeze({
      type: "mx:String" as const,
      value: attr.value,
      ...(attr.valueSpan ? { span: attr.valueSpan } : {}),
    });
  }
  return Object.freeze({
    type: "mx:Expression" as const,
    node: attr.value.node ?? null,
    code: attr.value.code,
    ...(attr.value.span ? { span: attr.value.span } : {}),
    ...(attr.kind === "bound" ? { bound: true as const } : {}),
  });
}

function attributeTagsOf(
  tags: readonly AttributeTag[],
  declared: CustomTagAttributeTags | undefined,
  tagFields: ReadonlySet<string>,
  memo: WeakMap<object, unknown>,
): readonly ContractAttributeTag[] {
  return freezeAll(
    tags.map((tag) => {
      const declaration: CustomTagAttributeTag | undefined =
        attributeTagDeclarationFor(declared, tag.name);
      return Object.freeze({
        name: tag.name,
        span: tag.span,
        nameSpan: tag.nameSpan,
        attrs: freezeAll(tag.attrs.map(attrOf)),
        attributeTags: attributeTagsOf(
          tag.attributeTags,
          declaration?.attributeTags,
          tagFields,
          memo,
        ),
        ...(declaration
          ? { contract: contractData(declaration, tagFields, memo) }
          : {}),
      });
    }),
  );
}

function ancestorOf(node: Node): ContractAncestor {
  const span = mxSpanOf(node);
  return Object.freeze({
    tag: hasStaticName(node) ? String(tagNameOf(node)) : "",
    ...(span ? { span } : {}),
    scope: scopeOf(node),
  });
}

/** Is `span` a `{ sourceStart, sourceEnd }` inside the document? */
function inside(ctx: Ctx, span: unknown): span is SourceSpan {
  const at = span as SourceSpan | null | undefined;
  return (
    !!at &&
    typeof at === "object" &&
    Number.isInteger(at.sourceStart) &&
    Number.isInteger(at.sourceEnd) &&
    at.sourceStart >= 0 &&
    at.sourceStart <= at.sourceEnd &&
    at.sourceEnd <= ctx.source.length
  );
}

/** A broken hook contract: a file-level error naming the call. */
function contractError(ctx: Ctx, what: string): never {
  throw new TranslateError(
    `the dialect's \`afterLower\`: ${what} is a \`{ sourceStart, sourceEnd }\` span inside the document (0 to ${ctx.source.length})`,
    0,
    0,
  );
}

const units = new WeakMap<Ctx, LoweredUnit>();

/** The unit's view, built once per `Ctx` (its lists on first read), frozen. */
export function loweredUnitOf(ctx: Ctx): LoweredUnit {
  const known = units.get(ctx);
  if (known) return known;
  let calls: readonly ContractCall[] | undefined;
  let declared: readonly DeclaredName[] | undefined;
  const unit: LoweredUnit = Object.freeze({
    file: ctx.filename,
    source: ctx.source,
    get calls(): readonly ContractCall[] {
      if (calls) return calls;
      const { tag: tagFields } = claimedFields(ctx.dialect);
      // One copy per registered object across the unit's calls.
      const memo = new WeakMap<object, unknown>();
      calls = freezeAll(
        [...(ctx.contractFacts?.values() ?? [])].map(
          ({ definition, call, chain }) =>
            Object.freeze({
              tag: call.name,
              span: call.span,
              nameSpan: call.nameSpan,
              contract: contractData(definition, tagFields, memo),
              attrs: freezeAll(call.attrs.map(attrOf)),
              attributeTags: attributeTagsOf(
                call.attributeTags,
                definition.attributeTags,
                tagFields,
                memo,
              ),
              ancestors: freezeAll(chain.map(ancestorOf)),
            }),
        ),
      );
      return calls;
    },
    get declared(): readonly DeclaredName[] {
      declared ??= freezeAll(
        (ctx.contractDerived ?? []).map(({ kind, name, span, scope }) =>
          Object.freeze({
            kind,
            name,
            span,
            ...(scope !== undefined
              ? {
                  scope: Array.isArray(scope)
                    ? Object.freeze([...scope])
                    : scope,
                }
              : {}),
          }),
        ),
      );
      return declared;
    },
    fail(message: string, options?: LoweredUnitFailOptions): never {
      if (typeof message !== "string" || message === "") {
        throw new TranslateError(
          "the dialect's `afterLower`: `unit.fail` takes a non-empty message",
          0,
          0,
        );
      }
      const at = options?.at;
      if (at !== undefined && !inside(ctx, at)) {
        contractError(ctx, "`unit.fail`'s `at`");
      }
      const also = options?.also;
      if (
        also !== undefined &&
        (!Array.isArray(also) || !also.every((span) => inside(ctx, span)))
      ) {
        contractError(ctx, "each of `unit.fail`'s `also`");
      }
      const position = at ? positionAt(ctx, at.sourceStart) : undefined;
      const error = new TranslateError(
        message,
        position?.line ?? 0,
        position?.column ?? 0,
      );
      if (also) error.spans = Object.freeze([...also]);
      if (options?.code !== undefined) {
        error.diagnosticCode = String(options.code);
      }
      throw error;
    },
    warn(message: string, at?: SourceSpan): void {
      if (at !== undefined && !inside(ctx, at)) {
        contractError(ctx, "`unit.warn`'s `at`");
      }
      const position = at ? positionAt(ctx, at.sourceStart) : undefined;
      warn(ctx, {
        message: String(message),
        line: position?.line ?? 0,
        column: position?.column ?? 0,
      });
    },
  });
  units.set(ctx, unit);
  return unit;
}
