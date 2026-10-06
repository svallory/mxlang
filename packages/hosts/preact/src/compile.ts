/**
 * The preact host's compile entry, as a **descriptor-free leaf**.
 *
 * `descriptor.ts` must stay a leaf: it is a bundler entry
 * (`@mxlang/preact/descriptor`) and the registry bundles it into tools, so it
 * may never `require` a module that (transitively) imports it. The compile
 * entry — and the module emitter behind it, since nothing else here depends
 * on the descriptor either — therefore lives in this leaf, and both
 * `index.ts` (which composes the package's own lookup and the public
 * `compilePreactMx` default) and `descriptor.ts` (which composes a lookup
 * over itself, lazily) call in with an explicit lookup.
 *
 * Revision BUG 1 (rev-245 §1): when the descriptor reached the compile entry
 * through `require("./index.ts")` and the index imported the descriptor back,
 * Bun's multi-entry build silently dropped the index entry with exit 0 on the
 * pinned Bun 1.3.14. The acyclic graph is what makes a bundler keep every
 * entry (`packages/target-registry/src/bundle-smoke.test.ts` pins it).
 */

import { readFileSync } from "node:fs";
import {
  type CompileResult,
  type CustomTag,
  compileSource,
  concatMapped,
  drive,
  type GeneratedMapping,
  type HostDeclarations,
  type Ir,
  type IrNode,
  importedNames,
  type MappedCode,
  type MxWarning,
  moduleExportName,
  type TargetLookup,
  TranslateError,
} from "@mxlang/core";
import {
  JSX_ATTRIBUTE_SPREAD_EXPRESSION,
  jsxAttrValueExpression,
  jsxTextareaContentExpression,
  jsxTextareaPropsExpression,
} from "./attribute-normalize.ts";
import { type JsxDialect, preactDialect } from "./dialect.ts";
import {
  componentAlias,
  createEmitter,
  preactDeclarations,
} from "./emitter.ts";

/**
 * Marko's own convention: `@marko/compiler`'s `scanTagsDir` only
 * auto-discovers files whose extension is literally `.marko` (measured in
 * 5.42.5's `loadTaglibFromDir.js`, `ext === ".marko"`), so a `tags/*.marko`
 * file is callable as a tag with no import. A `.mx` file in `tags/` is not
 * discovered. Kept because this is a host for stock Marko syntax, the same
 * as `@mxlang/html`.
 */
export const host = {
  tagDiscoveryDirs: ["tags"],
};

export interface CompilePreactOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /** `package.json#mx.<target>.defaultTag`, already validated (decision 145). */
  defaultTag?: string;
  /**
   * The registered targets this compile runs under. Defaults to this
   * package's own descriptor (right for a direct entry); a tool that
   * compiles for several targets passes the built-in registry's lookup, so a
   * callee importing `AttrTag` from another registered target's package reads
   * the same as it does today.
   */
  targets?: TargetLookup;
  /**
   * The JSX dialect to emit for. Defaults to Preact; a React package passes its
   * own so it can reuse this emitter rather than fork it.
   */
  dialect?: JsxDialect;
  /** Resolve-time declarations paired with a custom JSX dialect. */
  declarations?: HostDeclarations;
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  /** Positioned non-fatal diagnostics collected by editor/build tooling. */
  warnings?: MxWarning[];
  /**
   * Internal, for tooling only (decision 140). Emits the module for type
   * checking, not for running: every native element's event handler is
   * checked with `(fn) satisfies Handler<"tag", "event">`, a type-only
   * expression that resolves the host's own handler type, and Marko keeps the
   * TypeScript annotations of shorthand handlers. The wrapper and its
   * type-only preamble are erased by TypeScript's emit, so `mx-tsc` output
   * stays runnable. Leave unset for any build; the normal output is unchanged.
   */
  typeCheck?: boolean;
}

/**
 * Which of the emitted module's top-level bindings each import supplies.
 *
 * `Fragment` comes from the JSX runtime's own package, the `<try>` helpers
 * from this package's runtime entry — two different modules, so the emitter's
 * collected set is partitioned here rather than at the point of use.
 */
function importLines(names: Set<string>, dialect: JsxDialect): string[] {
  const lines: string[] = [];
  if (names.has("__mxFragment")) {
    lines.push(
      `import { Fragment as __mxFragment } from "${dialect.fragmentModule}";`,
    );
  }
  const boundary = [dialect.errorBoundaryName, dialect.suspenseName].filter(
    (name) => names.has(name),
  );
  if (boundary.length > 0) {
    lines.push(
      `import { ${boundary.map((name) => `${name} as ${name === dialect.errorBoundaryName ? "__mxErrorBoundary" : "__mxSuspense"}`).join(", ")} } from "${dialect.errorBoundaryModule}";`,
    );
  }
  if (names.has("__mxClass")) {
    const mxClassModule = dialect.mxClassModule ?? dialect.errorBoundaryModule;
    lines.push(`import { mxClass as __mxClass } from "${mxClassModule}";`);
  }
  return lines;
}

/** One runtime binding an emitted module (or region) imports. */
export interface JsxRuntimeImport {
  /** The single-binding `import { X as __mxX } from "m";` statement text. */
  code: string;
  /** The local binding the emitted JSX references. */
  binding: string;
  /** The module specifier, as written in `code`. */
  specifier: string;
}

/**
 * {@link importLines} one binding per statement, for a region: the parser
 * bridge places and de-duplicates each import on its own, so two regions that
 * both need `__mxFragment` share one declaration.
 */
export function runtimeImports(
  names: Set<string>,
  dialect: JsxDialect,
): JsxRuntimeImport[] {
  const entries: JsxRuntimeImport[] = [];
  if (names.has("__mxFragment")) {
    entries.push({
      code: `import { Fragment as __mxFragment } from "${dialect.fragmentModule}";`,
      binding: "__mxFragment",
      specifier: dialect.fragmentModule,
    });
  }
  for (const [name, binding] of [
    [dialect.errorBoundaryName, "__mxErrorBoundary"],
    [dialect.suspenseName, "__mxSuspense"],
  ] as const) {
    if (!names.has(name)) continue;
    entries.push({
      code: `import { ${name} as ${binding} } from "${dialect.errorBoundaryModule}";`,
      binding,
      specifier: dialect.errorBoundaryModule,
    });
  }
  if (names.has("__mxClass")) {
    const mxClassModule = dialect.mxClassModule ?? dialect.errorBoundaryModule;
    entries.push({
      code: `import { mxClass as __mxClass } from "${mxClassModule}";`,
      binding: "__mxClass",
      specifier: mxClassModule,
    });
  }
  return entries;
}

/** One module-scope helper declaration the emitted JSX calls. */
export interface JsxHelper {
  /** The `const __mxX = …;` (or `function`) declaration text. */
  code: string;
  /** The binding it declares. */
  binding: string;
}

/**
 * The attribute and textarea helpers `text` calls, in the order a whole-file
 * module declares them. Selected by a scan of the emitted text (the body,
 * the lifted statements and, when present, `MX_DYNAMIC`, which calls two of
 * them itself).
 */
export function attributeHelpers(
  text: string,
  dialect: JsxDialect,
): JsxHelper[] {
  const helpers: JsxHelper[] = [];
  if (text.includes("__mxAttrValue(") || text.includes("__mxAttrSpread("))
    helpers.push({
      binding: "__mxAttrValue",
      code: `const __mxAttrValue = ${jsxAttrValueExpression(dialect.reactBooleanAttributes === true)};`,
    });
  if (text.includes("__mxAttrSpread("))
    helpers.push({
      binding: "__mxAttrSpread",
      code: `const __mxAttrSpread = ${JSX_ATTRIBUTE_SPREAD_EXPRESSION};`,
    });
  if (text.includes("__mxTextareaContent(") || text.includes("__mxTextarea("))
    helpers.push({
      binding: "__mxTextareaContent",
      code: `const __mxTextareaContent = ${jsxTextareaContentExpression(dialect.textareaLeadingNewline)};`,
    });
  if (text.includes("__mxTextarea("))
    helpers.push({
      binding: "__mxTextarea",
      code: `const __mxTextarea = ${jsxTextareaPropsExpression(dialect.textareaContent)};`,
    });
  return helpers;
}

/**
 * `mxDynamic`'s source, inlined into a module rather than imported.
 *
 * Marko's own dynamic tag is polymorphic at run time — the target can be a
 * tag-name string, a render function, or already-rendered content (a
 * caller's `input.content`/`children`, passed straight through rather than
 * called again). JSX's tag position is static, so a module using a dynamic
 * tag gets this helper inlined, the same way `@mxlang/html` inlines
 * `renderDynamic` — no runtime package, so nothing to import.
 *
 * `payload` is either the call's props object (no arguments), or — for
 * Marko's tag-argument form (`<\${x}(a, b)/>`) — an array, told apart with
 * `Array.isArray`. Decision 109 (Marko parity, \`assertAttributesOrArgs\`,
 * \`@marko/compiler/babel-utils\`): args now combine with a body or attribute
 * tag, so the array is not always bare arguments — when there is content or
 * an attribute tag to carry, the emitter (\`component()\` in \`emitter.ts\`)
 * appends a trailing props object as the array's last element, matching
 * Marko's own \`renderer(...args, propsObject)\` shape (\`dynamic-tag.ts\`'s
 * translator). The \`Array.isArray\` dispatch below stays unambiguous either
 * way: a *function* target spreads the whole array as its call arguments
 * (\`target(...payload)\`) whether or not the last element is that trailing
 * object — the callee reads it as its own last positional parameter, the
 * same convention \`#defineTrailingParams\` uses for a
 * \`<define>\` call. A positional call is not an element description, matching
 * \`@mxlang/html\`'s \`renderDynamic\` and \`@mxlang/solid\`'s inline dispatch.
 *
 * decision 112, Marko parity: a *string* target called with arguments uses
 * \`payload[0]\` (Marko's \`args[0]\`) as its element attributes, not the
 * trailing props object's attribute tags — Marko's translator appends that
 * object *after* the positional args (\`renderer(...args, { content, ... })\`),
 * so it never lands at \`args[0]\` and \`_dynamic_tag\`'s string branch
 * (\`runtime-tags/src/html/dynamic-tag.ts\`) never reads it. Content still
 * renders regardless: Marko threads it as its own parameter to
 * \`_dynamic_tag\`, independent of the input, so the emitter (\`component()\`)
 * passes it here as \`content\`, a third argument, rather than folding it into
 * \`payload\` where this dispatch could not tell a real trailing argument from
 * the synthesized props object.
 */
export const MX_DYNAMIC = `function __mxIsHostComponentObject(value: any): boolean {
  if (value === null || typeof value !== "object") return false;
  const marker = value.$$typeof;
  if (typeof marker !== "symbol") return false;
  // Every React *element* also carries a $$typeof symbol
  // (Symbol(react.transitional.element)/Symbol(react.element) depending on
  // the React version) - that would make an ordinary rendered element (e.g.
  // an already-rendered <em/>) misclassify as a component here too.
  // Allowlisted rather than blocklisted: only the three component-wrapper
  // markers this fix targets (memo, forwardRef, lazy) qualify, matched by
  // the symbol's description since these are plain Symbol()s (not
  // Symbol.for(...)), so identity cannot be compared across a second React
  // copy.
  const description = marker.description;
  return (
    description === "react.memo" ||
    description === "react.forward_ref" ||
    description === "react.lazy"
  );
}
function __mxDynamic(target: any, payload: any, content?: any, takesParams?: boolean) {
  if (Array.isArray(payload)) {
    if (typeof target === "function") return target(...payload);
    if (typeof target === "string" || __mxIsHostComponentObject(target)) {
      const Tag: any = target;
      const attrs = payload[0] || {};
      if (takesParams) {
        if (typeof target === "string") throw new Error("MX: tag params |…| cannot be passed to a native element: a string target has nothing to call its body");
        return <Tag {...attrs} children={content} />;
      }
      if (target === "textarea") {
        if (content) throw new Error("A dynamic tag rendering a \`<textarea>\` cannot have \`content\` and must use the \`value\` attribute instead.");
        return <Tag {...__mxTextarea(__mxAttrSpread(attrs, target, ["ref", "key", "dangerouslySetInnerHTML", "className"], true))} />;
      }
      return <Tag {...(typeof target === "string" ? __mxAttrSpread(attrs, target, ["ref", "key", "dangerouslySetInnerHTML", "className"], true) : attrs)}>{content ? content() : undefined}</Tag>;
    }
    return target;
  }
  const props = payload;
  if (
    typeof target === "string" ||
    typeof target === "function" ||
    __mxIsHostComponentObject(target)
  ) {
    const Tag: any = target;
    const { content: bodyContent, ...rest } = props;
    if (takesParams) {
      if (typeof target === "string") throw new Error("MX: tag params |…| cannot be passed to a native element: a string target has nothing to call its body");
      return <Tag {...rest} children={bodyContent} />;
    }
    if (target === "textarea") {
      if (bodyContent) throw new Error("A dynamic tag rendering a \`<textarea>\` cannot have \`content\` and must use the \`value\` attribute instead.");
      return <Tag {...__mxTextarea(__mxAttrSpread(rest, target, ["ref", "key", "dangerouslySetInnerHTML", "className"], true))} />;
    }
    return <Tag {...(typeof target === "string" ? __mxAttrSpread(rest, target, ["ref", "key", "dangerouslySetInnerHTML", "className"], true) : rest)}>{bodyContent ? bodyContent() : undefined}</Tag>;
  }
  if (
    target !== null &&
    typeof target === "object" &&
    (Object.getPrototypeOf(target) === Object.prototype ||
      Object.getPrototypeOf(target) === null) &&
    Object.prototype.hasOwnProperty.call(target, "content")
  ) {
    throw new Error(
      "MX: this value is a data attribute tag ({ ...attrs, content }); render its body with <\${x.content}/>",
    );
  }
  return props.content ? props.content() : target;
}`;

/**
 * Builds the emitted component module for one resolved template.
 *
 * `<const>` and `<define>` are lifted out of the body first: both are
 * *statements* in the emitted function, and JSX has no statement position, so
 * they are emitted above the `return` in the order the author wrote them. A
 * `<const>` deeper in the tree stays an error (see the emitter), because
 * lifting one out of a `<for>` body would change which values it closes over.
 */
/** The identifiers the type-check preamble declares in the user's module. */
interface HandlerTypeNames {
  jsx: string;
  map: string;
  handler: string;
}

/**
 * Names for the preamble that collide with nothing in the template: a
 * candidate that appears anywhere in the source text gets a numeric suffix,
 * the same conservative rule core's template-tag gensyms use. Checked against
 * the whole source, so a user `static`, `import`, `type` or plain mention of
 * the name is avoided.
 */
function handlerTypeNames(source: string): HandlerTypeNames {
  // A JavaScript identifier may spell any character as a Unicode escape
  // (`__Mx\u0048` is `__MxH`), so the scan reads the source both as written
  // and with every `\uXXXX` / `\u{…}` escape decoded. Decoding every escape,
  // not only those inside identifiers, is deliberately conservative.
  const decoded = source.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g,
    (whole, braced?: string, fixed?: string) => {
      const code = Number.parseInt((braced ?? fixed) as string, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
  const taken = (name: string): boolean =>
    source.includes(name) || decoded.includes(name);
  const fresh = (base: string): string => {
    let name = base;
    for (let n = 1; taken(name); n++) name = `${base}${n}`;
    return name;
  };
  return {
    jsx: fresh("__MxJSX"),
    map: fresh("__MxM"),
    handler: fresh("__MxH"),
  };
}

/**
 * The type-check-only preamble the handler wrapper needs (decision 140).
 *
 * Types only — an `import type` and two aliases — so nothing in it survives
 * emit and it declares no value. `Handler<tag, event>` is the host's own
 * handler type for that element and event: the key of
 * `JSX.IntrinsicElements[tag]` whose lowercased name is `on` + the lowercased
 * event. Case-insensitive, because decision 101 emits the lowercase runtime
 * spelling (`onKeydown`) while the host's types declare `onKeyDown`. No hit —
 * an unknown element or prop — is `any`. The prop's complete declared type is
 * kept, optionality and `undefined`/`null` included, so forwarding an optional
 * callback checks as it does in plain TSX.
 */
function handlerTypePreamble(
  dialect: JsxDialect,
  { jsx, map, handler }: HandlerTypeNames,
): string[] {
  return [
    `import type { JSX as ${jsx} } from "${dialect.jsxImportSource}/jsx-runtime";`,
    `type ${map}<T extends string, E extends string> = T extends keyof ${jsx}.IntrinsicElements ? { [K in keyof ${jsx}.IntrinsicElements[T] as Lowercase<K & string> extends \`on\${E}\` ? K : never]: ${jsx}.IntrinsicElements[T][K] } : {};`,
    `type ${handler}<T extends string, E extends string> = [keyof ${map}<T, E>] extends [never] ? any : ${map}<T, E>[keyof ${map}<T, E>];`,
  ];
}

export function emitModuleWithMappings(
  ir: Ir,
  dialect: JsxDialect = preactDialect,
  typeCheck = false,
  source = "",
): MappedCode {
  const names = typeCheck ? handlerTypeNames(source) : undefined;
  const emitter = createEmitter(dialect, names?.handler);

  // Statements first, markup second. Splitting on the top level only: a
  // nested one is refused by the emitter rather than silently relocated.
  const statements: MappedCode[] = [];
  const markup: IrNode[] = [];
  for (const node of ir.body) {
    if (node.kind === "Const") {
      statements.push(concatMapped(`const ${node.name} = ${node.init.code};`));
    } else if (node.kind === "Define") {
      const body = createEmitter(dialect, names?.handler);
      drive(body, node.children);
      const rendered = body.result();
      for (const name of body.runtimeImports) {
        emitter.runtimeImports.add(name);
      }
      statements.push(
        concatMapped(
          `const ${node.name} = (${node.params.join(", ")}) => (<>`,
          rendered,
          "</>);",
        ),
      );
    } else {
      markup.push(node);
    }
  }

  drive(emitter, markup);
  const body = emitter.result();

  // A `/var` call site needs its call evaluated above the `return`, and the
  // emitter collects those while walking (see `varStatements`). Appended
  // after the author's own `<const>`/`<define>` statements, in the order the
  // calls were met, so a binding is declared before the markup that reads it.
  for (const statement of emitter.varStatements) {
    statements.push(concatMapped(statement));
  }

  const lines: string[] = [
    `/** @jsxImportSource ${dialect.jsxImportSource} */`,
  ];
  if (names) lines.push(...handlerTypePreamble(dialect, names));
  if (ir.needsAttrTagImport) {
    lines.push(`import type { AttrTag } from "${dialect.attrTagModule}";`);
  }
  const imports = importLines(emitter.runtimeImports, dialect);
  if (imports.length > 0) lines.push(...imports);

  const helperInput = [
    body.code,
    ...statements.map((statement) => statement.code),
    ...(emitter.runtimeImports.has("__mxDynamic") ? [MX_DYNAMIC] : []),
  ].join("\n");
  const attrHelpers = attributeHelpers(helperInput, dialect).map(
    (helper) => helper.code,
  );
  const importedNames = new Set(ir.imports.flatMap((node) => node.bindings));
  const hoisted = [
    ...ir.imports.map((node) => node.code),
    ...ir.hoisted.map((node) => node.code),
    // A component whose Marko name JSX would read as an element is called
    // under a capitalized alias. Where the author imported the name, the
    // alias is a local binding; where Marko *discovered* it from a `tags/`
    // directory there is no import at all — that is the point of discovery —
    // so one is synthesized against Marko's own convention. The synthesized
    // path is always `.marko`, never `.mx`: `@marko/compiler`'s own
    // `scanTagsDir` only discovers files whose extension is literally
    // `.marko` (see the `tagDiscoveryDirs` doc comment above), so a
    // discovered tag can only ever be a real `.marko` file on disk.
    ...[...emitter.aliases].map((name) =>
      importedNames.has(name)
        ? `const ${componentAlias(name)} = ${name};`
        : `import ${componentAlias(name)} from "./tags/${name}.marko";`,
    ),
    // Private helpers use the language-reserved prefix; public runtime
    // exports retain their names and are imported under private aliases.
    ...attrHelpers,
    ...(emitter.runtimeImports.has("__mxDynamic") ? [MX_DYNAMIC] : []),
  ];
  if (hoisted.length > 0) lines.push("", ...hoisted);

  lines.push(
    "",
    ir.inputInterface?.code ?? "export interface Input {}",
    "",
    // Named after the file, never anonymous: a tag whose template calls its
    // own name resolves to this declaration, so self-recursion needs no
    // self-import (design invariant §7.5-7).
    `export default function ${moduleExportName(ir, "@mxlang/preact")}(props: Input) {`,
  );
  // Marko names a component's ordinary children `content`, and a template
  // reads them as `${input.content}`. JSX has its own name for the same slot —
  // a caller writes `<Card><p/></Card>` and the callee receives
  // `props.children` — and this host emits calls that way, because a
  // hand-written Preact component called from MX must work too. So a template
  // that reads `input.content` gets the alias, and one that does not is
  // emitted unchanged: without it, `<Card><p/></Card>` compiled cleanly and
  // rendered an empty card, which is the S8 silent-drop class.
  //
  // A bare string or number body is made a fragment here, once, for every
  // caller (an MX call site, hand-written TSX, a test harness): Marko's body
  // is a renderer, never a string, but a JSX child may be one, and
  // `<${input.content}/>` (`mxDynamic`) reads a string as a tag NAME. A
  // number goes through `String` because hono drops a bare `0` inside a
  // fragment; an empty string becomes `undefined` (renders nothing, stays
  // falsy for `<if=input.content>`). A tag-name value never comes through
  // `input.content`, so `<${tag}/>` is unaffected.
  lines.push(
    "  const __mxBody =",
    "    (props as { content?: unknown }).content ??",
    "    (props as { children?: unknown }).children;",
    "  const input: Input & { content?: unknown } = {",
    "    ...props,",
    "    content:",
    '      typeof __mxBody === "string" || typeof __mxBody === "number"',
    '        ? __mxBody === ""',
    "          ? undefined",
    "          : <>{String(__mxBody)}</>",
    "        : __mxBody,",
    "  };",
  );
  // A statement lifted by the core's own hoist hook precedes the author's, so
  // a binding it introduces is in scope for everything that follows.
  for (const node of ir.prelude) lines.push(`  ${node.code}`);
  const prefix = `${lines.join("\n")}\n`;
  const statementCode = concatMapped(
    ...statements.flatMap((statement) => ["  ", statement, "\n"]),
  );
  // A unit that declares `<return>` hands back `{ value, output }` rather
  // than its markup alone (design §3.3), so the call site can bind the value
  // with `/var` and still render the output. `output` is the element, not a
  // string: on this target that is what "the rendered thing" is.
  if (ir.returnValue) {
    rejectHooksInReturningUnit(ir, dialect.hookModules);
    return concatMapped(
      prefix,
      statementCode,
      `  return { value: ${ir.returnValue.code}, output: (<>`,
      body,
      "</>) };\n}\n",
    );
  }

  return concatMapped(
    prefix,
    statementCode,
    "  return (<>",
    body,
    "</>);\n}\n",
  );
}

/**
 * Refuses a returning unit that imports a hook (round 1, finding 2).
 *
 * A returning unit is **invoked as a plain function**, not mounted as a
 * component — that is what lets it hand `{ value, output }` back, since a JSX
 * element is only a description of a call the runtime makes later. The cost
 * is that it has no component identity of its own: Preact's and React's hook
 * dispatchers bind to the *calling* component's hook list, so a `useState`
 * inside the unit silently becomes a hook of the caller. It is then
 * order-dependent, breaks outright when the call is conditional or looped,
 * and `useContext` reads the caller's position in the tree.
 *
 * All of that is invisible at run time until it corrupts state, so it is a
 * compile error here. A unit that needs hooks should not return a value;
 * Solid is unaffected, because its callback prop keeps the component a
 * component.
 *
 * `hookModules` is dialect vocabulary (`JsxDialect.hookModules`, `dialect.ts`),
 * not a shared constant: each of Preact, React and Hono declares its own
 * hook-import module(s), so this guard checks only the modules relevant to
 * whichever dialect actually compiled the file.
 */
function rejectHooksInReturningUnit(
  ir: Ir,
  hookModules: readonly string[],
): void {
  for (const node of ir.imports) {
    // Parsed, not matched against the printed statement. A substring test
    // over `node.code` was wrong three ways at once, all measured: it missed
    // `'preact/hooks'` (single-quoted), and — reading `node.bindings`, which
    // holds *local* names — it missed `import * as h from "preact/hooks"`
    // and `import { useState as us }`, since neither local is `use`-prefixed.
    const parsed = importedNames(node.code);
    if (!parsed || !hookModules.includes(parsed.source)) {
      continue;
    }

    const hook = parsed.names.find(({ imported }) => isHookName(imported));
    if (hook) {
      // Named by the module's own spelling, since that is what identifies the
      // hook; an alias is reported alongside so the message points at
      // something the author can find in their own file.
      throw hookError(
        hook.imported === hook.local
          ? `\`${hook.imported}\``
          : `\`${hook.imported}\` (imported as \`${hook.local}\`)`,
        node,
      );
    }

    // A namespace import reaches every hook the module has through one local
    // object (`h.useState(0)`), so there is no imported name to test. The
    // whole namespace is refused rather than scanning the template for member
    // reads: this is a hook module, and a returning unit has no business
    // holding a handle to one.
    const namespace = parsed.names.find(({ imported }) => imported === "*");
    if (namespace) {
      throw hookError(
        `the \`${namespace.local}\` namespace from \`${parsed.source}\``,
        node,
      );
    }
  }
}

/** Whether a name the module exports is one of its hooks. */
function isHookName(imported: string): boolean {
  return /^use[A-Z]/.test(imported);
}

/** The one diagnostic both branches above raise, worded once. */
function hookError(
  what: string,
  node: Extract<IrNode, { kind: "Import" }>,
): TranslateError {
  return new TranslateError(
    `${what} cannot be used in a tag that declares \`<return>\`: a returning unit is called as a plain function, so its hooks would bind to the calling component's hook list rather than its own. Drop the \`<return>\` or move the hook to the caller.`,
    node.loc.line,
    node.loc.column,
    node.loc.file,
  );
}

export function emitModule(
  ir: Ir,
  dialect: JsxDialect = preactDialect,
): string {
  return emitModuleWithMappings(ir, dialect).code;
}

export interface CompilePreactResult extends CompileResult {
  mappings: GeneratedMapping[];
}

/**
 * Compiles a `.mx` template to a Preact component module.
 *
 * The returned map is a placeholder identity map, as `@mxlang/html`'s is: the
 * emitter builds text rather than printing a Babel AST, so there are no node
 * positions to derive real mappings from yet. `@mxlang/typescript-plugin`
 * maps from the IR's own node locations instead.
 */
export function compilePreactMx(
  source: string,
  filename: string,
  options: CompilePreactOptions & { targets: TargetLookup },
): CompilePreactResult {
  const dialect = options.dialect ?? preactDialect;
  let mappings: GeneratedMapping[] = [];
  const result = compileSource(
    source,
    filename,
    options.declarations ?? preactDeclarations,
    {
      ...host,
      customTags: options.customTags,
      defaultTag: options.defaultTag,
      resolveImport: options.resolveImport,
      warnings: options.warnings,
      ...(options.typeCheck ? { stripTypes: false } : {}),
      targets: options.targets,
      emitIr: (ir) => {
        const emitted = emitModuleWithMappings(
          ir,
          dialect,
          options.typeCheck,
          source,
        );
        mappings = emitted.mappings;
        return emitted.code;
      },
    },
  );
  return { ...result, mappings };
}

/** `compilePreactMx()` over a file on disk. */
export function compilePreactFile(
  filename: string,
  options: CompilePreactOptions & { targets: TargetLookup },
): CompileResult {
  return compilePreactMx(readFileSync(filename, "utf8"), filename, options);
}
