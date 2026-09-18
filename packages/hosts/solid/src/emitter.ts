import {
  type Attr,
  type AttributeTag,
  concatMapped,
  destructuredNames,
  drive,
  type Emitter,
  type Expr,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type MappedCode,
  mapped,
  type Position,
  type ReadRewrite,
  rewriteAccessorReads,
  TranslateError,
} from "@mxlang/core";

const STATEFUL_ERRORS: HostDeclarations["tags"] = {
  let: {
    kind: "error",
    reason:
      "`<let>` is Marko reactive state; use Solid's `createSignal` in the surrounding TypeScript module",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a Marko reactive effect; use Solid's `createEffect` in the surrounding TypeScript module",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a Marko lifecycle hook; use Solid's lifecycle primitives in the surrounding TypeScript module",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` is a Marko client-runtime tag; write client code in the surrounding TypeScript module",
  },
};

/**
 * The prop a returning unit calls to hand its `<return>` value back.
 *
 * Solid is the one host where the `{ value, output }` shape does not fit: a
 * component's return value is its view, and the caller writes JSX rather than
 * a call. Measured against solid-js 2.0.0-rc.7 (design §2.4), the component
 * function runs synchronously at the JSX site under both `dom` and `ssr`
 * generation, so a callback it invokes during setup has already run by the
 * caller's next statement.
 *
 * **One-shot, not reactive** (risk 4): the binding holds the value from that
 * single invocation. That matches `/var`'s meaning on every other host, but a
 * Solid author may reasonably expect a signal — a tag wanting reactivity
 * should return an accessor for the caller to call.
 *
 * Carries the `$mx` prefix every generated name here uses, so it cannot
 * collide with a prop an author declares in the unit's own `Input`.
 */
export const MX_RETURN_PROP = "$mxReturn";

/**
 * `/var` names the emitted module must declare above the JSX that fills them.
 *
 * Module-level rather than a field on the emitter because this host builds
 * child emitters freely (`renderWithNewEmitter`) with no shared state, so a
 * call inside an `<if>` or a `<for>` body would otherwise report into an
 * emitter the module assembly never sees. `collectReturnVars` scopes it to
 * one compile; nothing here is retained between compiles.
 */
let returnVars: Set<string> | null = null;

/**
 * The emitter is filling a lazily-evaluated or per-row scope.
 *
 * A `<For>` body is a callback run once per row, and a `<Show>`/`<Match>`
 * body is evaluated only when its condition holds — so the single `let` this
 * host declares at the component's head cannot serve them. Round 1 measured
 * both failures: every `<For>` iteration aliased one binding, and a read
 * beside the call ran before the child's callback had fired.
 *
 * Invariant §7.5-8 rejects the escape rather than emitting it. Lifting the
 * restriction means a declaration per callback scope, filed as MX 2 work.
 * Module-level for the same reason `returnVars` is: this host creates child
 * emitters freely, with no shared instance state.
 */
let lazyScope = false;

/**
 * Gensym counter for the dynamic-tag IIFE's temp binding.
 *
 * Module-level, same reason `returnVars`/`lazyScope` are: monotonic across
 * every compile in the process is still unique within any one compile's
 * output, which is all uniqueness this binding needs.
 */
const dynSerial = { n: 0 };

/** Runs `emit` with `/var` refused, for a body that is lazy or per-row. */
function inLazyScope<T>(emit: () => T): T {
  const outer = lazyScope;
  lazyScope = true;
  try {
    return emit();
  } finally {
    lazyScope = outer;
  }
}

/** Runs `emit` while collecting the `/var` names its call sites declare. */
export function collectReturnVars(emit: () => string): {
  code: string;
  vars: string[];
} {
  const outer = returnVars;
  const collected = new Set<string>();
  returnVars = collected;
  try {
    return { code: emit(), vars: [...collected] };
  } finally {
    returnVars = outer;
  }
}

type TryData = { kind: "try" };

function positionOf(node: { loc: Position }): Position {
  return node.loc;
}

function fail(message: string, node: { loc: Position }): never {
  const { line, column } = positionOf(node);
  throw new TranslateError(message, line, column);
}

function rawPosition(node: { loc?: { start?: Position } }): Position {
  return node.loc?.start ?? { line: 0, column: 0 };
}

function rawFail(message: string, node: { loc?: { start?: Position } }): never {
  const { line, column } = rawPosition(node);
  throw new TranslateError(message, line, column);
}

/** Resolve-time questions for Solid's JSX target. */
export const solidDeclarations: HostDeclarations = {
  tags: STATEFUL_ERRORS,
  isElement: (name) => !/^[A-Z]/.test(name),
  isComponent: (name) => /^[A-Z]/.test(name),
  claimsTag: (name) => name === "try",
  // `<try>` is a core-owned custom tag (`packages/core/src/builtin-tags.ts`):
  // the shape checks that used to live here — no params, no `/var`, one
  // `<@catch>`, one `<@placeholder>` with no params of its own — are the
  // core's `attributeTags` declaration and the tag's own `transform`. This
  // host only decides how the claimed primitive renders.
  resolveHostTag(name, node): TryData {
    if (name !== "try") rawFail(`unknown Solid host tag ${name}`, node);
    return { kind: "try" };
  },
  resolveModifier(attr) {
    if ((attr.default && attr.name === "value") || attr.name.includes(":")) {
      rawFail("malformed namespaced attribute", attr);
    }
    if (attr.name === "prop" && attr.modifier) {
      return `prop:${attr.modifier}`;
    }
    return undefined;
  },
  rejectModifier(attr) {
    const replacements: Record<string, string> = {
      on: "`on:x=fn` was removed in Solid 2; use `onX=fn` for a delegated event or `on-x=fn` for a custom event name (Marko rejects this form too)",
      oncapture:
        "`oncapture:x=fn` was removed in Solid 2; use `onX=fn` — MX has no capture spelling in the name, so use a `ref` callback calling `addEventListener(..., { capture: true })` if you need capture",
      attr: "`attr:x=v` was removed in Solid 2; use the plain attribute `x=v`",
      bool: "`bool:x=v` was removed in Solid 2; use the plain attribute `x=v`",
      use: "`use:foo=opts` was removed in Solid 2; use `ref=foo(opts)` (a directive is now a function returning a ref callback)",
    };
    rawFail(
      replacements[attr.name] ??
        `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported by Solid`,
      attr,
    );
  },
  resolveAttributeMethod: () => true,
};

function escapeText(value: string): string {
  return value.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function numericValue(expr: Expr): number | null {
  const node = expr.node;
  if (node?.type === "NumericLiteral" && typeof node.value === "number") {
    return node.value;
  }
  if (node?.type === "UnaryExpression" && node.operator === "-") {
    const argument = node.argument;
    if (
      argument?.type === "NumericLiteral" &&
      typeof argument.value === "number"
    ) {
      return -argument.value;
    }
  }
  return null;
}

function staticTemplateValue(expr: Expr): string | null {
  const node = expr.node;
  if (node?.type !== "TemplateLiteral") return null;
  const expressions = node.expressions ?? [];
  if (
    expressions.some(
      (item: { type?: string }) => item?.type !== "StringLiteral",
    )
  ) {
    return null;
  }
  let value = "";
  for (let index = 0; index < (node.quasis ?? []).length; index++) {
    value += node.quasis[index]?.value?.cooked ?? "";
    value += expressions[index]?.value ?? "";
  }
  return value;
}

function methodExpression(expr: Expr): string | null {
  if (expr.node?.type !== "FunctionExpression") return null;
  const match = expr.code.match(
    /^(async\s+)?function\s*\(([\s\S]*)\)\s*(\{[\s\S]*\})$/,
  );
  if (!match) return expr.code;
  return `${match[1] ?? ""}(${match[2] ?? ""}) => ${match[3] ?? "{}"}`;
}

function renderAttr(attr: Attr, mapName = false): MappedCode {
  switch (attr.kind) {
    case "spread":
      return concatMapped(` {...${attr.value.code}}`);
    case "boolean":
      return concatMapped(
        " ",
        mapped(attr.name, mapName ? attr.nameSpan : null),
        "={true}",
      );
    case "static":
      return concatMapped(
        " ",
        mapped(attr.name, mapName ? attr.nameSpan : null),
        `="${escapeAttribute(attr.value)}"`,
      );
    case "bound":
      return fail(
        "bound attribute (`:=`) is Marko reactive state; use Solid state and an explicit event handler",
        attr,
      );
    // Phase B of `dom-events` (decision 101): recompose Solid's prop from the
    // DOM event name core resolved — `on` + the capitalized name
    // (`click` → `onClick`, `dblclick` → `onDblclick`) — never the authored
    // spelling, so `onDblClick` and `on-dblclick` emit byte-identically.
    // Solid has no custom-event prop (its own types only declare the DOM
    // names), so a name JSX cannot spell as one identifier — a custom DOM
    // event such as `my-event` from `on-my-event` — is a positioned error
    // naming the `ref` route, the same escape hatch Solid's own docs give
    // for listener options.
    case "event": {
      if (!/^[A-Za-z0-9]+$/.test(attr.event)) {
        return fail(
          `\`${attr.name}\` names a custom DOM event (\`${attr.event}\`) Solid cannot bind as a prop; use a \`ref\` callback calling \`addEventListener("${attr.event}", fn)\``,
          attr,
        );
      }
      const prop = `on${attr.event.charAt(0).toUpperCase()}${attr.event.slice(1)}`;
      return concatMapped(
        " ",
        mapped(prop, null),
        `={${methodExpression(attr.value) ?? attr.value.code}}`,
      );
    }
    case "dynamic": {
      if (attr.name === "style" && attr.value.shape !== "object") {
        return fail("`style=` with a non-object value", attr);
      }
      const fixed =
        attr.name === "class" ? staticTemplateValue(attr.value) : null;
      if (fixed !== null) {
        return concatMapped(
          " ",
          mapped(attr.name, mapName ? attr.nameSpan : null),
          `="${escapeAttribute(fixed)}"`,
        );
      }
      return concatMapped(
        " ",
        mapped(attr.name, mapName ? attr.nameSpan : null),
        `={${methodExpression(attr.value) ?? attr.value.code}}`,
      );
    }
  }
}

function renderAttrs(attrs: Attr[], mapNames = false): MappedCode {
  const ids = attrs.filter(
    (attr) => attr.kind !== "spread" && attr.name === "id",
  );
  if (ids.length > 1 && ids.some((attr) => attr.loc.line === 0)) {
    fail(
      "`#id` shorthand combined with an explicit `id=` attribute",
      ids[0] as Attr,
    );
  }

  const classEntries = attrs
    .map((attr, index) => ({ attr, index }))
    .filter(({ attr }) => attr.kind !== "spread" && attr.name === "class");
  const invalidShorthandMerge = classEntries.find(({ attr }) => {
    if (attr.kind !== "dynamic" || attr.value.shape !== "array") return false;
    const array = attr.value.node;
    // Marko folds `.card class=value` into a synthetic array whose own `loc`
    // is absent. Solid accepts that fold only when the explicit value is an
    // object literal; a real authored array has a location and remains valid.
    return (
      !array.loc &&
      array.elements?.[0]?.type === "StringLiteral" &&
      array.elements?.[1]?.type !== "ObjectExpression"
    );
  });
  if (invalidShorthandMerge) {
    fail(
      "`.class` shorthand combined with a non-string `class={...}` value (combine shorthand with a string class or use class={...})",
      invalidShorthandMerge.attr,
    );
  }
  const structured = classEntries.find(
    ({ attr }) =>
      attr.kind === "dynamic" &&
      (attr.value.shape === "object" || attr.value.shape === "array"),
  );
  if (!structured) {
    if (
      classEntries.length > 1 &&
      classEntries.some(
        ({ attr }) =>
          attr.kind === "dynamic" && staticTemplateValue(attr.value) === null,
      )
    ) {
      fail(
        "`.class` shorthand combined with a non-string `class={...}` value (combine shorthand with a string class or use class={...})",
        classEntries.at(-1)?.attr as Attr,
      );
    }
    return concatMapped(...attrs.map((attr) => renderAttr(attr, mapNames)));
  }

  const strings = classEntries.flatMap(({ attr }) => {
    if (attr.kind === "static") return [attr.value];
    if (attr.kind !== "dynamic") return [];
    const value = staticTemplateValue(attr.value);
    return value === null ? [] : [value];
  });
  const merged = strings.join(" ");
  return concatMapped(
    ...attrs.map((attr, index) => {
      if (
        attr.kind !== "spread" &&
        attr.name === "class" &&
        index !== structured.index
      ) {
        return concatMapped();
      }
      if (index !== structured.index || attr.kind !== "dynamic") {
        return renderAttr(attr, mapNames);
      }
      if (merged === "") return renderAttr(attr, mapNames);
      if (attr.value.shape === "array") {
        return concatMapped(
          " ",
          mapped("class", mapNames ? attr.nameSpan : null),
          `={[${JSON.stringify(merged)}, ...${attr.value.code}]}`,
        );
      }
      return concatMapped(
        " ",
        mapped("class", mapNames ? attr.nameSpan : null),
        `={[${JSON.stringify(merged)}, ${attr.value.code}]}`,
      );
    }),
  );
}

function meaningful(nodes: IrNode[]): IrNode[] {
  return nodes.filter(
    (node) =>
      node.kind !== "Comment" && !(node.kind === "Text" && node.value === ""),
  );
}

function rawChild(
  nodes: IrNode[],
): Extract<IrNode, { kind: "Interpolation" }> | null {
  const content = meaningful(nodes);
  if (content.length !== 1) return null;
  const only = content[0];
  return only?.kind === "Interpolation" && !only.escaped ? only : null;
}

function rejectMixedRaw(nodes: IrNode[]): void {
  const content = meaningful(nodes);
  const raw = content.find(
    (node): node is Extract<IrNode, { kind: "Interpolation" }> =>
      node.kind === "Interpolation" && !node.escaped,
  );
  if (raw && content.length !== 1) {
    fail("raw placeholder must be the only child", raw);
  }
}

function hasNamedAttr(attrs: Attr[], name: string): boolean {
  return attrs.some((attr) => attr.kind !== "spread" && attr.name === name);
}

function renderWithNewEmitter(nodes: IrNode[]): MappedCode {
  const child = new SolidEmitter();
  drive(child, nodes);
  return child.result();
}

function blockExpression(nodes: IrNode[]): MappedCode {
  const content = meaningful(nodes);
  if (content.length === 1) {
    const only = content[0] as IrNode;
    if (only.kind === "Interpolation" && only.escaped) {
      return concatMapped(only.expr.code);
    }
    if (
      only.kind === "Element" ||
      only.kind === "Component" ||
      only.kind === "IfChain" ||
      only.kind === "For" ||
      only.kind === "HostTag"
    ) {
      return renderWithNewEmitter(content);
    }
  }
  return concatMapped("<>", renderWithNewEmitter(content), "</>");
}

function attributeTag(tag: AttributeTag): MappedCode {
  const value = blockExpression(tag.block.children);
  if (!tag.block.hasParams) {
    return concatMapped(" ", mapped(tag.name, tag.nameSpan), "={", value, "}");
  }
  return concatMapped(
    " ",
    mapped(tag.name, tag.nameSpan),
    `={(${tag.block.params.join(", ")}) => `,
    value,
    "}",
  );
}

function identifierNames(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

function hygienicIndex(params: string[], body: string): string {
  const used = identifierNames(`${params.join(" ")} ${body}`);
  if (!used.has("mxIndex")) return "mxIndex";
  let index = 2;
  while (used.has(`mxIndex${index}`)) index++;
  return `mxIndex${index}`;
}

/**
 * Every identifier appearing anywhere in a `<for>`'s body or params.
 *
 * Walks the IR subtree collecting `Expr.code` and bound names, rather than
 * calling `blockExpression(node.children)` to get one printed string. That
 * shortcut was a real bug, not a style point: `blockExpression` *drives the
 * emitter* over the subtree, so merely asking "which names are taken" ran
 * every nested `<for>`'s own read-rewrite as a side effect, and the body was
 * then emitted — and rewritten — a second time. Measured on the shortcut:
 * `<for|{a}| of=xs by="id"><for|q| of=ys by="id">${q.z}` emitted `q()().z`
 * (a TypeError at render), and two nested destructured rows emitted a
 * `mxRow` bound nowhere, because the throwaway pass had already consumed that
 * gensym. Collecting names is now free of side effects.
 *
 * The scan of each expression is a regex, unlike every *rewrite* on this
 * path. The "AST, not regex" rule exists because a regex rewrite is silently
 * wrong (it renames inside string literals, and misses `x?x:x`); this is a
 * name-avoidance check, where the only failure mode is over-avoidance —
 * `<li title="mxRow">` yields `mxRow2`, still correct, merely uglier. Erring
 * toward more names is the safe direction.
 */
function forScopeNames(
  node: Extract<IrNode, { kind: "For" }>,
  extra: readonly string[],
): Set<string> {
  const names = identifierNames(`${node.params.join(" ")} ${extra.join(" ")}`);
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && "shape" in record) {
      for (const name of identifierNames(record.code)) names.add(name);
      return;
    }
    if (typeof record.value === "string") {
      for (const name of identifierNames(record.value)) names.add(name);
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "node" || key === "loc") continue;
      if (typeof child === "string") {
        for (const name of identifierNames(child)) names.add(name);
        continue;
      }
      visit(child);
    }
  };
  visit(node.children);
  for (const bound of node.bindings) names.add(bound);
  return names;
}

/** A name free in this `<for>`, for a parameter the emitter introduces. */
function gensym(
  base: string,
  node: Extract<IrNode, { kind: "For" }>,
  extra: readonly string[],
): string {
  const used = forScopeNames(node, extra);
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}${index}`)) index++;
  return `${base}${index}`;
}

/**
 * Rewrites each named binding's reads in a `<for>` body to read `read`.
 *
 * Any generated parameter is registered in `node.bindings` first. That array
 * is what the core's IR walk reads to decide which names an enclosing
 * construct binds, so a gensym missing from it is invisible to a *nested*
 * `<for>`'s own rewrite, which then rewrites this body a second time:
 * measured, `<for|{a}| of=xs by="id"><for|q| of=ys by="id">${q.z}` emitted
 * `q()().z` (a TypeError at render), and two nested destructured rows emitted
 * a `mxRow` bound nowhere.
 */
function rewriteForBody(
  node: Extract<IrNode, { kind: "For" }>,
  reads: readonly { name: string; read: string }[],
  generated: readonly string[] = [],
): void {
  for (const name of generated) {
    if (!node.bindings.includes(name)) node.bindings.push(name);
  }
  const rewrites = new Map<string, ReadRewrite>();
  for (const { name, read } of reads) {
    rewrites.set(name, {
      read,
      assignError: `\`<for>\`: \`${name}\` is bound by Solid as an accessor and cannot be assigned; compute a new value instead`,
    });
  }
  rewriteAccessorReads(node.children, rewrites);
}

/**
 * The reads one accessor-backed parameter contributes, given the expression
 * that reads its value.
 *
 * A plain identifier reads the accessor call itself. A destructuring pattern
 * cannot be destructured in the parameter list — Solid passes a function, and
 * destructuring one throws `TypeError: {} is not iterable` — so each name it
 * binds reads a member path of that same expression instead.
 */
function readsForParam(
  node: Extract<IrNode, { kind: "For" }>,
  param: string,
  value: string,
): { name: string; read: string }[] {
  if (isIdentifier(param)) return [{ name: param.trim(), read: value }];
  const bound = destructuredNames(param);
  if (bound === null) {
    fail(
      `\`<for>\`: the parameter \`${param}\` cannot be bound on this host, because Solid passes it as an accessor and this pattern has no single member read (a rest element, or a pattern that does not parse); bind it whole and read it in the body`,
      node,
    );
  }
  return bound.map((name) => ({
    name: name.name,
    read: `${value}${name.path}`,
  }));
}

/**
 * The callback parameter list for a `<For>`, rewriting the body for each
 * parameter Solid hands as an accessor.
 *
 * A parameter that is a plain identifier keeps its name and its reads become
 * calls (`p` -> `p()`). A **destructuring pattern** cannot: Solid passes a
 * function, and destructuring one throws "not iterable". Such a parameter
 * becomes a gensym accessor and every name it bound reads a member of the
 * call (`{ name }` -> `mxRow().name`).
 */
function accessorParams(
  node: Extract<IrNode, { kind: "For" }>,
  slots: readonly { param: string | undefined; accessor: boolean }[],
): string[] {
  const params: string[] = [];
  const reads: { name: string; read: string }[] = [];
  const generated: string[] = [];
  for (const { param, accessor } of slots) {
    if (param === undefined) continue;
    if (!accessor) {
      params.push(param);
      continue;
    }
    if (isIdentifier(param)) {
      params.push(param.trim());
      reads.push({ name: param.trim(), read: `${param.trim()}()` });
      continue;
    }
    const row = gensym("mxRow", node, generated);
    generated.push(row);
    params.push(row);
    reads.push(...readsForParam(node, param, `${row}()`));
  }
  rewriteForBody(node, reads, generated);
  return params;
}

function isIdentifier(text: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text.trim());
}

/** Solid JSX text emitter over the shared core IR. */
export class SolidEmitter implements Emitter<string> {
  readonly #out: MappedCode[] = [];

  text(node: Extract<IrNode, { kind: "Text" }>): void {
    this.#out.push(concatMapped(escapeText(node.value)));
  }

  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void {
    if (!node.escaped) fail("raw placeholder must be the only child", node);
    this.#out.push(concatMapped(`{${node.expr.code}}`));
  }

  element(node: Extract<IrNode, { kind: "Element" }>): void {
    const raw = rawChild(node.children);
    rejectMixedRaw(node.children);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }
    const attrs = renderAttrs(node.attrs);
    const innerHtml = raw ? ` innerHTML={${raw.expr.code}}` : "";
    if (node.void) {
      this.#out.push(concatMapped(`<${node.name}`, attrs, `${innerHtml} />`));
      return;
    }
    const children = raw ? concatMapped() : renderWithNewEmitter(node.children);
    this.#out.push(
      concatMapped(
        `<${node.name}`,
        attrs,
        `${innerHtml}>`,
        children,
        `</${node.name}>`,
      ),
    );
  }

  component(node: Extract<IrNode, { kind: "Component" }>): void {
    if (node.target.kind === "dynamic") {
      this.#dynamicComponent(node, node.target.expr);
      return;
    }
    const name = node.target.name;
    const contentNodes = node.content?.children ?? [];
    const raw = node.content ? rawChild(contentNodes) : null;
    rejectMixedRaw(contentNodes);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }

    const attrs = renderAttrs(node.attrs, true);
    const tags = concatMapped(...node.attributeTags.map(attributeTag));
    const innerHtml = raw ? ` innerHTML={${raw.expr.code}}` : "";
    // A `/var` on a returning unit rides along as a callback prop, and the
    // JSX stays JSX: this host calls components through JSX, so the value
    // channel has to be a prop rather than a destructured return (§2.4).
    // The `let` the callback assigns is declared by the module assembly,
    // before the JSX that runs it.
    if (node.var && lazyScope) {
      // The `let` this host declares sits at the component's head, so one
      // binding would be shared by every `<For>` row and read before a
      // `<Show>` body's child had set it. Invariant §7.5-8 rejects the
      // escape rather than emitting either.
      fail(
        `\`/var\` on \`<${node.authoredName ?? name}>\` inside \`<for>\`/\`<if>\` is not supported on Solid yet; bind it at the top level of the template`,
        node,
      );
    }
    const returnProp = node.var
      ? ` ${MX_RETURN_PROP}={($mxV) => { ${node.var} = $mxV; }}`
      : "";
    if (node.var) returnVars?.add(node.var);
    if (!node.content || raw) {
      this.#out.push(
        concatMapped(
          "<",
          mapped(name, node.nameSpan),
          attrs,
          tags,
          `${returnProp}${innerHtml} />`,
        ),
      );
      return;
    }

    const body = inLazyScope(() => blockExpression(contentNodes));
    const children = node.content.hasParams
      ? concatMapped(`{(${node.content.params.join(", ")}) => `, body, "}")
      : inLazyScope(() => renderWithNewEmitter(contentNodes));
    this.#out.push(
      concatMapped(
        "<",
        mapped(name, node.nameSpan),
        attrs,
        tags,
        `${returnProp}>`,
        children,
        `</${name}>`,
      ),
    );
  }

  /**
   * A dynamic-target `Component` — `<${expr} .../>` or a bare `${expr}`
   * line — is polymorphic at run time, the same as `@mxlang/html`'s
   * `renderDynamic` and `@mxlang/preact`'s inlined `mxDynamic`: the target
   * can be a tag-name string, a component function, or already-rendered
   * content (e.g. a caller's `content` prop) passed straight through rather
   * than called again. Solid's own `<Dynamic component=…>` only accepts the
   * first two (`ValidComponent = IntrinsicElement | Component<any> |
   * string`); handing it a rendered node throws at render time.
   *
   * A `.solid.mx` *region* is an expression, not a module — `compileSolidMx`
   * refuses any module-level statement inside one — so there is nowhere to
   * hoist a named helper function the way the whole-file HTML/Preact hosts
   * do. The dispatch is inlined as an IIFE per call site instead, still with
   * no runtime import.
   */
  #dynamicComponent(
    node: Extract<IrNode, { kind: "Component" }>,
    expr: Expr,
  ): void {
    const contentNodes = node.content?.children ?? [];
    const raw = node.content ? rawChild(contentNodes) : null;
    rejectMixedRaw(contentNodes);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }

    const attrs = renderAttrs(node.attrs, true);
    const tags = concatMapped(...node.attributeTags.map(attributeTag));
    const innerHtml = raw ? ` innerHTML={${raw.expr.code}}` : "";
    if (node.var && lazyScope) {
      fail(
        `\`/var\` on a dynamic tag inside \`<for>\`/\`<if>\` is not supported on Solid yet; bind it at the top level of the template`,
        node,
      );
    }
    const returnProp = node.var
      ? ` ${MX_RETURN_PROP}={($mxV) => { ${node.var} = $mxV; }}`
      : "";
    if (node.var) returnVars?.add(node.var);
    const temp = `$mxDyn${dynSerial.n++}`;
    const component = ` component={${temp}}`;
    const guard = (rendered: MappedCode | string) =>
      concatMapped(
        `{(() => { const ${temp} = `,
        expr.code,
        `; return typeof ${temp} === "string" || typeof ${temp} === "function" ? `,
        rendered,
        ` : ${temp}; })()}`,
      );
    if (!node.content || raw) {
      this.#out.push(
        guard(
          concatMapped(
            "<Dynamic",
            component,
            attrs,
            tags,
            `${returnProp}${innerHtml} />`,
          ),
        ),
      );
      return;
    }

    const body = inLazyScope(() => blockExpression(contentNodes));
    const children = node.content.hasParams
      ? concatMapped(`{(${node.content.params.join(", ")}) => `, body, "}")
      : inLazyScope(() => renderWithNewEmitter(contentNodes));
    this.#out.push(
      guard(
        concatMapped(
          "<Dynamic",
          component,
          attrs,
          tags,
          `${returnProp}>`,
          children,
          "</Dynamic>",
        ),
      ),
    );
  }

  ifChain(node: Extract<IrNode, { kind: "IfChain" }>): void {
    const conditioned = node.branches.filter((branch) => branch.condition);
    const fallback = node.branches.find((branch) => !branch.condition);
    const renderShow = (
      index: number,
      finalFallback: MappedCode | null,
    ): MappedCode => {
      const branch = conditioned[index];
      if (!branch?.condition) return finalFallback ?? concatMapped("<></>");
      const next =
        index + 1 < conditioned.length
          ? renderShow(index + 1, finalFallback)
          : finalFallback;
      const fallbackAttr =
        next === null ? concatMapped() : concatMapped(" fallback={", next, "}");
      return concatMapped(
        `<Show when={${branch.condition.code}}`,
        fallbackAttr,
        ">",
        inLazyScope(() => blockExpression(branch.children)),
        "</Show>",
      );
    };
    const fallbackCode = fallback
      ? inLazyScope(() => blockExpression(fallback.children))
      : null;
    if (conditioned.length <= 2) {
      this.#out.push(renderShow(0, fallbackCode));
      return;
    }
    const fallbackAttr = fallbackCode
      ? concatMapped(" fallback={", fallbackCode, "}")
      : concatMapped();
    const matches = concatMapped(
      ...conditioned.map((branch) =>
        concatMapped(
          `<Match when={${branch.condition?.code}}>`,
          inLazyScope(() => blockExpression(branch.children)),
          "</Match>",
        ),
      ),
    );
    this.#out.push(
      concatMapped("<Switch", fallbackAttr, ">", matches, "</Switch>"),
    );
  }

  forLoop(node: Extract<IrNode, { kind: "For" }>): void {
    const [first = "item", second] = node.params;
    if (node.source.kind === "of") {
      let keyed: string;
      if (!node.key) keyed = "";
      else if (node.key.shape === "string") {
        const field =
          node.key.node?.type === "StringLiteral"
            ? node.key.node.value
            : node.key.code.replace(/^['"]|['"]$/g, "");
        keyed = ` keyed={x => x.${field}}`;
      } else if (node.key.code.trim() === "identity") keyed = "";
      else keyed = ` keyed={${node.key.code}}`;

      // Which parameters Solid hands as accessors follows the keying mode
      // (`solid-js/types/client/flow.d.ts`): with no `keyed` prop the row is
      // a value and only the index is an accessor; with `keyed={fn}` both
      // are. Every read of an accessor-backed param is rewritten to call it,
      // so the read happens inside Solid's tracking scope and stays live when
      // a same-key row is replaced.
      const rowIsAccessor = keyed !== "";
      const params = accessorParams(node, [
        { param: first, accessor: rowIsAccessor },
        { param: second, accessor: true },
      ]);
      this.#out.push(
        concatMapped(
          `<For each={${node.source.list.code}}${keyed}>{(${params.join(", ")}) => `,
          inLazyScope(() => blockExpression(node.children)),
          "}</For>",
        ),
      );
      return;
    }
    if (node.source.kind === "in") {
      // `Object.entries` plus `keyed={e => e[0]}` means Solid hands the whole
      // entry as one accessor, so the pair cannot be destructured in the
      // parameter list — destructuring a function throws "not iterable". The
      // callback takes one gensym instead and each name reads through it.
      //
      // Each half goes through the same param handling as `of=`, because a
      // half may itself be a pattern: `<for|{a}, v| in=obj>` must resolve `a`
      // to `mxEntry()[0].a`, not drop `{a}` from the parameter list and leave
      // `a` a free reference that still compiles.
      const entry = gensym("mxEntry", node, [first, second ?? ""]);
      rewriteForBody(
        node,
        [
          ...readsForParam(node, first, `${entry}()[0]`),
          ...(second ? readsForParam(node, second, `${entry}()[1]`) : []),
        ],
        [entry],
      );
      this.#out.push(
        concatMapped(
          `<For each={Object.entries(${node.source.object.code})} keyed={e => e[0]}>{(${entry}) => `,
          inLazyScope(() => blockExpression(node.children)),
          "}</For>",
        ),
      );
      return;
    }
    const body = inLazyScope(() => blockExpression(node.children));

    const from = node.source.from?.code ?? "0";
    const bound = node.source.bound.code;
    const fromValue = node.source.from ? numericValue(node.source.from) : 0;
    const boundValue = numericValue(node.source.bound);
    const step = node.source.step;
    if (!step) {
      const count =
        fromValue !== null && boundValue !== null
          ? String(
              node.source.inclusive
                ? boundValue - fromValue + 1
                : boundValue - fromValue,
            )
          : node.source.inclusive
            ? `(${bound}) - (${from}) + 1`
            : `(${bound}) - (${from})`;
      const fromAttr = node.source.from ? ` from={${from}}` : "";
      this.#out.push(
        concatMapped(
          `<Repeat count={${count}}${fromAttr}>{(${node.params.join(", ")}) => `,
          body,
          "}</Repeat>",
        ),
      );
      return;
    }

    const stepValue = numericValue(step);
    if (stepValue === 0) {
      rawFail("`<for step=...>`: step must not be 0", step.node);
    }
    let count: string;
    if (fromValue !== null && boundValue !== null && stepValue !== null) {
      const ratio = (boundValue - fromValue) / stepValue;
      count = String(
        Math.max(
          0,
          node.source.inclusive ? Math.floor(ratio) + 1 : Math.ceil(ratio),
        ),
      );
    } else {
      const rounded = `${node.source.inclusive ? "Math.floor" : "Math.ceil"}(((${bound}) - (${from})) / (${step.code}))${node.source.inclusive ? " + 1" : ""}`;
      count = `Number.isFinite(${rounded}) ? Math.max(0, ${rounded}) : 0`;
    }
    const counter = hygienicIndex(node.params, body.code);
    this.#out.push(
      concatMapped(
        `<Repeat count={${count}}>{(${counter}) => { const ${first} = (${from}) + ${counter} * (${step.code}); return `,
        body,
        "; }}</Repeat>",
      ),
    );
  }

  define(node: Extract<IrNode, { kind: "Define" }>): void {
    fail(
      "`<define>` cannot declare a function inside a JSX expression; declare it in the surrounding TypeScript module",
      node,
    );
  }

  constant(node: Extract<IrNode, { kind: "Const" }>): void {
    fail(
      "`<const>` cannot declare a binding inside a JSX expression; declare it in the surrounding TypeScript module",
      node,
    );
  }

  hoisted(node: Extract<IrNode, { kind: "Hoisted" }>): void {
    fail("a hoisted statement cannot be emitted inside a JSX expression", node);
  }

  hostTag(node: Extract<IrNode, { kind: "HostTag" }>): void {
    const data = node.tag.data as TryData;
    if (data.kind !== "try") fail("unknown Solid host-tag lowering", node);
    const catchTag = node.tag.attributeTags.find((tag) => tag.name === "catch");
    const placeholder = node.tag.attributeTags.find(
      (tag) => tag.name === "placeholder",
    );
    const fallback = placeholder
      ? concatMapped(
          " fallback={",
          blockExpression(placeholder.block.children),
          "}",
        )
      : concatMapped();
    const loading = concatMapped(
      "<Loading",
      fallback,
      ">",
      renderWithNewEmitter(node.tag.children),
      "</Loading>",
    );
    if (!catchTag) {
      this.#out.push(loading);
      return;
    }
    const params = catchTag.block.params.join(", ");
    const caught = blockExpression(catchTag.block.children);
    this.#out.push(
      concatMapped(
        `<Errored fallback={(${params}) => `,
        caught,
        "}>",
        loading,
        "</Errored>",
      ),
    );
  }

  documentType(node: Extract<IrNode, { kind: "DocumentType" }>): void {
    fail("a document type cannot appear inside a JSX expression", node);
  }

  comment(_node: Extract<IrNode, { kind: "Comment" }>): void {}

  done(): string {
    return this.result().code;
  }

  result(): MappedCode {
    return concatMapped(...this.#out);
  }
}

export function createEmitter(): SolidEmitter {
  return new SolidEmitter();
}

export function emitSolid(ir: Ir): string {
  const emitter = createEmitter();
  drive(emitter, ir.body);
  return emitter.done();
}

export function emitSolidWithMappings(ir: Ir): MappedCode {
  const emitter = createEmitter();
  drive(emitter, ir.body);
  return emitter.result();
}
