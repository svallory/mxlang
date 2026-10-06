import { parse as parseBabel, parseExpression } from "@babel/parser";
import {
  type Attr,
  type AttributeTag,
  type AttributeTagNode,
  type AttrTagProp,
  type ComponentTarget,
  type Ctx,
  cloneIr,
  concatMapped,
  contractDefaultTag,
  destructuredNames,
  drive,
  type Emitter,
  type Expr,
  type ForHead,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type MappedCode,
  mapped,
  mappedExpr,
  mappedRewrite,
  type Node,
  type Position,
  type ReadRewrite,
  rewriteAccessorReads,
  TranslateError,
  unresolvedCustomTagMessage,
} from "@mxlang/core";
import { SOLID_BUILTIN_TAGS } from "@mxlang/parser";
import { decodeHTML } from "entities";
import {
  MX_ATTR_SPREAD_BINDING,
  MX_ATTR_VALUE_BINDING,
  MX_CLASS_BINDING,
  MX_TEXTAREA_CONTENT_BINDING,
  MX_TEXTAREA_DYN_SPREAD_BINDING,
  MX_TEXTAREA_DYN_VALUE_BINDING,
  MX_TEXTAREA_OMIT_BINDING,
  MX_TEXTAREA_PICK_BINDING,
} from "./attr-guard.ts";
import { solidEventPropName } from "./event-names.ts";

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
 * Carries the `__mx` prefix every generated *binding* here uses, so it cannot
 * collide with a prop an author declares in the unit's own `Input`. (It is a
 * property name, not a binding, so it is the one name that is not simply
 * `__mx`-reserved.)
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

/** Whether the current module needs Solid's server-only HTML escape helper. */
let escapeUse: { used: boolean } | null = null;

/** Which native-attribute guard helpers the current module needs. */
let attrGuardUse: {
  value: boolean;
  spread: boolean;
  klass: boolean;
  textarea: boolean;
  dynTextarea: boolean;
} | null = null;

/**
 * Native props with genuine non-attribute semantics on Solid. Everything else
 * is validated like Marko, which exempts no name: `innerHTML`, `textContent`,
 * `classList` (not a Solid prop, so a plain attribute) and `:foo` (`value:foo`)
 * all render `[object Object]` unguarded.
 */
const UNGUARDED_ATTRS = new Set(["class", "style", "ref", "children"]);

/**
 * Solid prop namespaces that are not attribute writes: `on:`/`oncapture:`
 * listeners and `prop:` (a real property write). `attr:`, `bool:` and `use:`
 * lower to `setAttribute` on Solid 2, so they validate like any attribute.
 */
const UNGUARDED_NAMESPACE = /^(?:on|oncapture|prop):/;

/**
 * What a native-attribute guard needs: the JS expression for the tag name, and
 * (for a dynamic tag whose target is only sometimes a string) the condition
 * under which the target is a native element.
 */
interface NativeAttrs {
  tag: string;
  when?: string;
}

/** Hygienic-enough alias shared by emitted expressions and module assembly. */
export const MX_ESCAPE_BINDING = "__mxEscape";

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

/**
 * `<define>`s hoisted to module scope during the current compile (decision
 * 110b), and the gensym'd binding each author name resolves to.
 *
 * A `.solid.mx` **region** is an expression spliced into someone else's
 * module — the same reason `compileSolidMx` hoists a discovered tag's
 * import rather than declaring it in place (`packages/hosts/solid/AGENTS.md`,
 * "A synthesized import..."). A `<define>` the region's own author writes
 * hits the identical wall: `const Row = (item) => <li>...</li>;` has no
 * statement position to live in mid-JSX-expression. It hoists the same way:
 * a gensym'd module-scope function declaration, handed back on
 * `CompileSolidMxResult.hoistedDefines` for the parser bridge to place,
 * exactly like a synthesized import.
 *
 * Module-level for the same reason `returnVars`/`lazyScope` are: this host
 * builds child emitters freely, with no shared instance state, so a
 * `<define>` nested inside another construct's callback would otherwise
 * report into an emitter the module assembly never sees. Collected by
 * `collectReturnVars`, alongside `/var` and the escape-helper flag — one
 * emit pass, not a second walk.
 */
let hoistedDefines: HoistedSolidDefine[] | null = null;

/** One `<define>` hoisted during the current compile. */
export interface HoistedSolidDefine {
  /** The `function __mx_DefineN(params) { return <>...</>; }` text. */
  code: string;
  /** The gensym'd module-scope binding a `Component` call site now uses. */
  binding: string;
}

/**
 * Author `<define>` name -> its gensym'd module-scope binding, for the
 * current compile. A `Component` node whose target is `{ kind: "define" }`
 * still carries the *author's* name (core has no reason to know Solid
 * hoists it), so `component()` looks the printed name up here.
 */
let defineBindings: Map<string, string> | null = null;

/**
 * Mints a fresh module-scope binding for a hoisted `<define>`.
 *
 * Always gensym'd, never the author's own name: unlike an authored import
 * (which a `.solid.mx` module might already have, and which the parser
 * bridge can therefore reuse), nothing outside the region could already
 * declare this binding, so there is no "give it its natural name when safe"
 * case to special-case, only "safe" (see `generatedBinding` in
 * `packages/core/src/template-tag.ts`, the same scheme for a discovered
 * tag's injected import binding). Checked only against names already
 * minted for this compile — a fresh collision with an unrelated name in the
 * surrounding module (outside the region, invisible here) is the same
 * accepted, documented limitation `generatedBinding` already has for
 * imports.
 */
function generatedDefineBinding(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const safe = name.replace(/[^A-Za-z0-9_$]/g, "_");
  const hint = /^[A-Za-z_$]/.test(safe) ? safe : `Tag_${safe}`;
  let n = 0;
  let binding: string;
  do {
    binding = `__mx_Define${hint}${++n}`;
  } while (taken.has(binding));
  return binding;
}

/**
 * Well-known globals a hoisted `<define>` body may reference without that
 * being a region-local closure. Deliberately conservative — the codebase's
 * own rule for this exact tradeoff (`packages/parser/src/index.ts`'s
 * `shadowedNames`): "over-reporting costs one extra positioned error a user
 * can work around (pass it as a param); under-reporting is the silent bug"
 * (wrong code that reads `undefined` at the hoisted function's real, module
 * scope). Not the DOM/browser globals a Solid *client* build also has,
 * since SSR runs under Node/Bun first and this check must hold there too.
 */
const KNOWN_GLOBALS = new Set([
  "undefined",
  "null",
  "true",
  "false",
  "NaN",
  "Infinity",
  "globalThis",
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Reflect",
  "Proxy",
  "Function",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "structuredClone",
]);

/**
 * The free identifiers a hoisted `<define>` body references — everything
 * `blockExpression`'s output reads that is not bound inside that same text.
 *
 * A hand-rolled walk rather than `@mxlang/core`'s `freeIdentifiersIn`: that
 * helper parses with the `typescript` plugin only, so a JSX-shaped
 * `<define>` body (the common case — a `<define>` almost always renders
 * markup) fails to parse there and its `catch` silently returns an empty
 * set, which is exactly the silent-undercount this check exists to prevent.
 * `@babel/parser` is already a direct dependency here; `@babel/traverse` is
 * not, so this walks the tree itself rather than adding one, using the same
 * "collect every binding position, then subtract" shape
 * `packages/parser/src/index.ts`'s `shadowedNames`/`namesIn` already use for
 * an adjacent problem (there: is a name shadowed; here: is a name free).
 *
 * Deliberately coarse, in the safe direction: it tracks *lexical* bindings
 * (function/arrow params, `const`/`let`/`var`, a `catch` param, a `for`
 * loop's own declarator) but does not model hoisting or TDZ order, so a
 * name used before its `const` in the same block is (harmlessly) treated as
 * bound rather than free. It does not resolve `this`/`arguments` (Solid
 * JSX bodies do not use either meaningfully) or handle `var` function-scope
 * hoisting past a block boundary — both push toward *fewer* false
 * "captures" flagged only where they change nothing this check cares about,
 * never toward silently accepting a real capture.
 */
function freeJsxNames(code: string): string[] {
  let file: unknown;
  try {
    file = parseBabel(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      allowReturnOutsideFunction: true,
    });
  } catch {
    // The emitter's own output failed to parse — a bug in this function or
    // in `blockExpression`, not a user-facing capture. Reported as "no
    // captures" here; the region's own re-parse a few lines up the call
    // stack (`mxParseElementAt`) is what actually catches a malformed emit.
    return [];
  }

  const free = new Set<string>();
  const walk = (node: unknown, bound: ReadonlySet<string>): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, bound);
      return;
    }
    const record = node as Record<string, unknown> & { type?: string };

    if (
      (record.type === "Identifier" || record.type === "JSXIdentifier") &&
      typeof record.name === "string"
    ) {
      if (!bound.has(record.name)) free.add(record.name);
      return;
    }
    // A member/attribute property (`o.x`, `<Foo x={1}/>`'s `x`) is not a
    // reference to a binding named `x`.
    if (
      record.type === "MemberExpression" ||
      record.type === "OptionalMemberExpression"
    ) {
      walk(record.object, bound);
      if (record.computed) walk(record.property, bound);
      return;
    }
    if (record.type === "JSXAttribute") {
      walk(record.value, bound);
      return;
    }
    // A JSX element's own tag name is not an identifier *reference*: a
    // lowercase intrinsic (`<li>`) is never a binding at all, and even a
    // capitalized component reference (`<Row>`) is read through its
    // `openingElement.name`/`closingElement.name`, so walking those would
    // double-report it — the attributes/children walk below already visits
    // any real reference inside them.
    if (record.type === "JSXElement") {
      walk(
        (record.openingElement as Record<string, unknown>)?.attributes,
        bound,
      );
      walk(record.children, bound);
      return;
    }
    if (record.type === "JSXFragment") {
      walk(record.children, bound);
      return;
    }
    if (record.type === "JSXExpressionContainer") {
      walk(record.expression, bound);
      return;
    }
    if (
      (record.type === "ObjectProperty" || record.type === "ObjectMethod") &&
      !record.computed
    ) {
      walk(record.value, bound);
      walk(record.body, bound);
      for (const param of (record.params as unknown[] | undefined) ?? []) {
        // Handled by the function-scope branch below when this is a method;
        // params/body are visited together there for a plain ObjectMethod.
        void param;
      }
      return;
    }

    let next = bound;
    const introduce = (names: Iterable<string>) => {
      let widened: Set<string> | null = null;
      for (const introduced of names) {
        widened ??= new Set(next);
        widened.add(introduced);
      }
      if (widened) next = widened;
    };

    switch (record.type) {
      case "FunctionExpression":
      case "FunctionDeclaration":
      case "ArrowFunctionExpression":
      case "ObjectMethod":
      case "ClassMethod":
        introduce(
          bindingNamesOf((record.params as unknown[] | undefined) ?? []),
        );
        break;
      case "Program":
      case "BlockStatement": {
        // A block's own statements share one scope, and a later statement
        // sees an earlier `const`/`let`/`function` — the one case the
        // generic array walk below gets wrong: it hands every array item
        // the *same* `bound`, so `const $mxText0 = x; return $mxText0` was
        // reporting `$mxText0` as free (measured: `escapedBlockValue`'s own
        // generated IIFE body, `{ const $mxText0 = expr; ...; return ...; }`,
        // tripped this before the fix). Statements are walked left to
        // right, widening `scope` as each declaration is seen.
        let scope = bound;
        for (const statement of (record.body as unknown[]) ?? []) {
          walk(statement, scope);
          const s = statement as Record<string, unknown> & { type?: string };
          if (s.type === "VariableDeclaration") {
            scope = new Set([...scope, ...bindingNamesOf([s])]);
          } else if (
            s.type === "FunctionDeclaration" &&
            (s.id as Record<string, unknown> | undefined)?.type === "Identifier"
          ) {
            scope = new Set([...scope, (s.id as { name: string }).name]);
          }
        }
        return;
      }
      case "VariableDeclarator":
        // The initializer is evaluated in the *outer* scope; the id's names
        // become bound for whatever follows, which the caller's sibling
        // walk (over the declarations array, left to right) already gives
        // us via `next` carrying forward.
        walk(record.init, bound);
        introduce(bindingNamesOf([record.id]));
        for (const key of Object.keys(record)) {
          if (key === "loc" || key === "init" || key === "id") continue;
          walk(record[key], next);
        }
        return;
      case "CatchClause":
        if (record.param) introduce(bindingNamesOf([record.param]));
        break;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
        // `left`/`init` may declare a loop-local (`for (const x of xs)`);
        // walked under `next` below like every other child.
        break;
    }

    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      walk(record[key], next);
    }
  };

  walk(file, new Set());
  return [...free];
}

/** Every name a parameter/pattern node binds (params, destructuring). */
function bindingNamesOf(nodes: unknown[]): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown> & { type?: string };
    switch (record.type) {
      case "Identifier":
        if (typeof record.name === "string") out.push(record.name);
        return;
      case "AssignmentPattern":
        visit(record.left);
        return;
      case "RestElement":
        visit(record.argument);
        return;
      case "ArrayPattern":
        for (const element of (record.elements as unknown[]) ?? []) {
          visit(element);
        }
        return;
      case "ObjectPattern":
        for (const prop of (record.properties as unknown[]) ?? []) {
          const p = prop as Record<string, unknown> & { type?: string };
          if (p.type === "RestElement") visit(p);
          else visit(p.value);
        }
        return;
      case "VariableDeclaration":
        for (const decl of (record.declarations as unknown[]) ?? []) {
          const d = decl as Record<string, unknown>;
          visit(d.id);
        }
        return;
      default:
        return;
    }
  };
  for (const node of nodes) visit(node);
  return out;
}

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

/**
 * Runs `emit` while collecting the `/var` names its call sites declare, and
 * the `<define>`s it hoists to module scope.
 *
 * `allowHoist` (default `true`) gates the latter: a **region** compile
 * (`compileSolidMx`) has a surrounding module for the parser bridge to
 * place a hoisted `<define>` in, but a whole-file **unit** compile
 * (`compileSolidUnit`) has no caller that reads `hoistedDefines` at all —
 * passing `false` there keeps `hoistedDefines`/`defineBindings` `null`, so
 * `SolidEmitter.define`'s existing guard still rejects `<define>` with a
 * positioned error instead of hoisting into a list nothing consumes (which
 * emitted a call to an undeclared function — a runtime `ReferenceError`,
 * not a compile error; decision 110b's "positioned error, not wrong code"
 * violated silently before this flag existed).
 */
export function collectReturnVars(
  emit: () => string,
  allowHoist = true,
): {
  code: string;
  vars: string[];
  needsEscapeImport: boolean;
  needsAttrGuard: {
    value: boolean;
    spread: boolean;
    klass: boolean;
    textarea: boolean;
    dynTextarea: boolean;
  };
  hoistedDefines: HoistedSolidDefine[];
} {
  const outer = returnVars;
  const outerEscapeUse = escapeUse;
  const outerAttrGuardUse = attrGuardUse;
  const outerHoistedDefines = hoistedDefines;
  const outerDefineBindings = defineBindings;
  const collected = new Set<string>();
  const collectedEscapeUse = { used: false };
  const collectedAttrGuardUse = {
    value: false,
    spread: false,
    klass: false,
    textarea: false,
    dynTextarea: false,
  };
  const collectedDefines: HoistedSolidDefine[] = [];
  returnVars = collected;
  escapeUse = collectedEscapeUse;
  attrGuardUse = collectedAttrGuardUse;
  hoistedDefines = allowHoist ? collectedDefines : null;
  defineBindings = allowHoist ? new Map() : null;
  try {
    return {
      code: emit(),
      vars: [...collected],
      needsEscapeImport: collectedEscapeUse.used,
      needsAttrGuard: collectedAttrGuardUse,
      hoistedDefines: collectedDefines,
    };
  } finally {
    returnVars = outer;
    escapeUse = outerEscapeUse;
    attrGuardUse = outerAttrGuardUse;
    hoistedDefines = outerHoistedDefines;
    defineBindings = outerDefineBindings;
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

const SOLID_BUILTIN_TAG_NAMES = new Set(
  SOLID_BUILTIN_TAGS.map(({ name }) => name),
);

/**
 * Whether a capitalized tag resolves, per decision 114's ruling (operator,
 * approved): Marko's own rule (a scope binding first, then taglib lookup,
 * else unresolved) applied to `.solid.mx`'s larger scope.
 *
 * By the time core asks `isComponent`, a capitalized name has already failed
 * every *MX-level* route: core structural tags, `<try>` (`isDelegatedTag`), an
 * `import`/`<define>`/`<const>`/tag-param binding local to the region, and a
 * registered custom tag (`packages/core/src/lower.ts`'s precedence order
 * runs all of those first). Two routes remain, neither of them Marko
 * concepts (Marko has no host-native-JSX-passthrough and no
 * spliced-into-someone-else's-module concept), both approved by the
 * operator:
 *
 * - **The surrounding TypeScript module binds the name as a value** — an
 *   import or a top-level `const`/`function`/`class` in the module the
 *   region is embedded in (decision 113's shadowing already applies before
 *   this: `ctx.imports` only contains what is *visible* at this point,
 *   `packages/parser/src/mx/bridge.ts`'s `visibleModuleBindings`). Folded
 *   into `ctx.imports` at the call site (`compileSolidMx`, `index.ts`)
 *   rather than a new `Ctx` field, since core's precedence order already
 *   treats that set as "the file resolves this name to a value" before
 *   `isComponent` is ever asked.
 * - **It is one of Solid's own JSX built-ins** (`SOLID_BUILTIN_TAGS`,
 *   `@mxlang/parser`) — `<Show>`, `<For>`, … — which `@mxlang/solid`'s
 *   emitter prints as a bare tag with no import of its own because the real
 *   Solid build pipeline (`@solidjs/vite-plugin`'s compiler stage)
 *   auto-imports every one it sees, a stage that runs after this compiler
 *   and never inside it.
 *
 * Anything else reaching here is genuinely unresolved: Solid has no
 * taglib-backed `tags/`-discovery channel the way `@mxlang/html`/
 * `@mxlang/preact` do (`ctx.lookup` is never set here — a `.solid.mx` region
 * is a fragment compile, not a whole-Marko-file parse). Core's own
 * `rejectUnknownTag` hook (below) then reports Marko's wording, positioned
 * on the real node.
 *
 * Verified against `@marko/compiler` 5.42.5 / `marko@6.3.51`: an unresolved
 * `<TotallyUndefined/>` (no import, binding, or taglib entry) is a
 * compile-time error, "Unable to find entry point for [custom
 * tag](https://markojs.com/docs/reference/custom-tag#relative-custom-tags)
 * `<TotallyUndefined>`." — identical for a self-closing tag, a tag with a
 * body, and a tag with an attribute (`tag-name-type.ts:95-97`,
 * `custom-tag.ts:398-429`).
 */
function isComponent(name: string, ctx: { imports?: Set<string> }): boolean {
  return (ctx.imports?.has(name) ?? false) || SOLID_BUILTIN_TAG_NAMES.has(name);
}

function rejectUnknownTag(
  name: string,
  node: { loc: Position },
  ctx: Ctx,
): void {
  fail(
    unresolvedCustomTagMessage(name, {
      candidates: [...ctx.imports, ...ctx.defines.keys()],
      hint: `Import it (\`import ${name} from "./${name}.mx"\`) or add \`tags/${name}.mx\`.`,
    }),
    node,
  );
}

/** Resolve-time questions for Solid's JSX target. */
/** Solid's built-in `defaultTag`: the descriptor's field and the ladder's last rung. */
export const DEFAULT_TAG = "div";

export const solidDeclarations: HostDeclarations = {
  name: "@mxlang/solid",
  attrTags: 2,
  // The ladder (decision 145): the parent's contract `defaultTag`, then
  // `mx.<target>.defaultTag`, then the target's built-in (the registry folds
  // the host override into `configured`). This host permits the contract rung:
  // it sets no `allowContractDefaultTag: false`.
  resolveDefaultTag: (_node, parents, context) =>
    contractDefaultTag(parents, context, [DEFAULT_TAG]) ??
    context.configured ??
    DEFAULT_TAG,
  tags: STATEFUL_ERRORS,
  isElement: (name) => !/^[A-Z]/.test(name),
  isComponent,
  rejectUnknownTag,
  isDelegatedTag: (name) => name === "try" || name === "html-comment",
  // `<try>` is a core-owned custom tag (`packages/core/src/builtin-tags.ts`):
  // the shape checks that used to live here — no params, no `/var`, one
  // `<@catch>`, one `<@placeholder>` with no params of its own — are the
  // core's `attributeTags` declaration and the tag's own `transform`. This
  // host only decides how the claimed primitive renders.
  //
  // `<html-comment>` is claimed to be *rejected*, not rendered: JSX has no
  // comment node, so the unclaimed tag fell through to the native-element
  // path and silently rendered a literal `<html-comment>` element where
  // Marko renders `<!--…-->` (jsx-text-entities review, 2026-10-04). Solid's
  // pipeline can no more express a bare comment than Preact's; a positioned
  // refusal replaces the silent wrong render.
  resolveDelegatedTag(name, node): TryData {
    if (name === "html-comment") {
      rawFail(
        "an HTML comment (<html-comment>) cannot appear in a Solid component: JSX has no comment node, so it cannot render Marko's <!--…-->; write the comment in the HTML shell that mounts the app",
        node,
      );
    }
    if (name !== "try") rawFail(`unknown Solid host tag ${name}`, node);
    return { kind: "try" };
  },
  rejectModifier(attr) {
    const replacements: Record<string, string> = {
      on: "`on:x=fn` was removed in Solid 2; use `onX=fn` for a delegated event or `on-x=fn` for a custom event name (Marko rejects this form too)",
    };
    rawFail(
      replacements[attr.name] ??
        `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported by Solid`,
      attr,
    );
  },
  resolveAttributeMethod: () => true,
  scriptletReplacement: (name, keyword) =>
    `declare it in the surrounding TypeScript module (\`${keyword} ${name} = …;\`)`,
};

/** Intrinsic children stay in an HTML template; other text is a lazy value. */
type TextContext = "template" | "expression";

/**
 * Escapes text for a JSX child position *inside an intrinsic element's
 * template* (the `"template"` context).
 *
 * `{` and `}` open and close an expression container, and `<` starts a JSX
 * element (a lone `>` is legal JSX text but is escaped with the rest so the
 * whole run stays uniform), so these characters become numeric character
 * references; left raw they would be parsed as markup and either fail to
 * compile or silently swallow the text. In this context `@solidjs/babel-plugin`
 * keeps the authored spelling inside the element's HTML template, and the
 * browser (parsing the SSR string or cloning the DOM template) decodes it
 * with full HTML5 rules — exactly Marko's own model, so authored entities
 * (`&copy 2026`, `&check;`, `&#123`, surrogate references) render as the
 * browser decodes them. No compile-time entity decoding happens here; that
 * is deliberate, and the numeric references this function emits round-trip
 * the same way.
 */
function escapeText(value: string): string {
  return value.replace(/[{}<>]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Outside an intrinsic template, Solid's JSX transform decodes authored text
 * into strings that SSR can treat as trusted HTML. Decode with HTML5 rules
 * ourselves (including surrogate replacement), then use the same lazy,
 * build-conditioned escaping as escapedBlockValue: server `escape` returns
 * escaped HTML; browser `escape` returns undefined and we retain decoded text.
 * A block-bodied accessor avoids the plugin's literal/IIFE escaping paths,
 * which differ between Show, For, Loading and fallback positions. Real SSR
 * and jsdom DOM tests pin single escaping across these positions.
 */
function textExpression(value: string): MappedCode {
  if (escapeUse) escapeUse.used = true;
  const literal = JSON.stringify(decodeHTML(value));
  // Both locals are fresh to this arrow's own scope and never read an
  // authored name, so the reserved `__mx` prefix needs no serial here
  // (unlike `escapedBlockValue`'s, which spans a define body).
  return concatMapped(
    "{() => { const __mxText = ",
    literal,
    `; const __mxEscaped = ${MX_ESCAPE_BINDING}(__mxText); return __mxEscaped === undefined ? __mxText : __mxEscaped; }}`,
  );
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

/**
 * Where the body of a printed method starts: `code` is the `function`
 * expression the compiler printed for an attribute method shorthand
 * (`onClick() { … }` as `function () { … }`), and the parsed function's own
 * body position splits it (a body may hold its own `) {`). `null` when `code`
 * is not one function expression.
 */
function printedBodyStart(code: string): number | null {
  let fn: Node;
  try {
    fn = parseExpression(code, { plugins: ["typescript"] });
  } catch {
    return null;
  }
  if (fn?.type !== "FunctionExpression" || fn.end !== code.length) return null;
  return fn.body.start;
}

/**
 * Whether TypeScript reads `node` as never nullish, so that `?? {}` after it is
 * unreachable (TS2869). This mirrors the checker's own syntactic rule
 * (`getSyntacticNullishnessSemantics`, TypeScript 5.6+) on the Babel node:
 * wrappers (`(…)`, `as`, `satisfies`, `!`, `<T>`) are skipped, a conditional
 * is never nullish when both branches are, and anything that can produce
 * `null`/`undefined` (a name, a call, a member read, `??`/`||`/`&&`, `=`)
 * keeps the operand. Every other expression (a literal, a function, `a + b`)
 * is never nullish.
 */
function neverNullish(node: Node): boolean {
  switch (node?.type) {
    case undefined:
      return false;
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
    case "TSInstantiationExpression":
      return neverNullish(node.expression);
    case "ConditionalExpression":
      return neverNullish(node.consequent) && neverNullish(node.alternate);
    case "SequenceExpression":
      return neverNullish(node.expressions.at(-1));
    case "AssignmentExpression":
      return !["=", "??=", "||=", "&&="].includes(node.operator);
    case "Identifier":
    case "NullLiteral":
    case "ThisExpression":
    case "MemberExpression":
    case "OptionalMemberExpression":
    case "CallExpression":
    case "OptionalCallExpression":
    case "ImportExpression":
    case "NewExpression":
    case "TaggedTemplateExpression":
    case "MetaProperty":
    case "AwaitExpression":
    case "YieldExpression":
    case "LogicalExpression":
      return false;
    default:
      return true;
  }
}

/** Binds looser than `??` (or cannot be mixed with it unparenthesized). */
const LOOSER_THAN_NULLISH = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "AssignmentExpression",
  "SequenceExpression",
  "YieldExpression",
  "ArrowFunctionExpression",
]);

/**
 * A `<for in>` source inside `Object.entries(…)`, defaulted with `?? {}` unless
 * TypeScript reads it as never nullish (it reports the `??` at the author's
 * own expression, TS2869). A nullish source must render nothing, as in Marko,
 * so `null`/`undefined` keep the fallback (TypeScript's TS2871 on that is the
 * author's own degenerate source). A source that binds looser than `??` is
 * parenthesized first: `a || b ?? {}` is a syntax error and `c ? x : y ?? {}`
 * would default only `y`. A comma expression is parenthesized either way,
 * since bare it is two arguments.
 */
function forInSource(source: Expr): (string | MappedCode)[] {
  const prefix = "<For each={Object.entries(";
  const type = source.node?.type;
  const fallback = neverNullish(source.node) ? "" : " ?? {}";
  return fallback === "" && type !== "SequenceExpression"
    ? [prefix, mappedExpr(source)]
    : LOOSER_THAN_NULLISH.has(type)
      ? [`${prefix}(`, mappedExpr(source), `)${fallback}`]
      : [prefix, mappedExpr(source), fallback];
}

/** The guard's tag argument: `null` when the target is not a native element. */
function nativeTagOf(native: NativeAttrs): string {
  return native.when ? `(${native.when} ? ${native.tag} : null)` : native.tag;
}

/** A literal can never render as `[object Object]`, so it needs no guard. */
function isPrimitiveValue(value: Expr): boolean {
  const type = value.node?.type;
  return (
    value.shape === "string" ||
    type === "NumericLiteral" ||
    type === "BooleanLiteral" ||
    type === "NullLiteral" ||
    type === "BigIntLiteral" ||
    type === "TemplateLiteral"
  );
}

/**
 * On a runtime-resolved tag, a `value` that may land on a `<textarea>` gets the
 * server's leading-newline doubling (Marko 6.3.51); other targets are unchanged.
 */
function dynTextareaValue(
  name: string,
  value: string | MappedCode,
  native: NativeAttrs | undefined,
): MappedCode {
  if (name !== "value" || native?.when === undefined) {
    return concatMapped(value);
  }
  if (attrGuardUse) attrGuardUse.dynTextarea = true;
  return concatMapped(
    `${MX_TEXTAREA_DYN_VALUE_BINDING}(`,
    value,
    `, ${native.tag})`,
  );
}

/** A spread (or args object) on a runtime-resolved tag, with the same doubling. */
function dynTextareaSpread(
  value: string | MappedCode,
  native: NativeAttrs | undefined,
): MappedCode {
  if (native?.when === undefined) return concatMapped(value);
  if (attrGuardUse) attrGuardUse.dynTextarea = true;
  return concatMapped(
    `${MX_TEXTAREA_DYN_SPREAD_BINDING}(`,
    value,
    `, ${native.tag})`,
  );
}

function guardValue(
  name: string,
  value: string | MappedCode,
  native: NativeAttrs | undefined,
): MappedCode {
  if (!native) return concatMapped(value);
  return concatMapped(
    `${MX_ATTR_VALUE_BINDING}(${JSON.stringify(name)}, `,
    value,
    `, ${nativeTagOf(native)})`,
  );
}

/**
 * An attribute value's text with its authored mapping. Every function value
 * is emitted as written: a method shorthand as the `function` expression the
 * compiler printed for it (`async function <T>(…) { … }`), which keeps
 * Marko's `this`, its name semantics and valid TSX, and an authored `function`
 * expression or arrow unchanged. A method's printed head is generated text
 * and stays unmapped; its body maps token by token against the authored body
 * (`Expr.bodySpan`/`bodySource`, `mappedRewrite`), also when the printer
 * reformatted it or reads were rewritten.
 */
function mappedValue(expr: Expr): MappedCode {
  const { bodySpan, bodySource } = expr;
  if (!bodySpan || bodySource === undefined) return mappedExpr(expr);
  const at = printedBodyStart(expr.code);
  if (at === null) return concatMapped(expr.code);
  return concatMapped(
    mapped(expr.code.slice(0, at), null),
    mappedRewrite(expr.code.slice(at), bodySource, bodySpan),
  );
}

function renderAttr(
  attr: Attr,
  mapName = false,
  native?: NativeAttrs,
  hasSpread = false,
): MappedCode {
  // JSX only permits one colon with a nonempty suffix. Preserve Marko's
  // `value:` and `value:foo:bar` names as string keys in a prop spread.
  if (
    attr.kind !== "spread" &&
    attr.kind !== "bound" &&
    attr.kind !== "event" &&
    attr.name.includes(":") &&
    !/^[^:]+:[^:]+$/.test(attr.name)
  ) {
    const value =
      attr.kind === "static"
        ? mapped(JSON.stringify(attr.value), attr.valueSpan ?? null)
        : attr.kind === "boolean"
          ? concatMapped("true")
          : mappedValue(attr.value);
    const guardedColon =
      native !== undefined &&
      attr.kind === "dynamic" &&
      !isPrimitiveValue(attr.value) &&
      !UNGUARDED_NAMESPACE.test(attr.name);
    if (guardedColon && attrGuardUse) attrGuardUse.value = true;
    return concatMapped(
      " {...{",
      // Unlike an ordinary intrinsic prop, this authored string key must
      // retain its name mapping even when native prop-name mapping is off.
      mapped(JSON.stringify(attr.name), attr.nameSpan ?? null),
      ": (",
      guardedColon && native
        ? concatMapped(
            `${MX_ATTR_VALUE_BINDING}(${JSON.stringify(attr.name)}, `,
            value,
            `, ${nativeTagOf(native)})`,
          )
        : value,
      ")}}",
    );
  }
  switch (attr.kind) {
    case "spread": {
      if (native === undefined) {
        return concatMapped(" {...", mappedExpr(attr.value), "}");
      }
      if (attrGuardUse) attrGuardUse.spread = true;
      return concatMapped(
        " {...",
        dynTextareaSpread(
          concatMapped(
            `${MX_ATTR_SPREAD_BINDING}(`,
            mappedExpr(attr.value),
            `, ${nativeTagOf(native)})`,
          ),
          native,
        ),
        "}",
      );
    }
    case "boolean":
      return concatMapped(
        " ",
        mapped(attr.name, mapName ? attr.nameSpan : null),
        "={true}",
      );
    case "static":
      if (attr.name === "value" && native?.when !== undefined) {
        return concatMapped(
          " ",
          mapped(attr.name, mapName ? attr.nameSpan : null),
          "={",
          dynTextareaValue("value", JSON.stringify(attr.value), native),
          "}",
        );
      }
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
    // DOM event name core resolved, never the authored spelling, so
    // `onDblClick` and `on-dblclick` emit byte-identically. `solidEventPropName`
    // looks up `@solidjs/web`'s own declared spelling (`onDblClick`,
    // `onKeyDown`, vendored in `event-names.ts`) rather than capitalizing
    // just the first letter: Solid's runtime lowercases whatever follows
    // `on` regardless of casing, so both spellings bind the same DOM event,
    // but only the declared one satisfies `jsx.d.ts`'s exact prop-name keys
    // (else TS2322, since e.g. `onDblclick` is not a key `HTMLAttributes`
    // declares). Solid has no custom-event prop (its own types only declare
    // the DOM names), so a name JSX cannot spell as one identifier — a
    // custom DOM event such as `my-event` from `on-my-event` — is a
    // positioned error naming the `ref` route, the same escape hatch Solid's
    // own docs give for listener options.
    case "event": {
      if (!/^[A-Za-z0-9]+$/.test(attr.event)) {
        return fail(
          `\`${attr.name}\` names a custom DOM event (\`${attr.event}\`) Solid cannot bind as a prop; use a \`ref\` callback calling \`addEventListener("${attr.event}", fn)\``,
          attr,
        );
      }
      const prop = solidEventPropName(attr.event);
      return concatMapped(
        " ",
        mapped(prop, null),
        "={",
        mappedValue(attr.value),
        "}",
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
      const value = mappedValue(attr.value);
      // Marko omits a falsy primitive class and prints `true`; Solid's own
      // `class={v}` always prints the attribute, so a non-literal class on a
      // native element becomes a one-key prop object that is empty when omitted.
      if (
        attr.name === "class" &&
        native !== undefined &&
        !isPrimitiveValue(attr.value) &&
        attr.value.shape !== "object" &&
        attr.value.shape !== "array"
      ) {
        if (attrGuardUse) attrGuardUse.klass = true;
        return concatMapped(
          " {...",
          `${MX_CLASS_BINDING}(`,
          value,
          `, ${nativeTagOf(native)})}`,
        );
      }
      // `<input checked=expr>` (no spread on the element) is presence only in
      // Marko: anything but null/undefined/false sets it, 0 and "x" included.
      if (
        attr.name === "checked" &&
        native?.tag === '"input"' &&
        !hasSpread &&
        !isPrimitiveValue(attr.value)
      ) {
        if (attrGuardUse) attrGuardUse.value = true;
        return concatMapped(
          " ",
          mapped(attr.name, mapName ? attr.nameSpan : null),
          "={(",
          guardValue(attr.name, value, native),
          " ?? false) !== false}",
        );
      }
      // A string-shaped value can never render as `[object Object]`, so it
      // compiles exactly as before.
      const guarded =
        native !== undefined &&
        !isPrimitiveValue(attr.value) &&
        !UNGUARDED_ATTRS.has(attr.name) &&
        !UNGUARDED_NAMESPACE.test(attr.name);
      if (guarded && attrGuardUse) attrGuardUse.value = true;
      return concatMapped(
        " ",
        mapped(attr.name, mapName ? attr.nameSpan : null),
        "={",
        dynTextareaValue(
          attr.name,
          guarded ? guardValue(attr.name, value, native) : value,
          native,
        ),
        "}",
      );
    }
  }
}

/**
 * A native `<textarea>`'s `value` is its content (Marko 6.3.51), never an
 * attribute. Returns the attributes to render (the explicit `value` removed,
 * each spread viewed without its `value`) and the content expression: the
 * last `value` in source order across explicit attributes and spreads, or
 * none when the element has a body (a body wins over a spread's value; an
 * explicit value beside a body is the compile error Marko raises).
 */
function textareaContent(node: Extract<IrNode, { kind: "Element" }>): {
  attrs: Attr[];
  content: MappedCode | null;
} {
  const isValue = (attr: Attr): boolean =>
    attr.kind !== "spread" && attr.kind !== "bound" && attr.name === "value";
  const explicit = node.attrs.find(isValue);
  const hasBody = node.children.length > 0;
  if (explicit && hasBody) {
    fail(
      "A textarea cannot have both a value attribute and body content.",
      explicit,
    );
  }
  const hasSpread = node.attrs.some((attr) => attr.kind === "spread");
  if (!explicit && !hasSpread) return { attrs: node.attrs, content: null };
  if (attrGuardUse) attrGuardUse.textarea = true;
  const attrs = node.attrs.flatMap((attr): Attr[] => {
    if (isValue(attr)) return [];
    if (attr.kind !== "spread") return [attr];
    return [
      {
        ...attr,
        value: {
          ...attr.value,
          code: `${MX_TEXTAREA_OMIT_BINDING}(${attr.value.code})`,
          // Generated text wrapped around the author's value: a span over
          // different text would shift the positions inside it.
          span: undefined,
          atoms: undefined,
          unrewrittenCode: undefined,
        },
      },
    ];
  });
  if (hasBody) return { attrs, content: null };
  // Source order decides: a later spread's `value` beats an earlier explicit
  // one and the other way round.
  let value: MappedCode = concatMapped("undefined");
  for (const attr of node.attrs) {
    if (attr.kind === "spread") {
      value = concatMapped(
        `${MX_TEXTAREA_PICK_BINDING}(`,
        value,
        ", ",
        mappedExpr(attr.value),
        ")",
      );
    } else if (isValue(attr)) {
      value =
        attr.kind === "static"
          ? concatMapped(JSON.stringify(attr.value))
          : attr.kind === "boolean"
            ? concatMapped("true")
            : attr.kind === "dynamic"
              ? mappedExpr(attr.value)
              : value;
    }
  }
  return {
    attrs,
    content: concatMapped(`${MX_TEXTAREA_CONTENT_BINDING}(`, value, ")"),
  };
}

function renderAttrs(
  attrs: Attr[],
  mapNames = false,
  native?: NativeAttrs,
): MappedCode {
  const hasSpread = attrs.some((attr) => attr.kind === "spread");
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
    return concatMapped(
      ...attrs.map((attr) => renderAttr(attr, mapNames, native, hasSpread)),
    );
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
        return renderAttr(attr, mapNames, native, hasSpread);
      }
      if (merged === "") return renderAttr(attr, mapNames, native, hasSpread);
      if (attr.value.shape === "array") {
        return concatMapped(
          " ",
          mapped("class", mapNames ? attr.nameSpan : null),
          `={[${JSON.stringify(merged)}, ...`,
          mappedExpr(attr.value),
          "]}",
        );
      }
      return concatMapped(
        " ",
        mapped("class", mapNames ? attr.nameSpan : null),
        `={[${JSON.stringify(merged)}, `,
        mappedExpr(attr.value),
        "]}",
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

/**
 * A raw `$!{}` child normally rides an `innerHTML` prop, but a body with tag
 * params is a callback and Solid has no wrapper-free raw-HTML form to return
 * from one; Marko emits the raw HTML in place. Reject rather than hoist the
 * child onto `innerHTML` with the params unbound.
 */
function rejectRawWithParams(
  content: { hasParams: boolean } | null | undefined,
  raw: Extract<IrNode, { kind: "Interpolation" }> | null,
): void {
  if (raw && content?.hasParams) fail(RAW_WITH_PARAMS_MESSAGE, raw);
}

const RAW_WITH_PARAMS_MESSAGE =
  "`$!{...}` in a body with tag params is not supported on Solid: raw HTML needs an element to carry `innerHTML`; wrap it, e.g. `<div innerHTML=item/>`";

function hasNamedAttr(attrs: Attr[], name: string): boolean {
  return attrs.some((attr) => attr.kind !== "spread" && attr.name === name);
}

function renderWithNewEmitter(
  nodes: IrNode[],
  textContext: TextContext = "expression",
): MappedCode {
  const child = new SolidEmitter(textContext);
  drive(child, nodes);
  return child.result();
}

/**
 * Preserve Solid client values while escaping strings in the SSR build.
 *
 * Solid 2's SSR renderer treats a string returned from a component/function
 * hole as trusted HTML. Its public `escape` export is the real escaper in the
 * server condition and a no-op returning `undefined` in the browser
 * condition, so the fallback preserves the original client value.
 */
function escapedBlockValue(expr: Expr): MappedCode {
  if (escapeUse) escapeUse.used = true;
  const serial = dynSerial.n++;
  const value = `__mxText${serial}`;
  const escaped = `__mxEscaped${serial}`;
  return concatMapped(
    `() => { const ${value} = `,
    mappedExpr(expr),
    `; const ${escaped} = ${MX_ESCAPE_BINDING}(${value}); return ${escaped} === undefined ? ${value} : ${escaped}; }`,
  );
}

function blockExpression(nodes: IrNode[]): MappedCode {
  const content = meaningful(nodes);
  if (content.length === 1) {
    const only = content[0] as IrNode;
    if (only.kind === "Interpolation" && only.escaped) {
      return concatMapped("<>{", escapedBlockValue(only.expr), "}</>");
    }
    if (
      only.kind === "Element" ||
      only.kind === "Component" ||
      only.kind === "IfChain" ||
      only.kind === "For" ||
      only.kind === "DelegatedTag"
    ) {
      return renderWithNewEmitter(content);
    }
  }
  return concatMapped(
    "<>",
    ...content.map((node) =>
      node.kind === "Interpolation" && node.escaped
        ? concatMapped("{", escapedBlockValue(node.expr), "}")
        : renderWithNewEmitter([node]),
    ),
    "</>",
  );
}

/**
 * Makes a rendered body safe to splice where a JSX *value* is required: an
 * arrow body (`=> BODY`), a `fallback={BODY}` attribute value, or a call
 * argument. A body this emitter renders as `{…}` (the inlined dispatch of a
 * dynamic target, `{(() => …)()}`, or a `<define>` call, `{__mx_DefineR1(…)}`)
 * is a JSX expression container, not a value: after `=>` the `{` opens a
 * BLOCK body, so the callback returns `undefined` and the row renders nothing,
 * and inside `fallback={…}` or an argument list it is an object literal, a
 * syntax error. It happens whenever such a node is the SOLE child of a `<for>`
 * row, a render-prop body, a `<try>` placeholder/catch, an attribute tag's
 * renderable or a `<define>` call's body.
 *
 * The wrapper is the `<>…</>` fragment this emitter already uses for a
 * multi-child body (`blockExpression` above), and it is a no-op whenever the
 * body already starts as JSX (`<Tag>…`, `<>…`, `<Dynamic …`), so every
 * wrapped-element shape is byte-identical to what it was.
 */
function jsxValue(body: MappedCode): MappedCode {
  return body.code.trimStart().startsWith("<")
    ? body
    : concatMapped("<>", body, "</>");
}

function attributeTagAttrValue(
  attr: Exclude<Attr, { kind: "spread" }>,
): MappedCode {
  switch (attr.kind) {
    case "boolean":
      return mapped("true", attr.nameSpan);
    case "static":
      return mapped(JSON.stringify(attr.value), attr.nameSpan);
    case "bound":
      return fail(
        "bound attribute (`:=`) is Marko reactive state; use Solid state and an explicit event handler",
        attr,
      );
    case "event":
    case "dynamic":
      if (
        attr.kind === "dynamic" &&
        attr.name === "style" &&
        attr.value.shape !== "object"
      ) {
        return fail("`style=` with a non-object value", attr);
      }
      return attr.value.span
        ? mappedValue(attr.value)
        : mapped(attr.value.code, attr.nameSpan);
  }
}

/**
 * One attribute-tag body in Solid's reusable renderable shape.
 *
 * Measured on Solid 2.0.0-rc.7: an eager JSX value is a DOM node and moves
 * when inserted twice; a getter creates fresh nodes but fails when handed to
 * `<Dynamic component={...}>`; an accessor stays reactive, creates fresh
 * nodes per insertion, and works through both direct insertion and Dynamic.
 * Solid's host renderable is therefore an accessor. Parameters add the outer
 * render-prop function declared by `AttrTagOf`, so `(p) => () => JSX` is the
 * intentional two-function shape.
 */
function attributeTagRenderable(tag: AttributeTag): MappedCode {
  if (!tag.hasBody) return concatMapped("undefined");
  const body = blockExpression(tag.block.children);
  if (!tag.block.hasParams) return concatMapped("() => ", jsxValue(body));
  return concatMapped(
    `(${tag.block.params.join(", ")}) => () => `,
    jsxValue(body),
  );
}

/**
 * One concrete attribute-tag value checked against the callee's declared
 * type.
 *
 * The value is parenthesized before `satisfies` is applied, because
 * `satisfies` binds tighter than an arrow function: `() => x satisfies T`
 * checks the returned `x`, not the accessor. It is applied to each concrete
 * occurrence rather than to a whole singular plan for the same reason, since
 * `test ? a : undefined satisfies T` checks only `undefined`.
 */
function satisfying(
  value: MappedCode,
  valueType: string | undefined,
  span?: AttributeTag["nameSpan"],
): MappedCode {
  return valueType
    ? concatMapped(
        "(((",
        value,
        ") ",
        mapped("satisfies", span ?? null),
        ` ${valueType}) as any)`,
      )
    : value;
}

/**
 * Same check for a data value, an object literal that needs no inner
 * parenthesization guard: `{ ... } satisfies T` has no arrow function or
 * ternary to disambiguate, so one wrapping pair is enough (matching
 * `@mxlang/html`'s `attrTagValue`).
 */
function satisfyingData(
  value: MappedCode,
  valueType: string | undefined,
  span?: AttributeTag["nameSpan"],
): MappedCode {
  return valueType
    ? concatMapped(
        "((",
        value,
        " ",
        mapped("satisfies", span ?? null),
        ` ${valueType}) as any)`,
      )
    : value;
}

function attributeTagValue(
  tag: AttributeTag,
  as: AttrTagProp["as"],
  valueType?: string,
): MappedCode {
  const content = attributeTagRenderable(tag);
  // A bodiless renderable is `undefined`, which is the absence of a value
  // rather than a value of the declared type.
  if (as === "renderable") {
    return tag.hasBody ? satisfying(content, valueType, tag.nameSpan) : content;
  }

  const parts: Array<string | MappedCode> = [];
  for (const attr of tag.attrs) {
    if (parts.length > 0) parts.push(", ");
    if (attr.kind === "spread") parts.push("...", mappedExpr(attr.value));
    else
      parts.push(
        mapped(JSON.stringify(attr.name), attr.nameSpan),
        ": ",
        attributeTagAttrValue(attr),
      );
  }
  for (const prop of tag.attrTagProps) {
    if (parts.length > 0) parts.push(", ");
    parts.push(`${JSON.stringify(prop.name)}: `, attributeTagProp(prop));
  }
  if (parts.length > 0) parts.push(", ");
  parts.push("content: ", content);
  return satisfyingData(
    concatMapped(mapped("{", tag.nameSpan), " ", ...parts, " }"),
    valueType,
    tag.nameSpan,
  );
}

function firstAttributeTag(
  nodes: AttributeTagNode[],
): AttributeTag | undefined {
  for (const node of nodes) {
    if (node.kind === "AttributeTag") return node.tag;
    if (node.kind === "AttributeTagFor") {
      const found = firstAttributeTag(node.nodes);
      if (found) return found;
    } else {
      for (const branch of node.branches) {
        const found = firstAttributeTag(branch.nodes);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function attributeTagSingle(
  nodes: AttributeTagNode[],
  as: AttrTagProp["as"],
  valueType?: string,
): MappedCode {
  if (nodes.length === 0) return concatMapped("undefined");
  const node = nodes[0] as AttributeTagNode;
  if (node.kind === "AttributeTag") {
    return attributeTagValue(node.tag, as, valueType);
  }
  if (node.kind === "AttributeTagFor") {
    return satisfying(
      concatMapped("(", attributeTagFor(node.loop, node.nodes, as), ")[0]"),
      valueType,
      firstAttributeTag(node.nodes)?.nameSpan,
    );
  }
  const parts: Array<string | MappedCode> = [];
  for (const branch of node.branches) {
    if (branch.test) {
      parts.push(
        mappedExpr(branch.test),
        " ? ",
        attributeTagSingle(branch.nodes, as, valueType),
        " : ",
      );
    } else parts.push(attributeTagSingle(branch.nodes, as, valueType));
  }
  if (node.branches.at(-1)?.test) parts.push("undefined");
  return concatMapped(...parts);
}

function hygienicName(
  preferred: string,
  params: readonly string[],
  body: string,
): string {
  const used = identifierNames(`${params.join(" ")} ${body}`);
  if (!used.has(preferred)) return preferred;
  let index = 2;
  while (used.has(`${preferred}${index}`)) index++;
  return `${preferred}${index}`;
}

/**
 * The two bindings an `<for from/to>` mapper names in its own parameter list.
 *
 * `Array.from`'s mapper takes `(value, index)`, and both are in scope for the
 * whole callback body — which is also where the author's own `from`/`to`/
 * `step` expressions are written. A generated `_` or `mxIndex` there
 * therefore *shadowed* an authored binding of the same name, silently:
 * `<for|i| from=mxIndex to=mxIndex+4 step=2>` rendered `0, 3, 6` where the
 * author wrote `10, 12, 14`. `__mx` is reserved by `checkReservedBindings`,
 * so no authored binding can take either name.
 */
const RANGE_MAPPER_UNUSED = "__mxUnused";
const rangeCounter = (params: readonly string[], body: string): string =>
  hygienicName("__mxIndex", params, body);

function attributeTagArrayNode(
  node: AttributeTagNode,
  as: AttrTagProp["as"],
  arrayType?: string,
): MappedCode {
  if (node.kind === "AttributeTag") {
    return concatMapped("[", attributeTagValue(node.tag, as), "]");
  }
  if (node.kind === "AttributeTagFor") {
    return attributeTagFor(node.loop, node.nodes, as, arrayType);
  }
  const parts: Array<string | MappedCode> = [];
  for (const branch of node.branches) {
    if (branch.test) {
      parts.push(
        mappedExpr(branch.test),
        " ? ",
        attributeTagArray(branch.nodes, as, arrayType),
        " : ",
      );
    } else parts.push(attributeTagArray(branch.nodes, as, arrayType));
  }
  if (node.branches.at(-1)?.test) parts.push("[]");
  return concatMapped(...parts);
}

function attributeTagArray(
  nodes: AttributeTagNode[],
  as: AttrTagProp["as"],
  arrayType?: string,
): MappedCode {
  if (nodes.length === 0) return concatMapped("[]");
  return concatMapped(
    "[",
    ...nodes.flatMap((node, index) => {
      const prefix = index === 0 ? "" : ", ";
      return node.kind === "AttributeTag"
        ? [prefix, attributeTagValue(node.tag, as)]
        : [prefix, "...", attributeTagArrayNode(node, as, arrayType)];
    }),
    "]",
  );
}

function attributeTagFor(
  loop: ForHead,
  nodes: AttributeTagNode[],
  as: AttrTagProp["as"],
  arrayType?: string,
): MappedCode {
  const bodyText = nodes.map((node) => JSON.stringify(node)).join(" ");
  const [first = "item", second] = loop.params;
  const source = loop.source;
  const itemIndex =
    source.kind === "of" && second
      ? second
      : hygienicName("mxAttrIndex", loop.params, bodyText);
  const body = attributeTagArray(nodes, as, arrayType);
  const result = (iterable: string, params: string): MappedCode => {
    if (!arrayType) {
      return concatMapped(`${iterable}.flatMap((${params}) => `, body, ")");
    }
    const accumulator = hygienicName(
      "mxAttrTags",
      [...loop.params, itemIndex],
      body.code,
    );
    return concatMapped(
      `${iterable}.reduce<${arrayType}>((${accumulator}, ${params}) => ${accumulator}.concat(((`,
      body,
      `) satisfies ${arrayType}) as any), [])`,
    );
  };
  if (source.kind === "of") {
    const listVar = hygienicName("mxList", loop.params, source.list.code);
    return result(
      `((${listVar}) => ${listVar} ? [...${listVar}] : [])(${source.list.code})`,
      `${first}, ${itemIndex}`,
    );
  }
  if (source.kind === "in") {
    const value =
      second ??
      hygienicName("value", loop.params, `${body.code} ${source.object.code}`);
    return result(
      `Object.entries(${source.object.code} ?? {})`,
      `[${first}, ${value}], ${itemIndex}`,
    );
  }

  const from = source.from?.code ?? "0";
  const bound = source.bound.code;
  const step = source.step;
  const counter = rangeCounter(loop.params, body.code);
  const span = step
    ? `${source.inclusive ? "Math.floor" : "Math.ceil"}(((${bound}) - (${from})) / (${step.code}))${source.inclusive ? " + 1" : ""}`
    : `(${bound}) - (${from})${source.inclusive ? " + 1" : ""}`;
  const value = step
    ? `(${from}) + ${counter} * (${step.code})`
    : `(${from}) + ${counter}`;
  return result(
    `Array.from({ length: Math.max(0, ${span}) }, (${RANGE_MAPPER_UNUSED}, ${counter}) => ${value})`,
    `${first}, ${itemIndex}`,
  );
}

function attributeTagProp(prop: AttrTagProp, owner?: string): MappedCode {
  if (prop.cardinality !== "array") {
    const valueType =
      owner && prop.declared
        ? `NonNullable<Parameters<typeof ${owner}>[0][${JSON.stringify(prop.name)}]>`
        : undefined;
    return attributeTagSingle(prop.source, prop.as, valueType);
  }
  const arrayType =
    owner && prop.declared
      ? `NonNullable<Parameters<typeof ${owner}>[0][${JSON.stringify(prop.name)}]>`
      : undefined;
  const value = attributeTagArray(prop.source, prop.as, arrayType);
  return arrayType
    ? concatMapped("((", value, ` satisfies ${arrayType}) as any)`)
    : value;
}

function attributeTagProps(
  props: AttrTagProp[],
  owner?: string,
  native?: NativeAttrs,
): MappedCode {
  return concatMapped(
    ...props.map((prop) => {
      const first = firstAttributeTag(prop.source);
      if (native && attrGuardUse) attrGuardUse.value = true;
      return concatMapped(
        " ",
        mapped(prop.name, first?.nameSpan ?? null),
        "={",
        native
          ? concatMapped(
              `${MX_ATTR_VALUE_BINDING}(${JSON.stringify(prop.name)}, `,
              attributeTagProp(prop, owner),
              `, ${nativeTagOf(native)})`,
            )
          : attributeTagProp(prop, owner),
        "}",
      );
    }),
  );
}

function identifierNames(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
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
  assignError: (name: string) => string = (name) =>
    `\`<for>\`: \`${name}\` is bound by Solid as an accessor and cannot be assigned; compute a new value instead`,
): void {
  for (const name of generated) {
    if (!node.bindings.includes(name)) node.bindings.push(name);
  }
  const rewrites = new Map<string, ReadRewrite>();
  for (const { name, read } of reads) {
    rewrites.set(name, {
      read,
      assignError: assignError(name),
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
  /** Only direct intrinsic children retain authored HTML template text. */
  readonly #textContext: TextContext;

  constructor(textContext: TextContext = "expression") {
    this.#textContext = textContext;
  }

  text(node: Extract<IrNode, { kind: "Text" }>): void {
    this.#out.push(
      this.#textContext === "template" || !/[&{}<>]/.test(node.value)
        ? concatMapped(escapeText(node.value))
        : textExpression(node.value),
    );
  }

  interpolation(node: Extract<IrNode, { kind: "Interpolation" }>): void {
    if (!node.escaped) {
      fail(
        "`$!{...}` is only supported as the sole child of an element or a tag without params: raw HTML needs an element to carry `innerHTML`; wrap it, e.g. `<div innerHTML=x/>`",
        node,
      );
    }
    this.#out.push(concatMapped("{", mappedExpr(node.expr), "}"));
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
    // `<textarea value=x/>` renders the value as content, as Marko does.
    const textarea =
      node.name === "textarea" ? textareaContent(node) : undefined;
    const attrs = renderAttrs(textarea?.attrs ?? node.attrs, false, {
      tag: JSON.stringify(node.name),
    });
    const innerHtml = raw
      ? concatMapped(" innerHTML={", mappedExpr(raw.expr), "}")
      : concatMapped();
    if (node.void) {
      this.#out.push(concatMapped(`<${node.name}`, attrs, innerHtml, " />"));
      return;
    }
    const children = raw
      ? concatMapped()
      : textarea?.content
        ? concatMapped("{", textarea.content, "}")
        : renderWithNewEmitter(node.children, "template");
    this.#out.push(
      concatMapped(
        `<${node.name}`,
        attrs,
        innerHtml,
        ">",
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
    if (node.target.kind === "define") {
      this.#defineComponent(node, node.target);
      return;
    }
    const name = node.target.name;
    const contentNodes = node.content?.children ?? [];
    const raw = node.content ? rawChild(contentNodes) : null;
    rejectMixedRaw(contentNodes);
    rejectRawWithParams(node.content, raw);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }

    const attrs = renderAttrs(node.attrs, true);
    const tags = attributeTagProps(node.attrTagProps, name);
    const innerHtml = raw
      ? concatMapped(" innerHTML={", mappedExpr(raw.expr), "}")
      : concatMapped();
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
      ? ` ${MX_RETURN_PROP}={(__mxV) => { ${node.var} = __mxV; }}`
      : "";
    if (node.var) returnVars?.add(node.var);
    if (!node.content || raw) {
      this.#out.push(
        concatMapped(
          "<",
          mapped(name, node.nameSpan),
          attrs,
          tags,
          returnProp,
          innerHtml,
          " />",
        ),
      );
      return;
    }

    const body = inLazyScope(() => blockExpression(contentNodes));
    const children = node.content.hasParams
      ? concatMapped(
          `{(${node.content.params.join(", ")}) => `,
          jsxValue(body),
          "}",
        )
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
   * A `<define>` call — `<Row(a)/>`, `<Row it=x/>`, `<Row><@head>H</@head></Row>`.
   *
   * JSX has no positional-call syntax, so unlike a `"name"`-target
   * component (an ordinary `<Tag .../>` element), a hoisted `<define>` is
   * called as a **plain function expression**, `{__mx_DefineRow1(...)}` —
   * exactly `@mxlang/html`'s own `<define>` call shape (decision 109's
   * named-param binding), because a hoisted `<define>` is, at the JS level,
   * exactly what html's already is: an ordinary function, not a Solid
   * component with props. Args fill the declared params positionally; any
   * remaining params are filled by name from attrs/attribute
   * tags/`content`, `undefined` where nothing supplies one. A spread has no
   * meaning here (its keys are only known at run time, and a `<define>` is
   * called positionally) and is rejected the same way html rejects it.
   */
  #defineComponent(
    node: Extract<IrNode, { kind: "Component" }>,
    target: Extract<ComponentTarget, { kind: "define" }>,
  ): void {
    const binding = defineBindings?.get(target.name) ?? target.name;
    const contentNodes = node.content?.children ?? [];
    const raw = node.content ? rawChild(contentNodes) : null;
    rejectMixedRaw(contentNodes);
    rejectRawWithParams(node.content, raw);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }
    if (node.var && lazyScope) {
      fail(
        `\`/var\` on \`<${node.authoredName ?? target.name}>\` inside \`<for>\`/\`<if>\` is not supported on Solid yet; bind it at the top level of the template`,
        node,
      );
    }

    const named = new Map<string, MappedCode>();
    for (const attr of node.attrs) {
      if (attr.kind === "spread") {
        fail(
          `spreading into \`<${target.name}>\` is not supported: a <define> is called positionally, and a spread's keys are only known at run time`,
          attr,
        );
      }
      named.set(attr.name, attributeTagAttrValue(attr));
    }
    for (const prop of node.attrTagProps) {
      named.set(prop.name, attributeTagProp(prop));
    }
    if (node.content) {
      const body = inLazyScope(() => blockExpression(contentNodes));
      named.set(
        "content",
        node.content.hasParams
          ? concatMapped(
              `(${node.content.params.join(", ")}) => `,
              jsxValue(body),
            )
          : jsxValue(body),
      );
    }

    const positional = node.args.map((arg) => mappedExpr(arg));
    const named_ = target.params
      .slice(positional.length)
      .map((param) => named.get(param) ?? concatMapped("undefined"));
    const args = [...positional, ...named_];

    if (node.var) {
      // `/var` on a plain function call has no callback prop to ride: the
      // call itself already hands the value back as its return, so bind it
      // directly rather than inventing a Solid-only prop channel a
      // `<define>`'s hoisted function was never given.
      if (returnVars) returnVars.add(node.var);
      this.#out.push(
        concatMapped(
          "{(() => { const __mxV = ",
          mapped(binding, node.nameSpan),
          "(",
          ...args.flatMap((a, i) => (i === 0 ? [a] : [", ", a])),
          `); ${node.var} = __mxV; return __mxV; })()}`,
        ),
      );
      return;
    }

    this.#out.push(
      concatMapped(
        "{",
        mapped(binding, node.nameSpan),
        "(",
        ...args.flatMap((a, i) => (i === 0 ? [a] : [", ", a])),
        ")}",
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
    rejectRawWithParams(node.content, raw);
    if (raw && hasNamedAttr(node.attrs, "innerHTML")) {
      fail(
        "`$!{...}` sole child combined with an explicit `innerHTML=` attribute",
        raw,
      );
    }

    // A decision-116-routed dynamic target (`valueImportBinding` set) still
    // names a real, in-scope import — the emitted call is
    // `mxDyn0 = AttrCallee; ... <Dynamic component={mxDyn0} .../>`, with
    // `AttrCallee` imported verbatim — so typed attribute-tag checking can
    // still reference it for `Parameters<typeof AttrCallee>[0][...]`,
    // exactly as a `kind: "name"` target does. An author's own `<${expr}/>`
    // (no `valueImportBinding`) has no such name and stays untyped.
    const owner =
      node.target.kind === "dynamic"
        ? node.target.valueImportBinding
        : undefined;
    const innerHtml = raw
      ? concatMapped(" innerHTML={", mappedExpr(raw.expr), "}")
      : concatMapped();
    if (node.var && lazyScope) {
      fail(
        `\`/var\` on a dynamic tag inside \`<for>\`/\`<if>\` is not supported on Solid yet; bind it at the top level of the template`,
        node,
      );
    }
    const returnProp = node.var
      ? ` ${MX_RETURN_PROP}={(__mxV) => { ${node.var} = __mxV; }}`
      : "";
    if (node.var) returnVars?.add(node.var);
    const serial = dynSerial.n++;
    const temp = `__mxDyn${serial}`;
    const value = node.args.length > 0 ? `__mxDynValue${serial}` : temp;
    const invoke =
      node.args.length > 0
        ? ` const ${value} = typeof ${temp} === "function" ? ${temp}(${node.args.map((arg) => arg.code).join(", ")}) : ${temp};`
        : "";
    const component = ` component={${value}}`;
    // Only a string target is a native element: its attributes get the
    // native-attribute guard, a component target's props are forwarded as is.
    const native: NativeAttrs = {
      tag: value,
      when: `typeof ${value} === "string"`,
    };
    const attrs = renderAttrs(node.attrs, true, native);
    // A decision-116 import target is a component, never a native element.
    const tags = attributeTagProps(
      node.attrTagProps,
      owner,
      owner === undefined ? native : undefined,
    );
    // decision 112 (lead ruling 2026-09-28): 109 governs a function/
    // component target called with arguments (`renderer(...args, props)`);
    // 112 governs only a *string* (native-element) target — the two are
    // disjoint, not in conflict. For a string target with arguments, args[0]
    // (Marko's own `args[0] || {}`, `runtime-tags/src/html/dynamic-tag.ts`'s
    // `_dynamic_tag`) becomes the element's attributes *instead of* this
    // call's attribute-tag props, matching html's `renderDynamic` and the
    // shared JSX `mxDynamic`; content still renders regardless, since Marko
    // threads it independently of the input. A function/component target
    // is unaffected: `tags` keeps applying exactly as decision 109 left it.
    // Which branch applies is a run-time fact (`value`'s resolved type), so
    // this emits two `<Dynamic>` elements behind the existing type-switch
    // rather than trying to make one JSX attribute list conditional.
    if (node.args.length > 0 && attrGuardUse) attrGuardUse.spread = true;
    const stringArgsAttrs =
      node.args.length > 0
        ? concatMapped(
            " {...",
            dynTextareaSpread(
              concatMapped(
                `${MX_ATTR_SPREAD_BINDING}(`,
                node.args[0] ? mappedExpr(node.args[0]) : "undefined",
                ` || {}, ${value})`,
              ),
              native,
            ),
            "}",
          )
        : "";
    // decision 116, Marko parity (`runtime-tags/src/html/dynamic-tag.ts`'s
    // `_dynamic_tag`, `normalizeDynamicRenderer`): a target that is neither
    // a string nor a function has no renderer, so the tag itself renders
    // nothing — but its own body content still renders, threaded
    // independently of the target. `fallback` is the plain-JSX rendering of
    // that body (or `null` for a self-closing/no-content call), used only in
    // this else branch; the `<Dynamic>` branches above it are unaffected.
    const guard = (
      rendered: (tagsProps: MappedCode | string) => MappedCode | string,
      fallback: MappedCode | string,
    ) =>
      concatMapped(
        `{(() => { const ${temp} = `,
        mappedExpr(expr),
        `;${invoke} if (${value} !== null && typeof ${value} === "object" && (Object.getPrototypeOf(${value}) === Object.prototype || Object.getPrototypeOf(${value}) === null) && Object.prototype.hasOwnProperty.call(${value}, "content")) throw new Error("MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <\${x.content}/>"); `,
        // Marko: a runtime-resolved textarea takes `value`, never content.
        node.content && !raw
          ? `if (${value} === "textarea") throw new Error("A dynamic tag rendering a \`<textarea>\` cannot have \`content\` and must use the \`value\` attribute instead."); `
          : "",
        node.args.length > 0
          ? concatMapped(
              `return typeof ${value} === "string" ? `,
              rendered(stringArgsAttrs),
              ` : typeof ${value} === "function" ? `,
              rendered(tags),
              ` : `,
              fallback,
              `; })()}`,
            )
          : concatMapped(
              `return typeof ${value} === "string" || typeof ${value} === "function" ? `,
              rendered(tags),
              ` : `,
              fallback,
              `; })()}`,
            ),
      );
    if (!node.content || raw) {
      // No body content to fall back to (a self-closing tag, or content
      // that is already-rendered raw HTML) — the else branch passes the
      // resolved value through unchanged, exactly as before decision 116:
      // a caller reading `input.content` and forwarding it as `<${input.content}/>`
      // must still see a real Solid element pass through here, never `null`.
      this.#out.push(
        guard(
          (tagsProps) =>
            concatMapped(
              "<Dynamic",
              component,
              attrs,
              tagsProps,
              returnProp,
              innerHtml,
              " />",
            ),
          value,
        ),
      );
      return;
    }

    const body = inLazyScope(() => blockExpression(contentNodes));
    const children = node.content.hasParams
      ? concatMapped(
          `{(${node.content.params.join(", ")}) => `,
          jsxValue(body),
          "}",
        )
      : inLazyScope(() => renderWithNewEmitter(contentNodes));
    // The fallback body must not itself declare tag params: those are
    // meaningful only to the resolved component/renderer, which does not
    // exist on this branch. Re-rendered plain, matching `renderWithNewEmitter`
    // above for the no-params case; a parameterized body has no unparameterized
    // form to fall back to, so it renders as an empty fragment instead —
    // Marko itself cannot express this case either (a dynamic-tag body is a
    // Marko-shaped renderer's own callback, never invoked when there is no
    // renderer to invoke it).
    const fallbackBody = node.content.hasParams
      ? concatMapped("<></>")
      : inLazyScope(() => renderWithNewEmitter(contentNodes));
    this.#out.push(
      guard(
        (tagsProps) =>
          concatMapped(
            "<Dynamic",
            component,
            attrs,
            tagsProps,
            `${returnProp}>`,
            children,
            "</Dynamic>",
          ),
        concatMapped("<>", fallbackBody, "</>"),
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
        "<Show when={",
        mappedExpr(branch.condition),
        "}",
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
          "<Match when={",
          branch.condition ? mappedExpr(branch.condition) : "",
          "}>",
          inLazyScope(() => blockExpression(branch.children)),
          "</Match>",
        ),
      ),
    );
    this.#out.push(
      concatMapped("<Switch", fallbackAttr, ">", matches, "</Switch>"),
    );
  }

  forLoop(source: Extract<IrNode, { kind: "For" }>): void {
    // The rewrites below edit `bindings` and every `code` in the body, so they
    // run on a private copy: the IR is read-only to an emitter (ir-spec E21).
    // Copies every `For`, including the plain range form that rewrites nothing:
    // whether a branch rewrites depends on params and keying decided below, so
    // narrowing the copy is not clearly safe; the cost is one compile-time copy.
    const node = cloneIr(source);
    const [first = "item", second] = node.params;
    if (node.source.kind === "of") {
      let keyed: string;
      let keyedAttr: MappedCode | undefined;
      if (!node.key) keyed = "";
      else if (node.key.shape === "string") {
        const field =
          node.key.node?.type === "StringLiteral"
            ? node.key.node.value
            : node.key.code.replace(/^['"]|['"]$/g, "");
        keyed = ` keyed={x => x.${field}}`;
      } else if (node.key.code.trim() === "identity") keyed = "";
      else {
        keyed = ` keyed={${node.key.code}}`;
        keyedAttr = concatMapped(" keyed={", mappedExpr(node.key), "}");
      }

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
          "<For each={",
          mappedExpr(node.source.list),
          "}",
          keyedAttr ?? keyed,
          `>{(${params.join(", ")}) => `,
          jsxValue(inLazyScope(() => blockExpression(node.children))),
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
          ...forInSource(node.source.object),
          `)} keyed={e => e[0]}>{(${entry}) => `,
          jsxValue(inLazyScope(() => blockExpression(node.children))),
          "}</For>",
        ),
      );
      return;
    }
    const from = node.source.from?.code ?? "0";
    const bound = node.source.bound.code;
    const fromValue = node.source.from ? numericValue(node.source.from) : 0;
    const boundValue = numericValue(node.source.bound);
    const step = node.source.step;
    if (!step) {
      const body = inLazyScope(() => jsxValue(blockExpression(node.children)));
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
    // `from` and `step` are evaluated once per (re)render of the loop, like
    // Marko's `_for_to(to, from, step, …)` head, so every read of the row
    // value inside one row agrees even for an impure bound. A
    // non-literal one is bound to constants in an IIFE around the `<Repeat>`:
    // the IIFE re-runs when a signal they read changes, the rows read the
    // constants, and `count` (a prop getter) tracks `to` on its own.
    const literalFrom = fromValue !== null;
    const literalStep = stepValue !== null;
    const literalHead = literalFrom && literalStep;
    const headNames = identifierNames(`${from} ${step.code} ${bound}`);
    const counter = gensym("__mxIndex", node, [...headNames]);
    const fromName = literalFrom
      ? from
      : gensym("__mxFrom", node, [...headNames, counter]);
    const stepName = literalStep
      ? step.code
      : gensym("__mxStep", node, [...headNames, counter, fromName]);
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
      const rounded = `${node.source.inclusive ? "Math.floor" : "Math.ceil"}(((${bound}) - (${fromName})) / (${stepName}))${node.source.inclusive ? " + 1" : ""}`;
      count = `Number.isFinite(${rounded}) ? Math.max(0, ${rounded}) : 0`;
    }
    // The row value is not a callback-local `const`: Solid runs the callback
    // once per row and never again, so a value computed there would freeze
    // the bounds at their first reading. Reads of the param become the
    // expression over the hoisted head, evaluated in the reader's tracking
    // scope.
    rewriteForBody(
      node,
      readsForParam(
        node,
        first,
        `((${fromName}) + ${counter} * (${stepName}))`,
      ),
      [counter],
      (name) =>
        `\`<for>\`: the row value \`${name}\` of a stepped range is computed from its bounds and cannot be assigned; derive a new value instead`,
    );
    const body = inLazyScope(() => jsxValue(blockExpression(node.children)));
    const repeat = concatMapped(
      `<Repeat count={${count}}>{(${counter}) => `,
      body,
      "}</Repeat>",
    );
    this.#out.push(
      literalHead
        ? repeat
        : concatMapped(
            `{(() => { ${[
              literalFrom ? "" : `const ${fromName} = (${from}); `,
              literalStep ? "" : `const ${stepName} = (${step.code}); `,
            ].join("")}return `,
            repeat,
            "; })()}",
          ),
    );
  }

  define(node: Extract<IrNode, { kind: "Define" }>): void {
    if (!hoistedDefines || !defineBindings) {
      // Reached only from `compileSolidUnit` (a whole-file tag, never a
      // region): that path has a real module scope of its own, so hoisting
      // through this channel is unscoped work, not this construct's fix —
      // see `packages/hosts/solid/AGENTS.md`'s `<define>`-in-regions note.
      fail(
        "`<define>` cannot declare a function inside a JSX expression; declare it in the surrounding TypeScript module",
        node,
      );
    }
    if (lazyScope) {
      fail(
        `\`<define>\` inside \`<for>\`/\`<if>\`/another construct's body is not hoisted to module scope; write \`<define/${node.name}>\` at the top level of the region`,
        node,
      );
    }

    const bodyCode = inLazyScope(() =>
      jsxValue(blockExpression(node.children)),
    ).code;
    const bound = new Set(node.params);
    // A call to a sibling define reaches this text as the *gensym'd*
    // binding, not the author's name: `blockExpression` drove the child
    // `<B/>` reference through `#defineComponent`, which already resolved
    // it via `defineBindings`. So the safe-names check here reads
    // `defineBindings`'s *values*, not its keys.
    const hoistedNames = defineBindings
      ? new Set(defineBindings.values())
      : null;
    const captured = freeJsxNames(bodyCode).filter(
      (freeName) =>
        !bound.has(freeName) &&
        !hoistedNames?.has(freeName) &&
        !KNOWN_GLOBALS.has(freeName) &&
        // The escape helper's binding is itself hoisted to module scope
        // (`hoistedImports`, seeded by `needsEscapeImport`) whenever a
        // define body escapes an interpolation, so it is never actually a
        // region-local — it just isn't known to this check by name until
        // the escape flag fires, which already happened by the time this
        // body was rendered (`escapedBlockValue` sets `escapeUse.used`).
        freeName !== MX_ESCAPE_BINDING,
    );
    if (captured.length > 0) {
      fail(
        `\`<define/${node.name}>\` is hoisted to module scope and cannot close over \`${captured[0]}\`, a value local to this region; pass it as a param instead`,
        node,
      );
    }

    // A define can never reference a sibling declared later, or itself
    // (`ctx.defines.set` in core's `lowerDefine` runs only *after* lowering
    // the define's own body — verified against `@mxlang/html`, which
    // rejects the identical source with the same "no matching import or
    // `<define>` in scope" error at lowering time, before any host-specific
    // code runs). So every name `freeJsxNames` can find bound in
    // `defineBindings` above was necessarily minted by an *earlier* call to
    // this method in the same region, and minting this one fresh now can
    // never collide with one still to come.
    const binding = generatedDefineBinding(
      node.name,
      new Set(defineBindings.values()),
    );
    defineBindings.set(node.name, binding);
    hoistedDefines.push({
      code: `function ${binding}(${node.params.join(", ")}) { return ${bodyCode}; }`,
      binding,
    });
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

  delegatedTag(node: Extract<IrNode, { kind: "DelegatedTag" }>): void {
    const data = node.tag.data as TryData;
    if (data.kind !== "try") fail("unknown Solid host-tag lowering", node);
    const catchTag = node.tag.attributeTags.find((tag) => tag.name === "catch");
    const placeholder = node.tag.attributeTags.find(
      (tag) => tag.name === "placeholder",
    );
    const fallback = placeholder
      ? concatMapped(
          " fallback={",
          jsxValue(blockExpression(placeholder.block.children)),
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
    const caught = jsxValue(blockExpression(catchTag.block.children));
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
