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

import { attrLabel } from "./attr-label.ts";
import { positionAt } from "./contract-facts.ts";
import { claimedFields, contractData } from "./contract-fields.ts";
import { type Ctx, codedError, mxSpanOf, type Node, warn } from "./core.ts";
import type {
  CustomTagAttributeTag,
  CustomTagAttributeTags,
} from "./custom-tags.ts";
import {
  DIALECT_ERROR_CODE,
  DIALECT_HOOK_ERROR_CODE,
  DIALECT_WARNING_CODE,
  isReservedHookCode,
  reservedHookCodeMessage,
} from "./diagnostic-codes.ts";
import type { DialectNode } from "./dialect-registry.ts";
import type { Attr, AttributeTag, ExprNode } from "./ir.ts";
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
  /**
   * A machine-readable code, carried on the error as `diagnosticCode`, in
   * the dialect's own prefix: a code starting with `MX_` is MX's own and is
   * refused. Without it the error's code is `MX_DIALECT_ERROR`.
   */
  readonly code?: string;
  /** Further spans the error is about (a duplicate's first site), carried as `TranslateError.spans`. */
  readonly also?: readonly SourceSpan[];
}

/** Where `LoweredUnit.warn` reports and under which code (all optional). @unstable */
export interface LoweredUnitWarnOptions {
  /** Where the warning is, a span inside the document; file-level without it. */
  readonly at?: SourceSpan;
  /**
   * A machine-readable code for the warning, in the dialect's own prefix (a
   * code starting with `MX_` is refused). Without it the code is
   * `MX_DIALECT_WARNING`.
   */
  readonly code?: string;
}

/** A name an `analyze` hook declared with `ctx.declare(kind, name, { span, scope })`. @unstable */
export interface DeclaredName {
  readonly kind: string;
  readonly name: string;
  readonly span: SourceSpan;
  readonly scope?: string | readonly string[];
}

/**
 * A contract's declarations as plain data: `attributes`, `attributeTags`,
 * `children` and `defaultTag` as registered, plus the keys the file's dialect
 * claims (`contractFields.tag`) that the contract states. @unstable
 */
export interface ContractData {
  readonly attributes?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly attributeTags?: Readonly<Record<string, unknown>>;
  readonly children?: Readonly<Record<string, unknown>>;
  /**
   * What an unnamed tag (`<#id>`, `<.class>`) directly inside this tag stands
   * for, as the contract states it: absent when it states none, never a
   * built-in default such as `object`. It is the registered value: an invalid
   * one (a tag name that is not reachable) is kept as written, and lowering
   * ignores it.
   */
  readonly defaultTag?: string;
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
  /**
   * The dialect nodes written inside the expression, in source order
   * (`Expr.nodes`): each node's type, span, the node itself and its forward
   * (the expression its type's `lower` returned, which `node` holds in the
   * node's place). Absent when the expression has none.
   */
  readonly nodes?: readonly ExprNode[];
}

/**
 * An attribute's value in a contract view: a string, an expression, or the node written as the whole value when its type lowered it to
 * a string or a string literal (frozen, as its `parse` returned it; a claimed
 * `mx:String` also carries `raw`, `start` and `end`). A node whose type
 * lowered it to any other expression is that `mx:Expression`, with the node
 * in its `nodes`. Read `type` first; `type` does not narrow a dialect's node,
 * so check its key and cast.
 * @unstable
 */
export type ContractValue = ContractString | ContractExpression | DialectNode;

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
  /**
   * A warning, at `at` (a span inside the document) or file-level. The second
   * argument is the options, or the span alone.
   */
  warn(message: string, options?: LoweredUnitWarnOptions | SourceSpan): void;
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
    ...(attr.value.nodes?.length ? { nodes: attr.value.nodes } : {}),
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
  throw codedError(
    DIALECT_HOOK_ERROR_CODE,
    `the dialect's \`afterLower\`: ${what} is a \`{ sourceStart, sourceEnd }\` span inside the document (0 to ${ctx.source.length})`,
    0,
    0,
  );
}

/**
 * A hook's code as given, or `undefined` without one. A code starting with
 * `MX_` is MX's own: refused as a misuse of the hook.
 */
function hookCode(code: unknown, call: string): string | undefined {
  if (code === undefined) return undefined;
  const text = String(code);
  if (isReservedHookCode(text)) {
    throw codedError(
      DIALECT_HOOK_ERROR_CODE,
      `the dialect's \`afterLower\`: \`${call}\`'s ${reservedHookCodeMessage(text)}`,
      0,
      0,
    );
  }
  return text;
}

/** `unit.warn`'s second argument: the options, or the span alone. */
function warnOptionsOf(
  options: LoweredUnitWarnOptions | SourceSpan | undefined,
): LoweredUnitWarnOptions {
  if (options === undefined || options === null) return {};
  if (typeof options === "object" && "sourceStart" in options) {
    return { at: options };
  }
  return options as LoweredUnitWarnOptions;
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
        throw codedError(
          DIALECT_HOOK_ERROR_CODE,
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
      const code = hookCode(options?.code, "unit.fail");
      const position = at ? positionAt(ctx, at.sourceStart) : undefined;
      const error = codedError(
        DIALECT_ERROR_CODE,
        message,
        position?.line ?? 0,
        position?.column ?? 0,
      );
      if (at)
        error.span = { sourceStart: at.sourceStart, sourceEnd: at.sourceEnd };
      if (also) error.spans = Object.freeze([...also]);
      if (code !== undefined) error.diagnosticCode = code;
      throw error;
    },
    warn(message: string, options?: LoweredUnitWarnOptions | SourceSpan): void {
      const { at, code } = warnOptionsOf(options);
      if (at !== undefined && !inside(ctx, at)) {
        contractError(ctx, "`unit.warn`'s `at`");
      }
      const warningCode = hookCode(code, "unit.warn") ?? DIALECT_WARNING_CODE;
      const position = at ? positionAt(ctx, at.sourceStart) : undefined;
      warn(ctx, {
        message: String(message),
        line: position?.line ?? 0,
        column: position?.column ?? 0,
        code: warningCode,
      });
    },
  });
  units.set(ctx, unit);
  return unit;
}
