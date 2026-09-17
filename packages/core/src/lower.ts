/**
 * The lowerer (decision 79): Marko's AST in, MX's host-independent IR out.
 *
 * This is the core's whole node walk, with every `out +=` removed. It does all
 * the validation the emitting walk used to do — dispositions and inert shapes,
 * the field guard, `checkBinding`, the four `<for>` forms, if-chain grouping,
 * attribute-tag collection, statement-tag hoisting — and produces `IrNode`s
 * instead of text. A host then emits from the IR and never sees a Marko node.
 *
 * Error messages and positions are preserved **byte for byte** from the
 * emitting walk: `packages/hosts/html`'s error fixtures and the oracle's error
 * class both assert them, and a reworded message is a behaviour change even
 * when the construct is still rejected.
 *
 * ## The two decision-70 hooks, as IR annotations
 *
 * `ctx.hoist(code)` and `ctx.bindings` still exist, and still run *here*
 * rather than at emit time: both are lower-time state. A hoisted statement
 * is recorded on the enclosing scope (the template's `prelude`, or the nearest
 * `Define`'s own), and a registered binding rewrites identifier *references*
 * as each expression is printed — so the `Expr.code` a host receives is
 * already rewritten and an emitter stays dumb. Shadowing is applied as the
 * walk enters and leaves each binding construct, exactly as before.
 */

import { freeIdentifiersIn } from "./accessor-reads.ts";
import { BUILTIN_CUSTOM_TAGS } from "./builtin-tags.ts";
import {
  attrByName,
  bindingIdentifiers,
  type Ctx,
  DYNAMIC_TAG,
  declName,
  expr,
  fail,
  hasContent,
  importBindings,
  type Node,
  newCtx,
  rejectInertShape,
  rejectUnsupportedFields,
  scopeBindings,
  shadowBindings,
  sliceLoc,
  VOID_TAGS,
} from "./core.ts";
import {
  type CustomTag,
  runAnalyzeHooks,
  runFinalizeHooks,
  shadowedBuiltinMessage,
  type TagCall,
  transformCustomTag,
} from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { exportNameFor } from "./export-name.ts";
import { parseFragment } from "./fragment.ts";
import type {
  Attr,
  AttributeTag,
  Block,
  Branch,
  ComponentTarget,
  Expr,
  ExprShape,
  ForSource,
  Ir,
  IrNode,
  Position,
} from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import {
  hasTemplate,
  metadataOfIr,
  registerAuthoredTemplateImport,
  registerTemplateMetadataCompiler,
  type TemplateTag,
} from "./template-tag.ts";

/** A node's start position, in `TranslateError`'s own 1-based/0-based shape. */
function posOf(node: Node): Position {
  const start = node?.loc?.start ?? node?.start ?? {};
  return { line: start.line ?? 0, column: start.column ?? 0 };
}

/** A node's end position, paired with `posOf` for source-backed code blocks. */
function endPosOf(node: Node): Position {
  const end = node?.loc?.end ?? node?.end ?? {};
  return { line: end.line ?? 0, column: end.column ?? 0 };
}

function offsetOf(ctx: Ctx, position: Position & { index?: number }): number {
  if (typeof position.index === "number") return position.index;
  let offset = 0;
  for (let line = 1; line < position.line; line++) {
    offset += (ctx.lines[line - 1]?.length ?? 0) + 1;
  }
  return Math.min(ctx.source.length, offset + position.column);
}

function nodeSpan(ctx: Ctx, node: Node): SourceSpan {
  const start = node?.loc?.start ?? node?.start ?? {};
  const end = node?.loc?.end ?? node?.end ?? start;
  return {
    sourceStart: offsetOf(ctx, start),
    sourceEnd: offsetOf(ctx, end),
  };
}

/**
 * `nodeSpan`, but `undefined` when `node` carries no `loc` — a synthesized
 * node with no real position. `nodeSpan`/`offsetOf` read `{line, column,
 * index?}`-shaped positions, never a bare number: a node with a numeric
 * `start`/`end` but no `loc` (e.g. `{type:"Id", start:7, end:10}`) is not
 * enough on its own — `offsetOf` would read `.column` off that raw number
 * and produce `NaN`, same as the no-position case this guards against. Only
 * `loc.start`/`loc.end` are ever position-shaped here, so `loc` alone is the
 * correct gate.
 *
 * Exported for `lower.test.ts` alone, to unit-test the guard directly
 * against every construction site that shares it (`Define.nameSpan`,
 * `paramSpansOf`), not only through `exprOf` — same rationale as `exprOf`'s
 * own export comment below.
 */
export function exprSpan(ctx: Ctx, node: Node): SourceSpan | undefined {
  if (!node?.loc) return undefined;
  return nodeSpan(ctx, node);
}

function attrNameSpan(ctx: Ctx, attr: Node): SourceSpan {
  const sourceStart = offsetOf(ctx, attr?.loc?.start ?? attr?.start ?? {});
  const sourceName = attr.modifier
    ? `${attr.name}:${attr.modifier}`
    : String(attr.name ?? "");
  return { sourceStart, sourceEnd: sourceStart + sourceName.length };
}

/** Classifies an expression once, while its parsed node is still available. */
export function expressionShape(node: Node): ExprShape {
  switch (node?.type) {
    case "ObjectExpression":
      return "object";
    case "ArrayExpression":
      return "array";
    case "StringLiteral":
    case "TemplateLiteral":
      return "string";
    default:
      return "other";
  }
}

/**
 * An expression, printed and classified through the binding registry.
 *
 * Exported for `lower.test.ts` alone, to unit-test `span`'s guard directly
 * against a loc-less node — no construction site in this file currently
 * hands `exprOf` one (both of `custom-tags.ts`'s synthesized/fabricated
 * `Expr`s build the object literal directly, bypassing this function), but
 * the guard exists precisely so a future one cannot regress into a `NaN`
 * span.
 */
export function exprOf(ctx: Ctx, node: Node): Expr {
  if (node?.type === "MarkoParseError") {
    fail(node.label ?? "invalid expression", {
      loc: { start: node.errorLoc?.start ?? node.loc?.start },
    });
  }
  const code = expr(ctx, node);
  checkTagVarReads(ctx, code, node);
  return {
    code,
    shape: expressionShape(node),
    node,
    span: exprSpan(ctx, node),
  };
}

/**
 * Rejects a `/var` read the emitted JS could not honour (design §3.4, C5).
 *
 * Two shapes, both of which JavaScript would let through as `undefined` or a
 * run-time TDZ rather than a diagnostic:
 *
 * - a read **before** the call that declares it, in the same block. Marko
 *   makes this a compile error by comparing sibling indices
 *   (`references.ts:597-602`); the equivalent here is the `pending` flag a
 *   block sets on its own `/var` names before walking and clears when the
 *   walk reaches each declaring call.
 * - a read **outside** the declaring block. Marko hoists the binding into a
 *   getter instead (`hoist-custom-tag-var/`), which changes its
 *   user-visible type; MX rejects the escape and keeps `/var` an ordinary
 *   `let` in the call site's own scope (invariant §7.5-8).
 *
 * The expression is **parsed**, not pattern-matched. A regex over the printed
 * text was measured wrong in both directions on real templates: `${"the
 * letter n"}` matched a string literal's contents and rejected a valid
 * program, and `<for|n|>` matched the loop's own parameter, which shadows the
 * `/var` and has nothing to do with it. `freeIdentifiersIn` reports only
 * genuine free references, and `Ctx.tagVarShadowed` carries the names an
 * enclosing tag's params bind — the shadowing a single expression's own scope
 * cannot see.
 *
 * The walk runs only when a `/var` is in scope at all, which is never for a
 * file that does not use one.
 */
function checkTagVarReads(ctx: Ctx, code: string, node: Node): void {
  const declared = ctx.tagVars;
  if (!declared?.size) return;
  const here = ctx.tagVarBlock ?? [];

  const read = freeIdentifiersIn(code);
  if (read.size === 0) return;

  for (const [name, binding] of declared) {
    if (!read.has(name)) continue;
    // A tag param of the same spelling is a different variable.
    if (ctx.tagVarShadowed?.has(name)) continue;
    // In scope exactly when the declaring block is this block or an ancestor
    // of it — a prefix of the path. A sibling block shares the declaring
    // block's *depth* but not its path, which is the case a depth counter
    // cannot tell apart.
    const inScope =
      binding.block.length <= here.length &&
      binding.block.every((id, index) => here[index] === id);
    if (!inScope) {
      fail(
        `\`${name}\` is a \`/var\` bound inside a nested block and is not in scope here; a \`/var\` binds in the call site's own scope only`,
        node,
      );
    }
    // Still pending: the walk has not reached the declaring call yet, so
    // this read is earlier in the block than the binding.
    if (binding.pending) {
      fail(
        `\`${name}\` is read before the \`/var\` that binds it; move the read after the call that declares it`,
        node,
      );
    }
  }
}

/**
 * Where hoisted statements accumulate for the function currently being
 * resolved.
 *
 * `ctx.prelude` is swapped as the walk enters and leaves a `<define>`, so a
 * `ctx.hoist` from inside one lands on that define's own head rather than the
 * render function's — the same function-boundary rule the lowerer applies to
 * the template body.
 */
function withPrelude<T>(ctx: Ctx, run: () => T): [T, Ctx["prelude"]] {
  const outer = ctx.prelude;
  ctx.prelude = [];
  const result = run();
  const prelude = ctx.prelude;
  ctx.prelude = outer;
  return [result, prelude];
}

/** Resolves one attribute of an element or component call. */
function lowerAttr(
  ctx: Ctx,
  attr: Node,
  on: "element" | "component" = "element",
): Attr {
  const loc = posOf(attr);
  const nameSpan = attrNameSpan(ctx, attr);

  if (attr.type === "MarkoSpreadAttribute") {
    return { kind: "spread", value: exprOf(ctx, attr.value), loc };
  }

  if (attr.arguments || attr.value?.type === "FunctionExpression") {
    if (ctx.declarations.resolveAttributeMethod?.(attr, on) !== true) {
      ctx.declarations.rejectAttributeMethod?.(attr, on);
      fail(
        `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; standalone MX renders once to a string`,
        attr,
      );
    }
  }

  if (attr.bound) {
    return {
      kind: "bound",
      name: attr.name,
      nameSpan,
      value: exprOf(ctx, attr.value),
      loc,
    };
  }

  // `class:foo="x"` is a modifier Marko hands over as a base name plus a
  // modifier. Emitting only the base name renders `class="x"` — not a drop but
  // a *wrong* attribute, which is worse. The host gets first refusal so the
  // diagnostic is in its own vocabulary (a Marko-parity target quotes Marko's
  // own fix-it); the core's wording is only the fallback.
  if (attr.modifier) {
    const resolvedName = ctx.declarations.resolveModifier?.(attr, on);
    if (resolvedName !== undefined) {
      return {
        kind: "dynamic",
        name: resolvedName,
        nameSpan,
        value: exprOf(ctx, attr.value),
        loc,
      };
    }
    // The tag kind travels with the rejection: a modifier on a *component*
    // call is a different diagnostic from one on an element, and the pre-IR
    // walk said so ("… on a component call is not supported"). Losing that
    // distinction was a message regression even though both still fail.
    ctx.declarations.rejectModifier?.(attr, on);
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in a standalone template`,
      attr,
    );
  }

  const value = attr.value;
  // A bare attribute (`download`, `checked`) is HTML's spelling of `true`.
  if (value?.type === "BooleanLiteral" && value.value === true) {
    return { kind: "boolean", name: attr.name, nameSpan, loc };
  }
  if (value?.type === "StringLiteral") {
    return {
      kind: "static",
      name: attr.name,
      value: value.value,
      nameSpan,
      loc,
    };
  }
  return {
    kind: "dynamic",
    name: attr.name,
    value: exprOf(ctx, value),
    nameSpan,
    loc,
  };
}

function lowerAttrs(
  ctx: Ctx,
  node: Node,
  name: string,
  on: "element" | "component" = "element",
): Attr[] {
  const attrs = (node.attributes ?? []).map((attr: Node) =>
    lowerAttr(ctx, attr, on),
  );
  return ctx.declarations.orderAttrs?.(name, attrs, on, ctx) ?? attrs;
}

/** The tag params of `<for|a, b|>` / `<@name|p|>`, as source text. */
function paramsOf(ctx: Ctx, node: Node): string[] {
  return (node.body?.params ?? []).map((p: Node) => {
    // Babel's generator omits a TypeScript annotation when an Identifier is
    // printed outside its parameter-list context. The Marko node's location
    // covers the complete authored pattern, so use that exact source text for
    // params and preserve annotations as well as destructuring.
    const source = p.loc ? sliceLoc(ctx, p.loc) : "";
    return source || declName(ctx, p);
  });
}

/**
 * File-absolute byte spans of `<for|a, b|>` / `<define|p|>` params, one per
 * `paramsOf`/`paramNodes` entry — same convention as `Expr.span`, `undefined`
 * for a param whose node carries no `loc`.
 *
 * Exported for `lower.test.ts` alone, to unit-test the no-`loc` guard
 * directly against a synthesized param node — same rationale as `exprOf`'s
 * own export comment above.
 */
export function paramSpansOf(
  ctx: Ctx,
  node: Node,
): Array<SourceSpan | undefined> {
  return (node.body?.params ?? []).map((p: Node) => exprSpan(ctx, p));
}

/** Marko keeps non-empty params as nodes but represents both absent and `||` as `[]`. */
function hasParams(ctx: Ctx, node: Node): boolean {
  if ((node.body?.params ?? []).length > 0) return true;
  const source = sliceLoc(ctx, node.loc);
  const openEnd = source.indexOf(">");
  return (openEnd < 0 ? source : source.slice(0, openEnd)).includes("||");
}

/** Every name a tag's params bind, for shadowing. */
function paramBindings(node: Node): string[] {
  return (node.body?.params ?? []).flatMap((p: Node) => bindingIdentifiers(p));
}

/**
 * A child list lowered as a callable block, with its params shadowing.
 *
 * A block's params are in scope for its own body only: inside
 * `<@footer|year|>`, `year` is the parameter, not any host binding of the same
 * name. Restored on the way out.
 */
function lowerBlock(ctx: Ctx, node: Node): Block {
  // A block is its own JS scope: both the params it shadows *and* anything a
  // `<const>` inside it unregisters are confined to it.
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(node));
  const children = lowerChildren(ctx, node.body?.body ?? []);
  restore();
  unscope();
  return {
    hasParams: hasParams(ctx, node),
    params: paramsOf(ctx, node),
    children,
    loc: posOf(node),
  };
}

/** `<@name>` children of a component call, in source order. */
function lowerAttributeTags(ctx: Ctx, node: Node): AttributeTag[] {
  const tags: AttributeTag[] = [];
  for (const block of node.attributeTags ?? []) {
    if (block.type !== "MarkoTag") continue;
    tags.push({
      name: String(block.name.value).replace(/^@/, ""),
      nameSpan: (() => {
        const span = nodeSpan(ctx, block.name);
        return { sourceStart: span.sourceStart + 1, sourceEnd: span.sourceEnd };
      })(),
      block: lowerBlock(ctx, block),
      loc: posOf(block),
    });
  }
  return tags;
}

/** Validates the generic attribute-tag shape shared by components and tags. */
function validateAttributeTagShape(node: Node): void {
  const parentAttrs = new Set(
    (node.attributes ?? [])
      .filter((attr: Node) => attr.type !== "MarkoSpreadAttribute")
      .map((attr: Node) => attr.name),
  );
  for (const tag of node.attributeTags ?? []) {
    const name = String(tag.name?.value ?? "").replace(/^@/, "");
    if (parentAttrs.has(name)) {
      fail(
        `attribute tag \`@${name}\` collides with attribute \`${name}\``,
        tag,
      );
    }
    if (name === "children" && hasContent(node.body?.body ?? [])) {
      fail(
        "attribute tag `@children` collides with the parent's ordinary children",
        tag,
      );
    }
    if ((tag.attributes ?? []).length > 0) {
      fail("attribute tags take params or a body, not attributes (v1)", tag);
    }
    if ((tag.attributeTags ?? []).length > 0) {
      const inner = tag.attributeTags[0];
      const innerName = String(inner.name?.value ?? "");
      fail(
        `attribute tag \`<${innerName}>\` inside attribute tag \`<@${name}>\``,
        inner,
      );
    }
  }
}

/**
 * `<if>` plus any `<else if>`/`<else>` siblings, grouped into one node.
 *
 * Returns the index of the first sibling it did not consume, so the caller
 * resumes after the whole chain rather than re-reading `<else>` as a tag.
 */
function lowerIfChain(
  ctx: Ctx,
  children: Node[],
  index: number,
): [IrNode, number] {
  const node = children[index];
  rejectUnsupportedFields(ctx, node, "`<if>`");
  const cond = attrByName(node, "value") ?? node.attributes?.[0];
  if (!cond?.value) fail("`<if>` without a condition", node);

  // Each branch is its own JS block: a `<const>` declared inside one does not
  // shadow the host's binding for the code that follows the chain.
  const branchChildren = (branchNode: Node): IrNode[] => {
    const unscope = scopeBindings(ctx);
    const children = lowerChildren(ctx, branchNode.body?.body ?? []);
    unscope();
    return children;
  };

  const branches: Branch[] = [
    {
      condition: exprOf(ctx, cond.value),
      children: branchChildren(node),
      loc: posOf(node),
    },
  ];

  let i = index + 1;
  while (i < children.length) {
    const child = children[i];
    // Whitespace and comments between branches are layout, not content.
    if (child.type === "MarkoComment") {
      i++;
      continue;
    }
    if (child.type === "MarkoText" && child.value.trim() === "") {
      i++;
      continue;
    }
    const childName = child.name?.value;
    if (
      child.type !== "MarkoTag" ||
      (childName !== "else" && childName !== "else-if")
    ) {
      break;
    }

    rejectUnsupportedFields(ctx, child, `\`<${childName}>\``);
    // `<else if=cond>` spells the condition as an `if` attribute; Marko's own
    // `<else-if=cond>` spells it as the tag's first (value) attribute.
    const ifAttr =
      childName === "else-if"
        ? (attrByName(child, "value") ?? child.attributes?.[0])
        : attrByName(child, "if");
    branches.push({
      condition: ifAttr ? exprOf(ctx, ifAttr.value) : null,
      children: branchChildren(child),
      loc: posOf(child),
    });
    i++;
    if (!ifAttr) break;
  }

  return [{ kind: "IfChain", branches, loc: posOf(node) }, i];
}

/**
 * All of `<for>`'s forms, normalized to the three a host emits.
 *
 * `by=` names which item a DOM node belongs to across re-renders. A one-shot
 * string host has no reconciliation, so it safely ignores the field (decision
 * 65). A reactive host (Solid) emits it as the `keyed` prop on `<For>`.
 * Carried in the IR so both paths work from the same tree.
 */
function lowerFor(ctx: Ctx, node: Node): IrNode {
  rejectUnsupportedFields(ctx, node, "`<for>`", { params: true });

  const params = paramsOf(ctx, node);
  // A `<for>` with no params names no loop variable. Defaulting it to `item`
  // would bind the body to a name the author never wrote — resolving to an
  // outer-scope `item` if one exists, or failing at render time instead of
  // compile time.
  if (params.length === 0) {
    fail("`<for>` needs tag params: `<for|item| of=…>`", node);
  }

  // The iterable is evaluated *outside* the loop, so a registered name there is
  // still the host's binding; only the body is shadowed by the params.
  const of = attrByName(node, "of");
  const inAttr = attrByName(node, "in");
  const to = attrByName(node, "to");
  const until = attrByName(node, "until");
  const step = attrByName(node, "step");
  const by = attrByName(node, "by");

  const combos = [of, inAttr, attrByName(node, "from") || to || until].filter(
    Boolean,
  ).length;
  if (combos > 1) {
    fail(
      "`<for>` with more than one of `of=`, `in=`, `from=`/`to=`/`until=`",
      node,
    );
  }
  if (to && until) fail("`<for>` with both `to=` and `until=`", node);
  if (step && !(to || until)) {
    fail("`<for step=...>` is only valid on a range", step);
  }

  const requireValue = (attr: Node | undefined, label: string): void => {
    if (
      attr &&
      (!attr.value?.loc ||
        attr.arguments ||
        attr.value.type === "FunctionExpression")
    ) {
      fail(`\`<for ${label}=...>\` requires an expression value`, attr);
    }
  };
  requireValue(of, "of");
  requireValue(inAttr, "in");
  requireValue(attrByName(node, "from"), "from");
  requireValue(to, "to");
  requireValue(until, "until");
  requireValue(step, "step");
  requireValue(by, "by");

  let source: ForSource;
  if (of) {
    source = { kind: "of", list: exprOf(ctx, of.value) };
  } else if (inAttr) {
    source = { kind: "in", object: exprOf(ctx, inAttr.value) };
  } else if (to || until) {
    const from = attrByName(node, "from");
    source = {
      kind: "range",
      from: from ? exprOf(ctx, from.value) : null,
      bound: exprOf(ctx, (to ?? until).value),
      inclusive: Boolean(to),
      step: step ? exprOf(ctx, step.value) : null,
    };
  } else {
    fail("`<for>` requires `of=`, `in=`, or `from=`/`to=`/`until=`", node);
  }

  const bindings = paramBindings(node);
  // The loop body is a JS block, so a `<const>` inside it is confined to it.
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, bindings);
  const children = lowerChildren(ctx, node.body?.body ?? []);
  restore();
  unscope();

  return {
    kind: "For",
    source,
    params,
    paramNodes: [...(node.body?.params ?? [])],
    bindings,
    paramSpans: paramSpansOf(ctx, node),
    key: by ? exprOf(ctx, by.value) : null,
    children,
    loc: posOf(node),
  };
}

/** `<const/name=expr/>` — a binding at render scope. */
function lowerConst(ctx: Ctx, node: Node): IrNode {
  if (!node.var) {
    fail(
      "`<const>` without a variable name (write `<const/name=value/>`)",
      node,
    );
  }
  rejectUnsupportedFields(ctx, node, "`<const>`", { var: true });
  // Dispatched by the core, before any host sees the tag, so the binding check
  // has to happen here or a host's rule would silently apply to `<let>` and not
  // to `<const>`.
  ctx.declarations.checkBinding?.(node.var, "`<const>`");
  const value = attrByName(node, "value") ?? node.attributes?.[0];
  if (!value?.value) fail("`<const>` without a value", node);

  const name = declName(ctx, node.var);
  // The initializer is evaluated *before* the binding exists, so a registered
  // name on the right-hand side is still the host's: `<const/count=count + 1>`
  // resolves to `const count = count() + 1`. Shadowing takes effect only
  // afterwards, for the rest of the render scope.
  const init = exprOf(ctx, value.value);
  shadowBindings(ctx, bindingIdentifiers(node.var));

  return { kind: "Const", name, init, loc: posOf(node) };
}

/** `<define/name|params|>...</define>` — a reusable block. */
function lowerDefine(ctx: Ctx, node: Node): IrNode {
  if (!node.var) {
    fail("`<define>` without a name (write `<define/name>`)", node);
  }
  rejectUnsupportedFields(ctx, node, "`<define>`", { var: true, params: true });

  const name = declName(ctx, node.var);
  const params = paramsOf(ctx, node);

  // The params shadow the host's bindings inside the body only, and a
  // statement hoisted from inside belongs to *this* function's head — it may
  // read the define's own params.
  const restore = shadowBindings(ctx, paramBindings(node));
  const [children, prelude] = withPrelude(ctx, () =>
    lowerChildren(ctx, node.body?.body ?? []),
  );
  restore();

  ctx.defines.set(name, params);

  const loc = posOf(node);
  const hoisted: IrNode[] = prelude.map(({ code, node }) => ({
    kind: "Hoisted" as const,
    code,
    loc: posOf(node),
    end: endPosOf(node),
  }));
  return {
    kind: "Define",
    name,
    nameSpan: exprSpan(ctx, node.var),
    params,
    paramSpans: paramSpansOf(ctx, node),
    children: [...hoisted, ...children],
    loc,
  };
}

/**
 * Statement tags, recovered from source and hoisted to module scope.
 *
 * `import` reaches module scope verbatim; `static` drops its keyword; `export
 * interface Input` is lifted so a host can place it above the render function;
 * any other `export` hoists verbatim as a real module export.
 */
function lowerStatement(ctx: Ctx, node: Node, name: string): IrNode {
  const line = sliceLoc(ctx, node.loc).trim();
  const loc = posOf(node);
  const end = endPosOf(node);

  if (name === "import") {
    const bindings = importBindings(line);
    // Recorded *now*, not in `lower`'s post-pass: a component call later in
    // the body asks `isComponent`, which consults `ctx.imports`, so a binding
    // registered only after the whole body resolved would make every
    // imported component an unbound capitalized tag.
    for (const binding of bindings) ctx.imports.add(binding);
    registerAuthoredTemplateImport(ctx, line);
    return { kind: "Import", code: line, bindings, loc, end };
  }
  if (name === "static") {
    return {
      kind: "Static",
      code: line.replace(/^static\s+/, ""),
      loc,
      end,
    };
  }
  if (/^export\s+interface\s+Input\b/.test(line)) {
    return { kind: "InputInterface", code: line, loc, end };
  }
  if (name === "export") {
    return { kind: "Export", code: line, loc, end };
  }
  fail(
    `unrecognized statement tag \`${name}\`; expected \`import\`, \`static\`, or \`export\``,
    node,
  );
}

/** A tag this host claims, with every part lowered for its emitter. */
function lowerHostTag(ctx: Ctx, node: Node, name: string): IrNode {
  const loc = posOf(node);
  const unscope = scopeBindings(ctx);
  const restore = shadowBindings(ctx, paramBindings(node));
  const children = lowerChildren(ctx, node.body?.body ?? []);
  restore();
  unscope();

  return {
    kind: "HostTag",
    tag: {
      name,
      attrs: lowerAttrs(ctx, node, name),
      children,
      attributeTags: lowerAttributeTags(ctx, node),
      params: paramsOf(ctx, node),
      var: node.var ? declName(ctx, node.var) : null,
      data: ctx.declarations.resolveHostTag?.(name, node, ctx),
      loc,
    },
    loc,
  };
}

/**
 * Lowers one registered custom tag call and splices its ordinary IR roots.
 *
 * `content` is gated on `hasContent` for an ordinary (user-registered) tag:
 * whitespace-only body text means "no children supplied", which is the right
 * default for a template-authored tag deciding what an empty call means. A
 * core-owned built-in like `<try>` is a structural pass-through wrapper, not
 * a template — its whole job is to reproduce the caller's body unchanged, the
 * way `lowerHostTag` always did (`lowerChildren(node.body?.body ?? [])`,
 * unconditionally). Gating it the same way silently dropped whitespace-only
 * bodies (`<try>  </try>`) that used to render. `isBuiltin` therefore skips
 * the gate and always lowers the raw block.
 */
/**
 * `<return value=EXPR/>` — the unit's value channel (design §3.3).
 *
 * Validated entirely in the tag's *own* compilation, which is what makes the
 * `{ value, output }` signature well-typed: a unit cannot see its callers, so
 * "at most one, unconditional" is decided once, here, rather than resolved
 * from the set of all call sites (invariant §7.5-5). The grammar is Marko's,
 * ported from `translator/core/return.ts` with MX wording; the one deliberate
 * subtraction is `valueChange`, which MX 1 does not ship (value only), so it
 * is rejected by name like any other unknown attribute.
 *
 * `nested` is the whole unconditionality check. Reaching this function from
 * anywhere but the file's own top-level body — inside a native tag, under
 * `<if>`/`<for>`, inside an attribute tag or a `<define>` — means the return
 * would be conditional or scoped, so it is refused there rather than lowered.
 */
function lowerReturn(ctx: Ctx, node: Node, nested: boolean): IrNode {
  rejectUnsupportedFields(ctx, node, "`<return>`");

  if (node.body?.body?.length) {
    fail("`<return>` does not support body content", node);
  }

  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      fail("`<return>` does not support spread attributes", attr);
    }
  }

  let valueAttr: Node | undefined;
  for (const attr of node.attributes ?? []) {
    if (attr.type !== "MarkoAttribute") continue;
    // The parser spells `<return=x/>` as the `default` attribute and
    // `<return value=x/>` as `value`; both are the same authored thing.
    const attrName = attr.default ? "value" : String(attr.name);
    if (attrName !== "value") {
      fail(
        attrName === "valueChange"
          ? "`<return>` does not support the `valueChange` attribute; MX returns a value only, with no two-way channel"
          : `\`<return>\` does not support the \`${attrName}\` attribute`,
        attr,
      );
    }
    if (valueAttr) fail("invalid duplicate `value` attribute", attr);
    valueAttr = attr;
  }

  if (!valueAttr?.value) {
    fail("`<return>` requires a `value=` attribute", node);
  }

  if (nested) {
    fail(
      "`<return>` must be at the top level of its template; it declares the value the whole unit returns, so it cannot be conditional or nested",
      node,
    );
  }

  if (ctx.returnValue) {
    fail("cannot have multiple `<return>` tags for the template", node);
  }

  ctx.returnValue = { expr: exprOf(ctx, valueAttr.value), loc: posOf(node) };
  // Contributes nothing to the rendered output: the value is lifted onto the
  // `Ir` and emitted as part of the unit's signature, not in document order.
  return { kind: "Text", value: "", loc: posOf(node) };
}

function lowerCustomTag(
  ctx: Ctx,
  node: Node,
  name: string,
  definition: CustomTag,
  isBuiltin = false,
): IrNode[] {
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``, {
    attributeTags: true,
    params: true,
    // `var: true` only opts out of this generic rejector's own wording;
    // the dedicated check right below still rejects `/var` for every
    // non-builtin call, with the message this construct actually needs.
    var: true,
  });
  // `/var` binds the value the target unit returns with `<return>`. Whether
  // it *has* one is a fact about the other module, so it is checked where
  // that module's metadata is available — `routeTemplateCall`, for a
  // template-backed tag. A tag with no template at all (an L2 sidecar, or a
  // core-owned built-in like `<try>`) has no `<return>` to read and no unit
  // to compile, so the binding could never be filled.
  //
  // A core-owned built-in is exempt: it validates `/var` itself, with its
  // own wording, inside its `transform`.
  if (!isBuiltin && node.var && !hasTemplate(definition)) {
    fail(
      `\`/var\` on \`<${name}>\` is not supported: it has no template, so it has no \`<return>\` to bind`,
      node,
    );
  }
  validateAttributeTagShape(node);

  const children = node.body?.body ?? [];
  const call: TagCall = {
    name,
    loc: posOf(node),
    attrs: lowerAttrs(ctx, node, name, "component"),
    content: isBuiltin || hasContent(children) ? lowerBlock(ctx, node) : null,
    attributeTags: lowerAttributeTags(ctx, node),
    params: paramsOf(ctx, node),
    var: node.var ? declName(ctx, node.var) : null,
  };
  // The binding was pre-registered by `lowerChildList` at its sibling index;
  // reaching the call is what makes it readable, so its sequence drops to
  // "already seen". Recorded after the call's own attributes were lowered,
  // so a tag's attributes cannot read the `/var` that same tag declares —
  // Marko's rule (`references.ts:556-560`), and the emitted order makes it
  // necessary: the binding is assigned from this call's own result.
  if (call.var) {
    ctx.tagVars ??= new Map();
    ctx.tagVars.set(call.var, {
      block: [...(ctx.tagVarBlock ?? [])],
      pending: false,
    });
  }
  // A core-owned built-in like `<try>` is not a registered tag the caller
  // can finalize. The analyze scratch walk records into its own discarded
  // set; a template lower also owns a local set which is stored with the
  // compiled template and replayed into the caller on every cache hit.
  if (!isBuiltin) {
    ctx.customTagsUsed ??= new Set();
    ctx.customTagsUsed.add(name);
  }
  return transformCustomTag(ctx, definition, call, node);
}

/** A component call, with its props, children and attribute tags. */
function lowerComponent(ctx: Ctx, node: Node, target: ComponentTarget): IrNode {
  // The host gets first refusal, before any `Component` node exists: a call it
  // will not route must fail here rather than reach an emitter, which no
  // longer has the Marko node to judge it by.
  if (target.kind === "name") {
    ctx.declarations.rejectComponentTag?.(target.name, node, ctx);
  }
  rejectUnsupportedFields(ctx, node, `\`<${targetName(target)}>\``, {
    attributeTags: true,
    args: true,
    params: true,
  });

  validateAttributeTagShape(node);

  const children = node.body?.body ?? [];
  return {
    kind: "Component",
    target,
    nameSpan: target.kind === "dynamic" ? null : nodeSpan(ctx, node.name),
    attrs: lowerAttrs(ctx, node, targetName(target), "component"),
    content: hasContent(children) ? lowerBlock(ctx, node) : null,
    attributeTags: lowerAttributeTags(ctx, node),
    args: (node.arguments ?? []).map((a: Node) => exprOf(ctx, a)),
    loc: posOf(node),
  };
}

function targetName(target: ComponentTarget): string {
  // A dynamic target has no name to report, so the diagnostic names the
  // construct instead. Spelled without a `$`-brace so it is not mistaken for
  // an unintended template placeholder in this file's own source.
  return target.kind === "dynamic" ? "dynamic tag" : target.name;
}

function lowerTag(ctx: Ctx, node: Node): IrNode | IrNode[] {
  // Both a bare `${expr}` line and `<${expr} .../>` parse to a tag whose
  // *name* is the expression — Marko's concise mode has no other shape for
  // a bare one (see the "four Marko facts" in AGENTS.md). Both are dynamic
  // tags: when a host claims DYNAMIC_TAG it gets the HostTag (shape "bare"
  // or "tagged", as before); otherwise core lowers a `Component` with a
  // dynamic target, resolved at run time like any other host.
  if (node.name && node.name.type !== "StringLiteral") {
    const isBare =
      (node.attributes ?? []).length === 0 && !node.body?.body?.length;
    const claimed = ctx.declarations.claimsTag?.(
      DYNAMIC_TAG,
      ctx,
      isBare ? "bare" : "tagged",
    );
    if (claimed) return lowerHostTag(ctx, node, DYNAMIC_TAG);
    return lowerComponent(ctx, node, {
      kind: "dynamic",
      expr: exprOf(ctx, node.name),
    });
  }

  const name = String(node.name.value);

  const disposition = ctx.declarations.tags[name];
  if (disposition) {
    if (disposition.kind === "error") fail(disposition.reason, node);
    rejectInertShape(ctx, node, name, disposition);
    // Inert: accepted, contributes nothing to the IR.
    return { kind: "Text", value: "", loc: posOf(node) };
  }

  switch (name) {
    case "import":
    case "static":
    case "export":
      return lowerStatement(ctx, node, name);
    case "for":
      return lowerFor(ctx, node);
    case "const":
      return lowerConst(ctx, node);
    case "define":
      return lowerDefine(ctx, node);
    case "return":
      return lowerReturn(ctx, node, ctx.returnDepth !== 0);
    case "else": {
      const label = attrByName(node, "if") ? "else if" : "else";
      return fail(`\`<${label}>\` without a preceding \`<if>\``, node);
    }
    case "else-if":
      return fail(`\`<${name}>\` without a preceding \`<if>\``, node);
  }

  if (name.startsWith("@")) {
    fail(
      `attribute tag \`<${name}>\` is only valid directly inside a component call`,
      node,
    );
  }

  // Core-owned custom tags (`<try>`) are consulted before a caller's own
  // `ctx.customTags`, and win unconditionally: a caller registering the same
  // name is a shadowing attempt on a built-in, rejected here rather than
  // silently ignored.
  const builtinTag = Object.hasOwn(BUILTIN_CUSTOM_TAGS, name)
    ? BUILTIN_CUSTOM_TAGS[name]
    : undefined;
  if (builtinTag) {
    if (ctx.customTags && Object.hasOwn(ctx.customTags, name)) {
      fail(shadowedBuiltinMessage(name), node);
    }
    return lowerCustomTag(ctx, node, name, builtinTag, true);
  }

  // A name the file itself binds — an `import`, or a `<define>` — wins over
  // a registered custom tag of the same name (spec §4: explicit import >
  // local `tags/` > `mx.tags`). This is a core rule, checked directly on
  // `ctx.imports`/`ctx.defines` rather than by calling a host's own
  // `isComponent` (which also matches taglib-discovered names with no
  // file-local binding, and which Solid's and Astro's implementations never
  // consult at all — both decide purely by case), so a shadowed name routes
  // to the component it names instead of the custom tag before
  // `ctx.customTags` is ever consulted.
  //
  // Gated on PascalCase: Marko's own rule (matched by every host's own
  // `isComponent`, e.g. html `translate.ts`, preact `emitter.ts`) is that a
  // *lowercase* local variable is never resolved as a component tag — only
  // taglib/`tags/` discovery or a built-in element can claim a lowercase
  // name. An ungated check regressed `import panel from "./p.mx"` +
  // `<panel/>` (a registered `panel` custom tag, or a host-claimed
  // `<style>`): the file-local binding existed but was never meant to be a
  // component call, so it must not shadow the custom tag or the host claim
  // either.
  const fileLocalBinding =
    /^[A-Z]/.test(name) && (ctx.defines.has(name) || ctx.imports.has(name));

  // Registered custom tags take precedence over host claims so a shared tag
  // may be expressed in terms of `ctx.build.hostTag(...)`. Structural tags
  // above remain core-owned and cannot be shadowed; a file-local binding
  // (checked above) outranks a custom tag of the same name.
  const customTag =
    !fileLocalBinding && ctx.customTags && Object.hasOwn(ctx.customTags, name)
      ? ctx.customTags[name]
      : undefined;
  if (customTag) return lowerCustomTag(ctx, node, name, customTag);

  if (!fileLocalBinding && ctx.declarations.claimsTag?.(name, ctx)) {
    return lowerHostTag(ctx, node, name);
  }

  if (ctx.declarations.isComponent(name, ctx)) {
    const params = ctx.defines.get(name);
    return lowerComponent(
      ctx,
      node,
      params ? { kind: "define", name, params } : { kind: "name", name },
    );
  }

  // No HTML element is ever capitalized, so an unbound PascalCase tag is a
  // missing or misspelled binding, not an element that happens to be
  // capitalized. Emitting it literally would be a silent misroute.
  if (/^[A-Z]/.test(name)) {
    fail(
      `\`<${name}>\` has no matching import or \`<define>\` in scope; a capitalized tag is always a component call`,
      node,
    );
  }

  // An unknown lowercase tag that is neither a binding nor a real element is
  // the silent-failure mode ADR 0001 names: a core tag the host has no
  // lowering for must be an error, never a literal element.
  if (!ctx.declarations.isElement(name, ctx)) {
    // The host's own wording first: a Marko-parity target reports Marko's
    // failure for an unresolved custom tag, which is what its users see and
    // what the fixtures assert. The message below is the fallback.
    ctx.declarations.rejectUnknownTag?.(name, node, ctx);
    fail(
      `unknown tag \`<${name}>\`: not an HTML element, and no matching import or \`<define>\` is in scope`,
      node,
    );
  }

  if (node.attributeTags?.length) {
    ctx.declarations.rejectElementAttributeTags?.(name, node, ctx);
  }
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``);

  const isVoid = VOID_TAGS.has(name);
  return {
    kind: "Element",
    name,
    attrs: lowerAttrs(ctx, node, name),
    children: isVoid ? [] : lowerChildren(ctx, node.body?.body ?? []),
    void: isVoid,
    loc: posOf(node),
  };
}

export function lowerChildren(ctx: Ctx, children: Node[]): IrNode[] {
  // Every call but the template body's own (`lower`, which resets it to 0
  // around its walk) is lowering the children of *some* container, so
  // counting here rather than at each of the eight call sites is what keeps
  // `<return>`'s position rule from drifting the next time a construct with
  // a child list is added.
  const depth = ctx.returnDepth ?? 0;
  ctx.returnDepth = depth + 1;
  // Each block gets an id, and the path to it is what decides whether a
  // `/var` declared in one block is readable from another (see
  // `checkTagVarReads`). Two sibling blocks get different ids, which is the
  // distinction depth alone cannot make.
  const outerBlock = ctx.tagVarBlock ?? [];
  ctx.tagVarBlockSeq = (ctx.tagVarBlockSeq ?? 0) + 1;
  ctx.tagVarBlock = [...outerBlock, ctx.tagVarBlockSeq];
  try {
    return lowerChildList(ctx, children);
  } finally {
    ctx.returnDepth = depth;
    ctx.tagVarBlock = outerBlock;
    // A `/var` declared in this block goes out of scope with it, exactly as
    // the `let` it emits does. Its entry is kept rather than deleted, holding
    // the *block path* it was declared at: a later read is then a diagnosable
    // escape ("not in scope here") instead of an ordinary unknown identifier
    // that would reach the emitted JS as `undefined`. A sibling block that
    // binds the same name overwrites the entry, which is right — that is a
    // new binding, and ordinary JS.
  }
}

function lowerChildList(ctx: Ctx, children: Node[]): IrNode[] {
  // Every `/var` this block declares is registered *before* the walk, at the
  // sibling index it is declared at. A read earlier in the same block then
  // finds a binding whose sequence is greater than its own and reports
  // "read before the call", rather than finding nothing and compiling to a
  // reference the emitted JS leaves in the temporal dead zone — Marko's own
  // check (`references.ts:597-602`), which compares sibling indices for
  // exactly this reason.
  for (const child of children) {
    if (child?.type !== "MarkoTag" || !child.var) continue;
    // Only a *custom tag call* binds a `/var` from a unit's `<return>`.
    // `<let>`, `<const>` and every other core construct that takes a `/var`
    // declares an ordinary binding whose scope rules already work, and
    // pre-registering those made a legal read of one report as out of scope.
    const tagName = child.name?.value;
    if (
      typeof tagName !== "string" ||
      !ctx.customTags ||
      !Object.hasOwn(ctx.customTags, tagName)
    ) {
      continue;
    }
    const name = declName(ctx, child.var);
    ctx.tagVars ??= new Map();
    ctx.tagVars.set(name, {
      block: [...(ctx.tagVarBlock ?? [])],
      pending: true,
    });
  }

  const out: IrNode[] = [];
  let index = 0;

  while (index < children.length) {
    const child = children[index];

    if (child.type === "MarkoTag" && child.name?.value === "if") {
      const [node, next] = lowerIfChain(ctx, children, index);
      out.push(node);
      index = next;
      continue;
    }

    // A hoist from this child belongs to the enclosing function, so the
    // prelude it appends is drained by whichever scope owns it — the template,
    // or the nearest `<define>`.
    switch (child.type) {
      case "MarkoText":
        // Already decision 33: Marko's own `onText` dropped newline-bearing
        // whitespace runs and collapsed the rest before we saw them.
        out.push({ kind: "Text", value: child.value, loc: posOf(child) });
        break;
      case "MarkoPlaceholder":
        out.push({
          kind: "Interpolation",
          expr: exprOf(ctx, child.value),
          escaped: child.escape,
          loc: posOf(child),
        });
        break;
      case "MarkoTag": {
        // A statement the host hoisted stays on `ctx.prelude` and is drained
        // by the enclosing *function* — `lowerDefine`, or `lower` for the
        // render function — never here. Draining it at every child list would
        // trap a hoist from inside an `<if>` in that branch, which is the one
        // thing decision 70's hoist hook exists to prevent: the declaration
        // has to outlive the block it was written in.
        const lowered = lowerTag(ctx, child);
        if (Array.isArray(lowered)) out.push(...lowered);
        else out.push(lowered);
        break;
      }
      case "MarkoDocumentType":
        out.push({
          kind: "DocumentType",
          value: child.value,
          loc: posOf(child),
        });
        break;
      case "MarkoComment":
        // Marko strips the delimiters, so an HTML comment and a `//` line
        // comment are indistinguishable by value alone; the source decides.
        out.push({
          kind: "Comment",
          value: child.value,
          html: sliceLoc(ctx, child.loc).startsWith("<!--"),
          loc: posOf(child),
        });
        break;
      case "MarkoScriptlet":
        fail(
          "scriptlets (`$ statement`) are not supported in MX (decision 54)",
          child,
        );
        break;
    }
    index++;
  }

  return out;
}

/**
 * Lowers a whole template body to the IR.
 *
 * Module-level parts (`import`, `static`, `export interface Input`) are lifted
 * out of the body into `Ir`'s own fields, so a host places them without
 * filtering the tree for statement nodes.
 */
export function lower(ctx: Ctx, body: Node[]): Ir {
  // The file root owns the collecting hooks; a tag template's own lower is
  // handed the caller's stores and must not run them a second time.
  const isFileRoot = ctx.customTagStores === undefined;
  if (isFileRoot) {
    ctx.customTagStores = new Map();
    // Created eagerly so a template's `Ctx` can share the same set by
    // reference: a tag called only from inside a tag template must still be
    // finalized in the file that called the template.
    ctx.customTagsUsed ??= new Set();
    runCustomTagAnalyze(ctx, body);
  }

  // Computed before the body walk, because a self-recursive call resolves to
  // it *during* that walk: `bindingForTemplate` returns this name instead of
  // minting a self-import (invariant §7.5-7). Minted against what the file
  // already binds, so the declaration a host emits can never shadow an import
  // or a `<define>`. `ctx.source` is scanned too, the same belt-and-braces
  // `generatedBinding` uses: a name can reach the emitted module without
  // passing through `ctx.imports`/`ctx.defines` (a `<const>`, a tag param).
  //
  // Only when the caller actually emits a module. A `.solid.mx` *region* is
  // an expression with no `export default function` of its own, so a name
  // here would be one nothing declares — and `bindingForTemplate` would hand
  // a region calling its own file's tag a dangling identifier rather than an
  // error. `=`, not `??=`: a reused or pre-seeded `Ctx` must not keep a
  // previous file's name.
  ctx.exportName = ctx.emitsModule
    ? exportNameFor(
        ctx.filename,
        (name) =>
          ctx.imports.has(name) ||
          ctx.defines.has(name) ||
          new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`).test(ctx.source),
      )
    : undefined;

  // -1, so the template body's own `lowerChildren` sits at depth 0 — the one
  // position `<return>` is legal in. `=`, not `??=`: a reused `Ctx` must not
  // inherit a previous walk's depth, which would make a legal `<return>`
  // report as nested.
  ctx.returnDepth = -1;
  ctx.returnValue = null;
  // Reset for the same reason: a reused `Ctx` must not carry a previous
  // file's block path, which would make a legal read look out of scope.
  ctx.tagVarBlock = [];
  ctx.tagVars = undefined;

  const [nodes, prelude] = withPrelude(ctx, () => lowerChildren(ctx, body));

  const ir: Ir = {
    imports: [],
    hoisted: [],
    inputInterface: null,
    prelude: prelude.map(({ code, node }) => ({
      kind: "Hoisted",
      code,
      loc: posOf(node),
      end: endPosOf(node),
    })),
    body: [],
    tagMetadata: { readsContent: false, attributeTags: [] },
    exportName: ctx.exportName,
  };

  for (const node of nodes) {
    switch (node.kind) {
      case "Import":
        // The bindings were registered as the statement resolved; this only
        // places the statement itself at module scope.
        ir.imports.push(node);
        break;
      case "Static":
        ir.hoisted.push(node);
        break;
      case "Export":
        ir.hoisted.push(node);
        break;
      case "InputInterface":
        ir.inputInterface = node;
        break;
      case "Hoisted":
        ir.prelude.push(node);
        break;
      default:
        ir.body.push(node);
    }
  }

  ir.imports.push(...(ctx.customTagImportNodes ?? []));

  if (isFileRoot && ctx.customTags) {
    // Prepended as one block, after the body is assembled: a `finalize` node
    // is program-level output (a sprite sheet, a collected style block), not
    // something that belongs inside whatever construct the last call site
    // happened to sit in.
    const prepended = runFinalizeHooks(
      ctx,
      ctx.customTags,
      ctx.customTagsUsed ?? new Set<string>(),
    );
    if (prepended.length > 0) ir.body.unshift(...prepended);
  }

  // Read off `Ctx` rather than returned from the walk: `lowerReturn` records
  // it wherever the tag was met, and the walk's own result is the body.
  ir.returnValue = (ctx as Ctx).returnValue?.expr ?? null;
  ir.tagMetadata = metadataOfIr(ir);

  return ir;
}

/**
 * Walks the body once on a scratch `Ctx`, then runs every `analyze`.
 *
 * The scratch `Ctx` is the whole trick. It shares what a lower needs to read —
 * the source, the host's declarations, the taglib lookup, the registered tags
 * and the file's stores — and owns fresh copies of everything a lower
 * *writes*: its own prelude, bindings, defines, imports, warnings and template
 * import map. So the pre-pass lowers each call exactly as the real pass will
 * (same enclosing `<for>` params, same binding rewrites, same attribute
 * lowering), which is what lets `analyze` be handed the identical `TagCall`
 * its own `transform` will later receive, while the hoists, warnings and
 * template imports it produces are discarded with the scratch `Ctx` instead of
 * being emitted twice.
 *
 * Skipped entirely when no registered tag defines `analyze`, so a file using
 * only ordinary tags pays for one walk as before.
 */
function runCustomTagAnalyze(ctx: Ctx, body: Node[]): void {
  const customTags = ctx.customTags;
  if (!customTags) return;
  if (!Object.values(customTags).some((tag) => tag.analyze)) return;

  const scratch = newCtx(
    ctx.source,
    ctx.generate,
    ctx.declarations,
    ctx.lookup,
    ctx.filename,
  );
  scratch.customTags = customTags;
  // Mirrors the parent: this walk is the same file, so whether it emits a
  // module is the same answer.
  scratch.emitsModule = ctx.emitsModule;
  scratch.customTagStores = ctx.customTagStores;
  scratch.customTagGensym = ctx.customTagGensym;
  // -1, exactly as `lower` sets it, because this walk enters through
  // `lowerChildren` rather than through `lower`: the body's own child list
  // then sits at depth 0, the one position `<return>` is legal in. Left
  // unset, `lowerChildren`'s `?? 0` started this walk at depth 1 and a
  // legitimately top-level `<return>` was rejected — but *only* in a file
  // that also used a tag with an `analyze` hook, since nothing else runs
  // this second walk.
  scratch.returnDepth = -1;
  // Absorbed rather than forwarded: every warning this walk raises is raised
  // again by the real walk, at the same position, and reporting a dropped
  // attribute tag twice would read as two mistakes.
  scratch.warnings = [];
  const calls = new Map<string, TagCall[]>();
  scratch.customTagAnalyzePass = { calls };

  lowerChildren(scratch, body);
  runAnalyzeHooks(ctx, customTags, calls);
}

/** Compiles one tag unit only to produce its cached caller metadata. */
registerTemplateMetadataCompiler((ctx: Ctx, tag: TemplateTag) => {
  const { body } = parseFragment(tag.source, {
    filename: tag.filename,
    customTags: ctx.customTags as Record<string, CustomTag> | undefined,
  });
  const templateCtx = newCtx(
    tag.source,
    ctx.generate,
    ctx.declarations,
    ctx.lookup,
    tag.filename,
  );
  templateCtx.customTags = ctx.customTags;
  // A tag unit is a file that compiles to a module of its own, whatever the
  // caller is — so its self-recursive calls resolve to its own export.
  templateCtx.emitsModule = true;
  // Shared by reference, which is the whole point of boxing the counter: a
  // name minted while compiling this unit and one minted by the caller must
  // never be the same serial. The unit's names do land in the unit's own
  // module, so a repeat is not observable in today's emitted output — but the
  // counter is the file-level identity supply, and PR #81 fixed exactly this
  // collision for the path this one replaced. Left unshared it silently comes
  // back the moment anything reads a generated name across the boundary.
  templateCtx.customTagGensym = ctx.customTagGensym;
  // Metadata compilation is an independent unit. Its warnings are not caller
  // diagnostics, and its analyze/finalize stores must not run as a side effect
  // of a caller asking only for metadata.
  templateCtx.warnings = [];
  templateCtx.customTagStores = new Map();
  const ir = lower(templateCtx, body);
  return ir.tagMetadata;
});

export type { HostDeclarations };
