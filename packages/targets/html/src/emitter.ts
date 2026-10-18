/**
 * The vanilla HTML host's string emitter, over `@mxlang/core`'s IR.
 *
 * The core lowers a template to an `Ir`; this file turns that tree into the
 * emitted module's lines. Nothing here walks a Marko node: every decision was
 * already made by `lower()`, and what arrives is kinds, printed expressions
 * and positions.
 *
 * ## Byte compatibility is the whole contract
 *
 * This replaced an emitting walk whose output is pinned three ways: this
 * package's own test suite asserts the module shape, `@mxlang/host-astro`'s
 * `vite-pages.ts` text-matches the emitted tail to wrap a page, and
 * `oracle:marko` renders every fixture and compares the HTML against real
 * Marko. So the output is reproduced exactly, not merely equivalently —
 * including the literal merging, the `$forN` temporaries, and the spacing
 * inside a component's props object.
 *
 * Two of those are worth naming because they look accidental and are not:
 *
 * - **Literals merge across node boundaries.** An element's tag, its
 *   attributes and the text after it become one `__mxOut.write("…")`,
 *   because `literal` folds into the preceding line when it is a literal
 *   write.
 *   Emitting one line per IR node would be correct JavaScript and a different
 *   file.
 * - **`$forN` counts emitted lines, not loops.** The old walk named a loop's
 *   temporary `$for${ctx.body.length}`, so the number is however many lines
 *   had been emitted when the temporary was pushed — which is why a fixture
 *   shows `$for1`/`$for2` for one loop, and a loop inside a block function
 *   starts from that block's own line count. Reproduced by keeping the same
 *   line array and pushing in the same order.
 */

import {
  type Attr,
  type AttributeTag,
  type AttributeTagNode,
  type AttrTagProp,
  type Block,
  type ComponentTarget,
  concatMapped,
  type DelegatedTag,
  defineValueWrapper,
  drive,
  type Emitter,
  type Expr,
  // biome-ignore lint/suspicious/noShadowRestrictedNames: the compiler calls the same helper the emitted module imports, so a static value and a runtime one are escaped by one implementation
  escape,
  type ForHead,
  type GeneratedMapping,
  type Ir,
  type IrNode,
  type MappedCode,
  mapped,
  mappedExpr,
  moduleExportName,
  propKey,
  quote,
  TranslateError,
} from "@mxlang/core";
import type {
  ClientPiece,
  ClientType,
  ClientTypeExport,
  DelegatedTagData,
} from "./translate.ts";
import { DYNAMIC, escapeComment, escapeScript } from "./translate.ts";

const INDENT = "  ";

/**
 * A well-formed HTML attribute name, as source text for the emitted module.
 *
 * Validates spread keys, which are only known at run time. Anything containing
 * a space, quote, `/` or `>` could end the attribute name and start live markup
 * inside the tag, so it is skipped rather than emitted.
 */
const ATTR_NAME_PATTERN = "/^[A-Za-z_:][-A-Za-z0-9_:.]*$/";

/** Raised for an IR shape this target has no lowering for. */
function fail(
  message: string,
  node: { loc: { line: number; column: number } },
): never {
  throw new TranslateError(message, node.loc.line, node.loc.column);
}

/**
 * The emitter's mutable state: one line buffer, and the indent it writes at.
 *
 * A block function swaps the buffer out and back (`blockFunction` below), so
 * the same emitter object serves the render function and every nested block —
 * which is what keeps `$forN`'s line counting matching the old walk's.
 */
interface State {
  body: string[];
  bodyMappings: GeneratedMapping[][];
  prelude: string[];
  /**
   * Statements this host lifts to **module** scope, beside the template's own
   * `static` blocks.
   *
   * A `server` block is server-side code and this *is* the server render, so
   * it runs once per module and its bindings are readable from the template.
   * A `client` block leaves only a `var` for the names it declares. Putting
   * either in `prelude` instead would place it inside the render function,
   * where `static`'s own siblings are not — verified by the suite, which
   * asserts the binding appears *above* `function render`.
   *
   * `start` is the statement's source offset, so the module interleaves these
   * with the `static` blocks in the order they were written.
   */
  moduleHoisted: Array<{ code: MappedCode; start: number | undefined }>;
  /**
   * Under `typeCheck`, the code of every `client` statement: one function the
   * module calls where its last `client` statement stands, so a client name
   * is typed there and is `undefined` everywhere else (the server view).
   */
  clientBody: MappedCode[];
  /** Under `typeCheck`, the interfaces and type aliases of `client` statements. */
  clientTypes: Array<{ type: ClientType; start: number | undefined }>;
  /** Under `typeCheck`, the `export type { … }` lists of `client` statements. */
  clientTypeExports: Array<{
    list: ClientTypeExport;
    start: number | undefined;
  }>;
  /** Under `typeCheck`, every name a `client` statement declares as `undefined`. */
  clientNames: string[];
  /** Under `typeCheck`, the local names of `client export { … }` value lists. */
  clientListed: string[];
  /** Under `typeCheck`, where the last `client` statement stands. */
  clientStart: number | undefined;
  /** Under `typeCheck`, each `return` that no function encloses in `client` code. */
  clientReturns: MappedCode[];
  indent: number;
  /** Serial for local arrays and source temporaries in attribute-tag loops. */
  attrTagTemp: number;
  /**
   * The sink the next write goes to.
   *
   * `__mxOut` everywhere except inside a `<try>` body, which writes to its
   * own buffered sub-sink so a throw can drop the half-rendered body.
   */
  sink: string;
  /**
   * Serial for `<try>` sub-sinks.
   *
   * Per emit rather than on the IR: one MX IR is emitted by six host
   * emitters, and a generated name cached on shared IR is exactly the bug
   * Marko paid for by sharing uid counters between its two backends
   * (invariant §7.5-6).
   */
  tryTemp: number;
}

export interface StringEmitter extends Emitter<string[]> {
  /** The lines emitted so far, for a caller assembling the module. */
  readonly state: State;
}

/**
 * The host's string emitter.
 *
 * `escapeFrom` and the structured-value helpers are the host's, not the
 * core's: which helpers exist, and that they are inlined rather than imported
 * to keep the runtime surface at one `escape`, is a property of this target.
 */
export function createEmitter(
  selfName?: string,
  options: { typeCheck?: boolean; source?: string } = {},
): StringEmitter {
  const state: State = {
    body: [],
    bodyMappings: [],
    prelude: [],
    moduleHoisted: [],
    clientBody: [],
    clientTypes: [],
    clientTypeExports: [],
    clientNames: [],
    clientListed: [],
    clientStart: undefined,
    clientReturns: [],
    indent: 1,
    attrTagTemp: 0,
    sink: "__mxOut",
    tryTemp: 0,
  };

  const push = (line: string | MappedCode): void => {
    const emitted = concatMapped(INDENT.repeat(state.indent), line);
    state.body.push(emitted.code);
    state.bodyMappings.push(emitted.mappings);
  };

  /** Writes one already-rendered string expression to the current sink. */
  const write = (code: string | MappedCode): void => {
    push(concatMapped(`${state.sink}.write(`, code, ");"));
  };

  /**
   * Appends a run of literal HTML, merging into the preceding literal write.
   *
   * An element's tag, attributes and text would otherwise each take a line.
   */
  const literal = (text: string): void => {
    if (text === "") return;
    const last = state.body[state.body.length - 1];
    const head = `${INDENT.repeat(state.indent)}${state.sink}.write(`;
    if (last?.startsWith(`${head}"`) && last.endsWith('");')) {
      const existing = JSON.parse(last.slice(head.length, -2)) as string;
      state.body[state.body.length - 1] = `${head}${quote(existing + text)});`;
      return;
    }
    write(quote(text));
  };

  // A raw expression is written as `"" + (…)`: the same string coercion the
  // former `out += (…)` applied, now spelled out because `write` takes a
  // string. Only the attribute writers use it; their value is already text.
  const expression = (code: string | MappedCode, escaped: boolean): void => {
    write(
      escaped
        ? concatMapped("__mxEscape(", code, ")")
        : concatMapped('"" + (', code, ")"),
    );
  };

  /**
   * An `${…}` / `$!{…}` in text position, rendered the way Marko's html
   * runtime renders it (`_escape` / `_unescaped`): `__mxTextOf` prints a
   * truthy value as its string, `0` as `0`, and every other falsy value
   * (`false`, `NaN`, `0n`, `""`, `null`, `undefined`) as nothing.
   *
   * This is separate from `expression` on purpose. An attribute value follows
   * a different rule (`false` and `null` drop the attribute, `NaN` and `0n`
   * print), and `escape` serves both positions.
   */
  const interpolation = (code: string | MappedCode, escaped: boolean): void => {
    write(
      escaped
        ? concatMapped("__mxEscape(__mxTextOf(", code, "))")
        : concatMapped("__mxTextOf(", code, ")"),
    );
  };

  /**
   * Renders a child list as a self-contained `() => string` function.
   *
   * The body gets its own sink, so a block never writes to the enclosing
   * template's sink and can be called zero or many times by the component
   * that receives it. Blocks stay string-returning: `content` and renderable
   * attribute tags are `() => string` to every callee, hand-written ones
   * included.
   */
  const blockFunction = (children: IrNode[], params = ""): MappedCode => {
    const outerBody = state.body;
    const outerBodyMappings = state.bodyMappings;
    const outerPrelude = state.prelude;
    const outerIndent = state.indent;
    const outerSink = state.sink;
    state.body = [];
    state.bodyMappings = [];
    state.prelude = [];
    state.indent = outerIndent + 1;
    state.sink = "__mxOut";
    push("const __mxOut = __mxCreateOut();");
    drive(emitter, children);
    push("return __mxOut.toString();");
    state.sink = outerSink;
    const lines = state.body;
    const lineMappings = state.bodyMappings;
    // A statement hoisted from inside this block belongs at *this* function's
    // head, not the enclosing one's: it may read the block's own params.
    const prelude = state.prelude.map(
      (code) => INDENT.repeat(outerIndent + 1) + code,
    );
    state.body = outerBody;
    state.bodyMappings = outerBodyMappings;
    state.prelude = outerPrelude;
    state.indent = outerIndent;
    const emittedLines = lines.map((code, index) => ({
      code,
      mappings: lineMappings[index] ?? [],
    }));
    return concatMapped(
      `(${params}) => {\n`,
      ...prelude.flatMap((code) => [code, "\n"]),
      ...emittedLines.flatMap((line, index) =>
        index === emittedLines.length - 1 ? [line] : [line, "\n"],
      ),
      `\n${INDENT.repeat(outerIndent)}}`,
    );
  };

  /** Object-literal parts for ordinary component or data-tag attributes. */
  const propPartsOfAttrs = (attrs: Attr[]): MappedCode[] =>
    attrs.map((attr) => {
      if (attr.kind === "spread") {
        return concatMapped("...", mappedExpr(attr.value));
      }
      const value =
        attr.kind === "boolean"
          ? "true"
          : attr.kind === "static"
            ? quote(attr.value)
            : attributeValue(attr);
      return concatMapped(
        mapped(propKey(attr.name), attr.nameSpan),
        ": ",
        value,
      );
    });

  const joinParts = (parts: MappedCode[]): MappedCode =>
    concatMapped(
      ...parts.flatMap((part, index) => (index === 0 ? [part] : [", ", part])),
    );

  /** First authored tag-name span represented by a resolved source tree. */
  const attrTagNameSpan = (
    nodes: AttributeTagNode[],
  ): { sourceStart: number; sourceEnd: number } | null => {
    for (const node of nodes) {
      if (node.kind === "AttributeTag") return node.tag.nameSpan;
      const nested =
        node.kind === "AttributeTagIf"
          ? node.branches.flatMap((branch) => branch.nodes)
          : node.nodes;
      const span = attrTagNameSpan(nested);
      if (span) return span;
    }
    return null;
  };

  /** One concrete attribute-tag occurrence in its declared host shape. */
  const attrTagValue = (
    tag: AttributeTag,
    as: AttrTagProp["as"],
    valueType: string | null,
  ): MappedCode => {
    const content = blockFunction(
      tag.block.children,
      tag.block.params.join(", "),
    );
    if (as === "renderable") {
      return valueType
        ? concatMapped(
            "(((",
            content,
            ") ",
            mapped("satisfies", tag.nameSpan),
            ` ${valueType}) as any)`,
          )
        : content;
    }

    const parts = propPartsOfAttrs(tag.attrs);
    for (const nested of tag.attrTagProps) {
      parts.push(
        concatMapped(
          mapped(propKey(nested.name), attrTagNameSpan(nested.source)),
          ": ",
          attrTagPropValue(nested, valueType),
        ),
      );
    }
    parts.push(concatMapped("content: ", tag.hasBody ? content : "undefined"));
    const value = concatMapped("{ ", joinParts(parts), " }");
    return valueType
      ? concatMapped(
          "((",
          value,
          " ",
          mapped("satisfies", tag.nameSpan),
          ` ${valueType}) as any)`,
        )
      : value;
  };

  const singleNodeValue = (
    node: AttributeTagNode,
    as: AttrTagProp["as"],
    valueType: string | null,
  ): MappedCode => {
    if (node.kind === "AttributeTag")
      return attrTagValue(node.tag, as, valueType);
    if (node.kind === "AttributeTagFor") {
      return fail(
        "internal attribute-tag plan error: a singular value cannot contain `<for>`",
        node,
      );
    }

    let alternate = concatMapped("undefined");
    for (let index = node.branches.length - 1; index >= 0; index--) {
      const branch = node.branches[index];
      if (!branch) continue;
      const value = singleSourceValue(branch.nodes, as, valueType);
      alternate = branch.test
        ? concatMapped(
            "(",
            branch.test.code,
            " ? ",
            value,
            " : ",
            alternate,
            ")",
          )
        : value;
    }
    return alternate;
  };

  const singleSourceValue = (
    source: AttributeTagNode[],
    as: AttrTagProp["as"],
    valueType: string | null,
  ): MappedCode => {
    if (source.length === 0) return concatMapped("undefined");
    const values = source.map((node) => singleNodeValue(node, as, valueType));
    if (values.length === 1) return values[0] as MappedCode;
    return concatMapped(
      "(",
      ...values.flatMap((value, index) =>
        index === 0 ? [value] : [" ?? ", value],
      ),
      ")",
    );
  };

  const arrayLoopValue = (
    node: Extract<AttributeTagNode, { kind: "AttributeTagFor" }>,
    as: AttrTagProp["as"],
    valueType: string | null,
  ): MappedCode => {
    const source: ForHead["source"] = node.loop.source;
    if (source.kind === "range" && source.step) {
      return fail(
        "`<for step=...>`: step is not supported; use a computed array",
        node,
      );
    }

    const serial = state.attrTagTemp++;
    const result = `__mxAttrTags${serial}`;
    const sourceName = `__mxAttrTagSource${serial}`;
    const [first = "__mxItem", second] = node.loop.params;
    const body = arraySourceValue(node.nodes, as, valueType);

    if (source.kind === "of") {
      const head = second
        ? `for (const [${second}, ${first}] of [...${sourceName}].entries())`
        : `for (const ${first} of ${sourceName})`;
      return concatMapped(
        `(() => { const ${result} = []; const ${sourceName}Raw = ${source.list.code}; const ${sourceName} = ${sourceName}Raw ? ${sourceName}Raw : []; ${head} { ${result}.push(...(`,
        body,
        `)); } return ${result}; })()`,
      );
    }

    if (source.kind === "in") {
      const entry = second ? `[${first}, ${second}]` : `[${first}]`;
      return concatMapped(
        `(() => { const ${result} = []; const ${sourceName} = ${source.object.code} ?? {}; for (const ${entry} of Object.entries(${sourceName})) { ${result}.push(...(`,
        body,
        `)); } return ${result}; })()`,
      );
    }

    const start = `__mxAttrTagStart${serial}`;
    const bound = `__mxAttrTagBound${serial}`;
    const compare = source.inclusive ? "<=" : "<";
    return concatMapped(
      `(() => { const ${result} = []; const ${start} = ${source.from ? source.from.code : "0"}; const ${bound} = ${source.bound.code}; for (let ${first} = ${start}; ${first} ${compare} ${bound}; ${first}++) { ${result}.push(...(`,
      body,
      `)); } return ${result}; })()`,
    );
  };

  const arrayNodeValue = (
    node: AttributeTagNode,
    as: AttrTagProp["as"],
    valueType: string | null,
  ): MappedCode => {
    if (node.kind === "AttributeTag") {
      return concatMapped("[", attrTagValue(node.tag, as, valueType), "]");
    }
    if (node.kind === "AttributeTagFor")
      return arrayLoopValue(node, as, valueType);

    let alternate = concatMapped("[]");
    for (let index = node.branches.length - 1; index >= 0; index--) {
      const branch = node.branches[index];
      if (!branch) continue;
      const value = arraySourceValue(branch.nodes, as, valueType);
      alternate = branch.test
        ? concatMapped(
            "(",
            branch.test.code,
            " ? ",
            value,
            " : ",
            alternate,
            ")",
          )
        : value;
    }
    return alternate;
  };

  const arraySourceValue = (
    source: AttributeTagNode[],
    as: AttrTagProp["as"],
    valueType: string | null,
  ): MappedCode => {
    if (source.length === 0) return concatMapped("[]");
    const values = source.map((node) => arrayNodeValue(node, as, valueType));
    if (values.length === 1) return values[0] as MappedCode;
    return concatMapped(
      "[",
      ...values.flatMap((value, index) =>
        index === 0 ? ["...(", value, ")"] : [", ...(", value, ")"],
      ),
      "]",
    );
  };

  function attrTagPropValue(
    prop: AttrTagProp,
    ownerType: string | null,
  ): MappedCode {
    const propType =
      prop.declared && ownerType
        ? `NonNullable<(${ownerType})[${quote(prop.name)}]>`
        : null;
    const valueType =
      propType && prop.cardinality === "array"
        ? `(${propType})[number]`
        : propType;
    return prop.cardinality === "array"
      ? arraySourceValue(prop.source, prop.as, valueType)
      : singleSourceValue(prop.source, prop.as, valueType);
  }

  /**
   * `class` and `style` take structured values in Marko, and render as a
   * joined string rather than as the value's own `String()` form.
   *
   * Interpolating the raw value would emit `[object Object]` — a silently
   * wrong attribute rather than a visible failure.
   */
  const structured = (
    name: string,
    code: MappedCode,
  ): MappedCode | undefined => {
    if (name === "class") return concatMapped("__mxClassValue(", code, ")");
    if (name === "style") return concatMapped("__mxStyleValue(", code, ")");
    return undefined;
  };

  /**
   * One attribute into the open tag.
   *
   * Static values are baked into the literal and escaped at compile time, so
   * the emitted double-quoted style is independent of the author's quoting — a
   * single-quoted `title='a" onerror="…'` cannot close the attribute early.
   * A spread emits a runtime loop that validates each key.
   */
  /**
   * An attribute's value expression. A refined bound attribute (`v:fn:=q`)
   * renders as the unrefined one: Marko's change handler (`q = fn(next)`) is
   * client-only and this target renders once. Under `typeCheck` (the tooling
   * projection; never the module that runs) the value is `(false && fn(q), q)`,
   * so `fn` applied to the bound value's type is checked and mapped to the
   * modifier.
   */
  const attributeValue = (attr: Extract<Attr, { value: Expr }>): MappedCode =>
    options.typeCheck && attr.kind === "bound" && attr.refinement
      ? concatMapped(
          "(false && ",
          mappedExpr(attr.refinement),
          `(${attr.value.code}), `,
          mappedExpr(attr.value),
          ")",
        )
      : mappedExpr(attr.value);

  const attribute = (attr: Attr, tag = ""): void => {
    // Spreads are written by `elementAttributes`, never one at a time.
    if (attr.kind === "spread") return;

    if (attr.kind === "boolean") {
      literal(` ${attr.name}`);
      return;
    }

    if (attr.kind === "static") {
      literal(` ${attr.name}="${escape(attr.value)}"`);
      return;
    }

    // `value:=expr` binds two ways in full Marko: the initial value renders,
    // and later edits write back. A one-shot render has no write path, so the
    // initial value is the whole of it, as in Marko's own server render.
    // Phase B of `dom-events` (design note §8): an expression-valued event
    // handler needs a runtime, and this target renders once to a string. A
    // *string*-valued handler (`onclick="…"`) is an ordinary static attribute
    // and passes through verbatim above; only a function value reaches this
    // kind, and it is rejected rather than silently emitted as dead inline JS.
    if (attr.kind === "event") {
      fail(
        `\`${attr.name}\` is an event handler and requires a runtime; @mxlang/target-html renders once to a string`,
        attr,
      );
    }

    const value = attributeValue(attr);
    const source = structured(attr.name, value);
    if (source) {
      // A structured value renders itself; interpolating it into quotes would
      // double-escape the separators the helper already produced.
      push("{");
      state.indent++;
      push(concatMapped("const __mxValue = ", source, ";"));
      push(
        `if (__mxValue !== "") ${state.sink}.write(" ${attr.name}=\\"" + __mxValue + "\\"");`,
      );
      state.indent--;
      push("}");
      return;
    }

    expression(
      concatMapped(
        `__mxRenderAttr(${quote(attr.name)}, `,
        value,
        `, ${quote(tag)}${tag === "input" && attr.name === "checked" ? ", true" : ""})`,
      ),
      false,
    );
  };

  /**
   * An explicit attribute as a JS expression for its rendered text, for the
   * merged-object form below. Same rendering as `attribute`, evaluated where the
   * object is built, so an attribute's expression runs in authored order.
   */
  const attributeText = (
    attr: Exclude<Attr, { kind: "spread" }>,
    tag: string,
  ): MappedCode => {
    switch (attr.kind) {
      case "boolean":
        return concatMapped(quote(` ${attr.name}`));
      case "static":
        return concatMapped(quote(` ${attr.name}="${escape(attr.value)}"`));
      case "event":
        return fail(
          `\`${attr.name}\` is an event handler and requires a runtime; @mxlang/target-html renders once to a string`,
          attr,
        );
      default: {
        const value = attributeValue(attr);
        const source = structured(attr.name, value);
        if (source) {
          return concatMapped(
            `((__mxValue) => __mxValue === "" ? "" : ${quote(` ${attr.name}="`)} + __mxValue + "\\"")(`,
            source,
            ")",
          );
        }
        return concatMapped(
          `__mxRenderAttr(${quote(attr.name)}, `,
          value,
          `, ${quote(tag)})`,
        );
      }
    }
  };

  /**
   * An element's attributes, with Marko's precedence and evaluation order.
   *
   * Marko compiles a tag with a spread to an object merge where the later write
   * wins: the attributes written AFTER the last spread are written first (into
   * the template text, evaluated first) and their names are excluded from the
   * spreads; everything before and between is ONE object built in authored order
   * (`{ ...{a: f()}, ...x, ...{b: g()}, ...y }`), so an attribute's expression
   * runs before the spread that follows it, a key keeps its first slot when a
   * later spread overwrites it, and a `null`/`undefined` spread is ignored. A
   * browser keeps the FIRST duplicate of a concatenated string, so the same
   * result is built explicitly here.
   *
   * `<input>` is the exception, as it is in Marko: its attributes are one merge
   * in authored order, nothing written first, because a controlled `value` is
   * resolved at run time. An `<input>` without a spread writes `value` first (a
   * browser may reset a value when `type` changes after it); that replaces the
   * host's former `orderAttrs` hook, which reordered the IR across spreads.
   *
   * Cost: a tag with a spread builds one object per render. A tag with a single
   * spread and nothing before it iterates the spread directly.
   */
  const elementAttributes = (name: string, attrs: Attr[]): void => {
    const isTextarea = name === "textarea";
    let lastSpread = -1;
    attrs.forEach((attr, index) => {
      if (attr.kind === "spread") lastSpread = index;
    });
    if (lastSpread < 0) {
      const value =
        name === "input"
          ? attrs.find(
              (attr) => attr.kind !== "spread" && attr.name === "value",
            )
          : undefined;
      if (value) attribute(value, name);
      for (const attr of attrs) if (attr !== value) attribute(attr, name);
      return;
    }

    const isInput = name === "input";
    const tail = isInput ? [] : attrs.slice(lastSpread + 1);
    const head = isInput ? attrs : attrs.slice(0, lastSpread + 1);
    for (const attr of tail) {
      if (isTextarea && attr.kind !== "spread" && attr.name === "value") {
        push(concatMapped("__mxTa = ", attributeValueCode(attr), ";"));
      } else attribute(attr, name);
    }
    const written = tail.flatMap((attr) =>
      attr.kind === "spread" ? [] : [attr.name],
    );

    push("{");
    state.indent++;
    let entries: string;
    const only = head.length === 1 ? head[0] : undefined;
    if (only?.kind === "spread") {
      entries = `Object.entries(${only.value.code} ?? {})`;
    } else {
      push("const __mxRaw = Symbol();");
      const parts = head.map((attr): MappedCode => {
        if (attr.kind === "spread") {
          return concatMapped("...", mappedExpr(attr.value));
        }
        const key = JSON.stringify(attr.name);
        // A textarea's `value` is its content, not an attribute: pass the raw
        // value through the merge so a later spread can still override it.
        if (isTextarea && attr.name === "value") {
          return concatMapped(`...{ ${key}: `, attributeValueCode(attr), " }");
        }
        if (attr.kind === "boolean" || attr.kind === "static") {
          return concatMapped(
            `...{ ${key}: { [__mxRaw]: () => `,
            attributeText(attr, name),
            " } }",
          );
        }
        // Evaluate the expression in authored order, but serialize only the
        // surviving merged value. An overwritten object must not throw.
        // The stand-in is generated text: it carries no span, so it maps
        // nowhere, while the authored value maps at its evaluation site.
        const { span: _span, nodes: _nodes, ...standIn } = attr.value;
        const captured = {
          ...attr,
          value: { ...standIn, code: "__mxCapturedValue" },
        };
        return concatMapped(
          `...{ ${key}: ((__mxCapturedValue) => ({ [__mxRaw]: () => `,
          attributeText(captured, name),
          " }))(",
          mappedExpr(attr.value),
          ") }",
        );
      });
      // One object literal with spread syntax, not `Object.assign`: a spread
      // key such as an own enumerable `__proto__` is then defined as data, as in
      // Marko's own merge, instead of hitting the `[[Set]]` setter.
      push(concatMapped("const __mxAttrs = { ", joinParts(parts), " };"));
      entries = "Object.entries(__mxAttrs)";
    }
    push(`for (const [__mxKey, __mxValue] of ${entries}) {`);
    state.indent++;
    if (written.length > 0) {
      push(
        `if (${written.map((n) => `__mxKey === ${JSON.stringify(n)}`).join(" || ")}) continue;`,
      );
    }
    if (only?.kind !== "spread") {
      push(
        `if (__mxValue !== null && typeof __mxValue === "object" && __mxRaw in __mxValue) { ${state.sink}.write(__mxValue[__mxRaw]()); continue; }`,
      );
    }
    // A tail `value` is already in `written` (skipped above), so only a
    // spread-sourced or merged value needs this branch.
    if (isTextarea && !written.includes("value")) {
      push('if (__mxKey === "value") { __mxTa = __mxValue; continue; }');
    }
    push(
      "if (__mxValue === false || __mxValue === null || __mxValue === undefined) continue;",
    );
    push(`if (!${ATTR_NAME_PATTERN}.test(__mxKey)) continue;`);
    push('if (__mxKey === "class" || __mxKey === "style") {');
    state.indent++;
    push(
      'const __mxText = __mxKey === "class" ? __mxClassValue(__mxValue) : __mxStyleValue(__mxValue);',
    );
    push(
      `if (__mxText !== "") ${state.sink}.write(" " + __mxKey + "=\\"" + __mxText + "\\"");`,
    );
    push("continue;");
    state.indent--;
    push("}");
    write(`__mxRenderAttr(__mxKey, __mxValue, ${quote(name)})`);
    state.indent--;
    push("}");
    state.indent--;
    push("}");
  };

  /** A component's props, in Marko's own convention. */
  const propsOf = (
    attrs: Attr[],
    attrTagProps: AttrTagProp[],
    content: Block | null,
    ownerType: string | null,
    untypedCallee = false,
  ): {
    parts: MappedCode[];
    spreads: string[];
  } => {
    // `parts` is built in **source order**, spreads included, because that is
    // what decides precedence: `<C name="a" ...rest name="b"/>` must emit
    // `{ name: "a", ...rest, name: "b" }`, so `rest.name` overrides the first
    // and is overridden by the second. Partitioning spreads out and emitting
    // them first (the shape this replaced) silently inverted that for every
    // key a spread shares with an earlier named prop.
    const parts: MappedCode[] = [];
    const spreads: string[] = [];

    const setProp = (
      name: string,
      value: string | MappedCode,
      span: { sourceStart: number; sourceEnd: number } | null = null,
    ): void => {
      parts.push(concatMapped(mapped(propKey(name), span), ": ", value));
    };

    for (const attr of attrs) {
      switch (attr.kind) {
        case "spread":
          spreads.push(attr.value.code);
          parts.push(concatMapped("...", mappedExpr(attr.value)));
          break;
        case "boolean":
          setProp(attr.name, "true", attr.nameSpan);
          break;
        case "static":
          setProp(attr.name, quote(attr.value), attr.nameSpan);
          break;
        default:
          setProp(attr.name, attributeValue(attr), attr.nameSpan);
      }
    }

    // Cardinality and value shape come from the callee's Input, already
    // resolved by core. The legacy flat occurrence list is retained for
    // tooling only; v2 hosts emit exclusively from this plan.
    for (const prop of attrTagProps) {
      setProp(
        prop.name,
        attrTagPropValue(prop, ownerType),
        attrTagNameSpan(prop.source),
      );
    }

    // Ordinary children become `content`, not `children`: that is the prop
    // name Marko's own `<${input.content}/>` reads.
    if (content) {
      const fn = blockFunction(content.children, content.params.join(", "));
      // A `${expr}` target has no declared `content` to type the body's tag
      // params from (`__mxRenderDynamic` takes `Record<string, any>`), so an
      // unannotated param would be an implicit `any` under strict tsc. The cast
      // is the contextual type: the params are `any`, as the callee is unknown.
      setProp(
        "content",
        untypedCallee && content.hasParams
          ? concatMapped("(", fn, ") as (...args: any[]) => any")
          : fn,
      );
    }

    return { parts, spreads };
  };

  /** The JS value a (non-spread) attribute carries, for `<textarea value>`. */
  const attributeValueCode = (
    attr: Exclude<Attr, { kind: "spread" }>,
  ): MappedCode => {
    if (attr.kind === "boolean") return concatMapped("true");
    if (attr.kind === "static") return concatMapped(quote(attr.value));
    if (attr.kind === "event") {
      return fail(
        `\`${attr.name}\` is an event handler and requires a runtime; @mxlang/target-html renders once to a string`,
        attr,
      );
    }
    return mappedExpr(attr.value);
  };

  /**
   * `<textarea>` renders `value` as its content, as Marko does: escaped,
   * `null`/`undefined`/`false`/`true` as nothing, and a leading newline doubled
   * (the HTML parser drops the first one). A spread's `value` is content too,
   * but a body wins over it. An explicit `value` together with a body is the
   * compile error Marko raises.
   */
  /**
   * A textarea body that holds placeholders, rendered as Marko does. Stock
   * hands the whole body to `_textarea_value`: a lone placeholder passes its
   * raw value (so `NaN` and `0n` print, `false`, `true`, `null` and
   * `undefined` do not), and any other body is one template literal, so every
   * value prints as its string (`anullb`, `afalseb`). Text position's rule
   * (`__mxTextOf`) does not apply. A raw `$!{…}` is an error there, as in
   * Marko.
   */
  const textareaBody = (body: IrNode[]): void => {
    if (!body.some((child) => child.kind === "Interpolation")) {
      drive(emitter, body);
      return;
    }
    const unsupported =
      "Unexpected content in textarea, only text and placeholders are supported.";
    // The newline right after `<textarea>` is dropped at compile time, as in
    // Marko and the HTML parser; `__mxTextareaBody` then doubles a leading
    // newline that is part of the value.
    let children = body;
    const first = body[0];
    if (first?.kind === "Text") {
      const rest = first.value.replace(/^\r?\n/, "");
      if (rest !== first.value) {
        children =
          rest === ""
            ? body.slice(1)
            : [{ ...first, value: rest }, ...body.slice(1)];
      }
    }
    const parts: MappedCode[] = [];
    for (const child of children) {
      if (child.kind === "Text") parts.push(concatMapped(quote(child.value)));
      else if (child.kind === "Interpolation") {
        if (!child.escaped) fail(unsupported, child);
        parts.push(
          concatMapped("__mxEscape(`${", mappedExpr(child.expr), "}`)"),
        );
      } else if (child.kind !== "Comment") fail(unsupported, child);
    }
    const only = children.length === 1 ? children[0] : undefined;
    if (only?.kind === "Interpolation") {
      write(concatMapped("__mxTextareaContent(", mappedExpr(only.expr), ")"));
      return;
    }
    write(
      concatMapped(
        "__mxTextareaBody(",
        ...parts.flatMap((part, index) =>
          index === 0 ? [part] : [" + ", part],
        ),
        ")",
      ),
    );
  };

  const textarea = (node: Extract<IrNode, { kind: "Element" }>): void => {
    const hasSpread = node.attrs.some((attr) => attr.kind === "spread");
    const explicit = node.attrs.find(
      (attr): attr is Exclude<Attr, { kind: "spread" }> =>
        attr.kind !== "spread" && attr.name === "value",
    );
    if (explicit && node.children.length > 0) {
      fail(
        "A textarea cannot have both a value attribute and body content.",
        explicit,
      );
    }
    if (hasSpread) {
      push("{");
      state.indent++;
      push("let __mxTa;");
      literal("<textarea");
      elementAttributes("textarea", node.attrs);
      literal(">");
      if (node.children.length > 0) textareaBody(node.children);
      else write("__mxTextareaContent(__mxTa)");
      literal("</textarea>");
      state.indent--;
      push("}");
      return;
    }
    literal("<textarea");
    elementAttributes(
      "textarea",
      node.attrs.filter((attr) => attr !== explicit),
    );
    literal(">");
    if (explicit) {
      write(
        concatMapped("__mxTextareaContent(", attributeValueCode(explicit), ")"),
      );
    } else textareaBody(node.children);
    literal("</textarea>");
  };

  const emitter: StringEmitter = {
    state,

    text(node) {
      // Marko's own `onText` dropped newline-bearing whitespace runs and
      // collapsed the rest before the lowerer saw them.
      literal(node.value);
    },

    interpolation(node) {
      interpolation(mappedExpr(node.expr), node.escaped);
    },

    element(node) {
      if (node.name === "textarea") return textarea(node);
      literal(`<${node.name}`);
      elementAttributes(node.name, node.attrs);
      literal(">");
      if (node.void) return;
      // An element's body is its own scope for what it declares (Marko 6.4.4
      // scopes a `<const>`, `<let>`, `<define>` or `/var` to the body that
      // writes it), and the children are otherwise written flat into the
      // render function, so a body that declares gets a block of its own.
      const scoped = node.children.some(declaresBinding);
      if (scoped) {
        push("{");
        state.indent++;
      }
      drive(emitter, node.children);
      if (scoped) {
        state.indent--;
        push("}");
      }
      literal(`</${node.name}>`);
    },

    component(node) {
      const target = node.target;
      // A discovered `tags/*.marko` tag is called through the local the
      // module imported it as; everything else by its own name.
      const callee =
        target.kind === "name" ? (target.binding ?? target.name) : "";
      const ownerType =
        target.kind === "name" ? `__MxInputOf<typeof ${callee}>` : null;
      const { parts, spreads } = propsOf(
        node.attrs,
        node.attrTagProps,
        node.content,
        ownerType,
        node.target.kind === "dynamic",
      );
      const joinedParts = concatMapped(
        ...parts.flatMap((part, index) =>
          index === 0 ? [part] : [", ", part],
        ),
      );
      // The call's props object stands for the tag's attributes and body, so
      // its braces map onto the tag name, as JSX hosts report a call's props
      // errors on the name: TypeScript anchors a missing required property
      // or a props mismatch (TS2345) on the whole object, and Volar maps
      // that range through its two ends. Only the braces: an attribute's own
      // mapping inside stays the one an error on that attribute takes.
      // A dynamic target carries no name span. A value-import tag (a `.ts`
      // module) is written as its binding: the call's span starts at its `<`
      // in HTML syntax and at the name in concise syntax, which only the
      // source tells apart. An authored `${expr}` target maps onto the
      // expression.
      const braceSpan = (() => {
        if (node.nameSpan) return node.nameSpan;
        if (node.target.kind !== "dynamic") return null;
        const binding = node.target.valueImportBinding;
        if (binding && node.span && options.source !== undefined) {
          const start =
            node.span.sourceStart +
            (options.source[node.span.sourceStart] === "<" ? 1 : 0);
          return { sourceStart: start, sourceEnd: start + binding.length };
        }
        return binding ? null : (node.target.expr.span ?? node.span ?? null);
      })();
      const propsObject = concatMapped(
        mapped("{", braceSpan),
        parts.length === 0 ? "  " : concatMapped(" ", joinedParts, " "),
        mapped("}", braceSpan),
      );

      if (target.kind === "dynamic") {
        // A native element has nothing to call a params body with, so a
        // literal tag name is Marko 6.3.51's own compile error. A string that
        // arrives at run time is not an error there: it renders the element
        // with the body called with no arguments, which `__mxRenderDynamic`
        // does for a string or an absent target alike.
        if (
          node.content?.hasParams &&
          /^(?:"[^"\\]*"|'[^'\\]*'|`[^`\\$]*`)$/.test(target.expr.code)
        ) {
          fail("Tag does not support parameters.", node);
        }
        // The value may be a component function, a renderable block, or a tag
        // name as a string; all three are resolved at run time by
        // `renderDynamic`, emitted into the module rather than imported.
        // `parts` carries spreads in source order too: dropping them here (the
        // shape this replaced) silently lost every spread on a dynamic tag.
        // The helper writes into the sink and returns the callee's `render`
        // value, which is what a `/var` on the dynamic tag binds.
        push(
          concatMapped(
            node.var ? `const ${node.var} = ` : "",
            `__mxRenderDynamic(${state.sink}, ${target.expr.code}, `,
            propsObject,
            // With call args the callee's first parameter is an arg, not the
            // props object, so the props stay loose.
            node.args.length > 0 ? " as any" : "",
            node.args.length > 0
              ? `, [${node.args.map((arg) => arg.code).join(", ")}]`
              : "",
            ");",
          ),
        );
        return;
      }

      if (target.kind === "define") {
        // Tag arguments are positional, so a spread's keys (known only at run
        // time) cannot fill the trailing params; the no-args call hands the
        // whole object over instead and takes spreads.
        if (node.args.length > 0 && spreads.length > 0) {
          fail(
            `spreading into \`<${target.name}>\` is not supported: a <define> is called positionally, and a spread's keys are only known at run time`,
            node,
          );
        }
        // `<Row(input.a)/>` — Marko's tag-argument form, and the ordinary way
        // to call a `<define>` that declares params.
        //
        // Marko's own shape: args combine with a body/attribute tag (Marko's
        // lenient dynamic-tag rule, `rejectArgsWithProps`; core has already
        // rejected a plain attribute alongside args, so `parts` here only ever
        // holds `content`/attribute-tag values). Measured on stock Marko 6.4.4:
        // the call appends ONE trailing object `{ ...attributeTags, content }`
        // as the next argument, so it lands in the first unfilled parameter
        // and every parameter after it reads `undefined` — nothing is bound
        // by name, not even a parameter that shares an attribute tag's name.
        // When the args already fill every fixed parameter and the define has
        // no rest param Marko drops the extras entirely, so no object is
        // appended; with a rest param the object follows the args wherever
        // they stop (`|a, ...rest|` with `<D(1, 2)>x</D>` reads
        // `rest = [2, { content }]`). Parameters left unfilled are
        // still passed as `undefined` so the call keeps the arity of the
        // function the define declared (a type checker counts a missing
        // argument as an error even though JS tolerates it).
        //
        // Without args the call is Marko's: the attributes (spreads included,
        // in source order), attribute tags and `content` travel as ONE object
        // bound to the first param, `{}` when the call carries none; rest
        // params stay `undefined`. A define with no params ignores them.
        // A rest param is never padded: Marko leaves it `[]` when nothing
        // fills it, and an `undefined` here would make it `[undefined]`.
        const fixedParamCount = target.params.filter(
          (param: string) => !param.trimStart().startsWith("..."),
        ).length;
        const hasRestParam = target.params.length > fixedParamCount;
        const takesObject =
          node.args.length > 0 &&
          (hasRestParam || node.args.length < fixedParamCount) &&
          parts.length > 0;
        const args: Array<string | MappedCode> =
          node.args.length > 0
            ? [
                ...node.args.map((a: Expr) => a.code),
                ...(takesObject ? [propsObject] : []),
                ...Array.from(
                  {
                    length: Math.max(
                      fixedParamCount -
                        node.args.length -
                        (takesObject ? 1 : 0),
                      0,
                    ),
                  },
                  () => "undefined",
                ),
              ]
            : target.params.length > 0
              ? [propsObject]
              : [];
        write(
          concatMapped(
            mapped(target.name, node.nameSpan),
            "(",
            ...args.flatMap((arg, index) =>
              index === 0 ? [arg] : [", ", arg],
            ),
            ")",
          ),
        );
        return;
      }

      // A tag call passes this unit's sink down, and `/var` binds what the
      // callee's `render` returns. A discovered tag, a unit known to declare
      // `<return>`, or this module's own export (a self-recursive tag) is a
      // compiled template, so its `render` is called directly. Anything else
      // may be a hand-written function, a `.ts` barrel re-export of a template,
      // or a template: `__mxRenderTag` renders through `.render` when the
      // callee has one and writes the returned string otherwise. Its type
      // follows that runtime choice: a callee with `render` is called with
      // `render`'s Input, and any other callee is checked exactly as a plain
      // `Callee(props)` call would be.
      if (node.returnsValue || target.binding || callee === selfName) {
        push(
          concatMapped(
            node.var ? `const ${node.var} = ` : "",
            mapped(callee, node.nameSpan),
            ".render(",
            propsObject,
            `, ${state.sink});`,
          ),
        );
        return;
      }

      push(
        concatMapped(
          `__mxRenderTag(${state.sink}, `,
          mapped(callee, node.nameSpan),
          ")(",
          propsObject,
          ");",
        ),
      );
    },

    ifChain(node) {
      node.branches.forEach((branch, index) => {
        if (index === 0) {
          push(`if (${branch.condition?.code}) {`);
        } else if (branch.condition) {
          push(`} else if (${branch.condition.code}) {`);
        } else {
          push("} else {");
        }
        state.indent++;
        drive(emitter, branch.children);
        state.indent--;
      });
      push("}");
    },

    forLoop(node) {
      // `step` was rejected by the core until the Solid host needed it. Now
      // the core carries it and the HTML host rejects it — same message,
      // same oracle numbers.
      if (node.source.kind === "range" && node.source.step) {
        fail(
          "`<for step=...>`: step is not supported; use a computed array",
          node,
        );
      }

      /**
       * Binds a loop's own expressions to temporaries *before* the loop opens.
       *
       * A tag param may legitimately shadow an outer name — `<for|input|
       * of=input.items>` is valid Marko and renders there — but the loop
       * variable is in scope throughout its own head, so emitting `for (const
       * input of input.items)` puts `input.items` in the temporal dead zone
       * and throws at render time. Evaluating the iterable first is what makes
       * an ordinary JS shadow behave the way the author (and Marko) expect.
       *
       * The name counts emitted lines, matching the walk this replaced.
       */
      const bind = (source: string): string => {
        const temp = `__mxFor${state.body.length}`;
        push(`const ${temp} = ${source};`);
        return temp;
      };

      const [first = "__mxItem", second] = node.params;
      const source = node.source;

      if (source.kind === "of") {
        const raw = bind(source.list.code);
        const list = bind(`${raw} ? ${raw} : []`);
        if (second) {
          push(`for (const [${second}, ${first}] of [...${list}].entries()) {`);
        } else {
          push(`for (const ${first} of ${list}) {`);
        }
      } else if (source.kind === "in") {
        const object = bind(`${source.object.code} ?? {}`);
        const entry = second ? `[${first}, ${second}]` : `[${first}]`;
        push(`for (const ${entry} of Object.entries(${object})) {`);
      } else {
        const start = bind(source.from ? source.from.code : "0");
        const bound = bind(source.bound.code);
        const compare = source.inclusive ? "<=" : "<";
        push(
          `for (let ${first} = ${start}; ${first} ${compare} ${bound}; ${first}++) {`,
        );
      }

      state.indent++;
      drive(emitter, node.children);
      state.indent--;
      push("}");
    },

    define(node) {
      const fn = blockFunction(node.children, node.params.join(", "));
      if (node.attrs.length === 0) {
        push(concatMapped(`const ${node.name} = `, fn, ";"));
        return;
      }
      // Marko: the tag's attributes are properties of the define's value
      // (`const D = { a: 1, content }`), so `${D.a}` reads them. The value here
      // is the function a call runs, which carries them as own properties.
      const { open, between } = defineValueWrapper(node.attrs);
      push(
        concatMapped(
          `const ${node.name} = ${open}`,
          fn,
          between,
          "{ ",
          joinParts(propPartsOfAttrs(node.attrs)),
          " });",
        ),
      );
    },

    constant(node) {
      push(`const ${node.name} = ${node.init.code};`);
    },

    hoisted(node) {
      state.prelude.push(node.code);
    },

    delegatedTag(node) {
      emitDelegatedTag(node.tag);
    },

    documentType(node) {
      literal(`<!${node.value}>`);
    },

    comment(node) {
      // Stock Marko drops every comment; MX keeps `<!-- -->` and treats `//`
      // as author-only. This host follows Marko: nothing is emitted, and
      // `<html-comment>` is how an author emits one that survives.
      void node;
    },

    done() {
      return state.body;
    },
  };

  /**
   * `<html-script>`: a real `<script>` element with every attribute kept and
   * the body written as script text, as Marko's html output writes it
   * (`_escape_script` over the body with `_to_text` placeholders, never the
   * HTML escape).
   *
   * The escape runs over the joined body, not per piece: `<` in the text and
   * `/script>` in a placeholder are each harmless alone, and a `</script>`
   * together. A body of static text is escaped here at compile time.
   *
   * Marko also writes `nonce` from the render's `$global.cspNonce` when the
   * author gives none; this target has no render global, so a nonce is the
   * `nonce=` attribute the author writes, and none is invented.
   */
  function scriptElement(tag: DelegatedTag): void {
    literal("<script");
    elementAttributes("script", tag.attrs);
    literal(">");
    const parts: Array<string | MappedCode> = [];
    let dynamic = false;
    for (const child of tag.children) {
      if (child.kind === "Text") parts.push(quote(child.value));
      else if (child.kind === "Interpolation") {
        dynamic = true;
        parts.push(concatMapped("__mxTextOf(", mappedExpr(child.expr), ")"));
      } else {
        fail(
          "`<html-script>` takes only text and placeholders; markup in its body would be dropped from the script",
          child,
        );
      }
    }
    if (!dynamic) {
      const text = tag.children
        .map((child) => (child.kind === "Text" ? child.value : ""))
        .join("");
      literal(escapeScript(text));
    } else {
      write(
        concatMapped(
          "__mxEscapeScript(",
          ...parts.flatMap((part, index) =>
            index === 0 ? [part] : [" + ", part],
          ),
          ")",
        ),
      );
    }
    literal("</script>");
  }

  /**
   * The tags this host claims for itself, each with its parts already
   * resolved.
   *
   * `data` is what `resolveDelegatedTag` decided while the Marko node was still in
   * hand, so nothing here re-inspects one.
   */
  function emitDelegatedTag(tag: DelegatedTag): void {
    const data = tag.data as DelegatedTagData;

    switch (data.kind) {
      case "binding": {
        // `<let>` is reactive state in full Marko, but its *initial value* is
        // an ordinary expression Marko's own server render evaluates and
        // renders. With no update path in a one-shot render, binding it as a
        // `const` reproduces Marko's output exactly.
        push(`const ${tag.var} = ${data.init};`);
        return;
      }
      case "statement": {
        // A `server` block is server-side code, and this *is* the server
        // render, so it runs — hoisting to module scope exactly as `static`
        // does. Classifying it as inert would silently drop a binding the rest
        // of the template reads.
        // The tooling projection types a `client` statement in two views: the
        // server module (every name it declares is `undefined`, none is
        // exported) and the client code, kept in a function of its own. The
        // module that runs keeps the `var` of its names.
        if (options.typeCheck && data.typeCheck) {
          const projection = data.typeCheck;
          const lines: Array<string | MappedCode> = [];
          if (projection.serverNames.length > 0) {
            // `void` reads the names, so `noUnusedLocals` does not flag a
            // declaration the author never wrote.
            lines.push(
              `var ${projection.serverNames.map((name) => `${name}: undefined`).join(", ")}; void [${projection.serverNames.join(", ")}];`,
            );
          }
          for (const hoisted of projection.hoisted) {
            lines.push(clientPiece(hoisted));
          }
          for (const type of projection.types) {
            state.clientTypes.push({ type, start: data.start });
          }
          for (const list of projection.typeExports) {
            state.clientTypeExports.push({ list, start: data.start });
          }
          state.clientNames.push(...projection.serverNames);
          state.clientListed.push(...projection.listed);
          if (
            data.start !== undefined &&
            (state.clientStart === undefined || data.start > state.clientStart)
          ) {
            state.clientStart = data.start;
          }
          if (lines.length > 0) {
            state.moduleHoisted.push({
              code: concatMapped(
                ...lines.flatMap((line, index) =>
                  index === 0 ? [line] : ["\n", line],
                ),
              ),
              start: data.start,
            });
          }
          for (const piece of projection.body) {
            // A statement keeps its own `;`; one without gets it, so the
            // next line cannot join it by automatic semicolon insertion.
            state.clientBody.push(
              piece.code.endsWith(";")
                ? clientPiece(piece)
                : concatMapped(clientPiece(piece), ";"),
            );
          }
          for (const name of projection.exportedTypes) {
            state.clientBody.push(
              concatMapped(`void (null as unknown as [${name}]);`),
            );
          }
          if (projection.exported.length > 0) {
            state.clientBody.push(
              concatMapped(`void [${projection.exported.join(", ")}];`),
            );
          }
          for (const span of projection.returns) {
            state.clientReturns.push(concatMapped(mapped("return", span), ";"));
          }
          return;
        }
        if (data.code !== "") {
          state.moduleHoisted.push({
            code: mapped(data.code, data.span ?? null),
            start: data.start,
          });
        }
        return;
      }
      case "html-comment": {
        literal("<!--");
        // Marko's `_escape_comment`/`_unescaped` render nothing for a falsy
        // value except `0`, and a comment with placeholders but no static
        // text at all falls back to `" "`, so it never emits `<!---->`.
        const hasText = tag.children.some((child) => child.kind === "Text");
        const values: string[] = [];
        for (const child of tag.children) {
          if (child.kind === "Text") {
            // A static run is escaped at compile time by the same rule, and
            // merged into the surrounding literal so a fully static comment
            // stays one `out +=`.
            if (values.length > 0) {
              write(values.join(" + "));
              values.length = 0;
            }
            literal(escapeComment(child.value));
          } else if (child.kind === "Interpolation") {
            values.push(
              `__mxEscapeComment(${child.expr.code}, ${child.escaped})`,
            );
          } else if (child.kind !== "Comment") {
            fail(
              "`<html-comment>` takes only text and placeholders; a comment cannot contain markup",
              child,
            );
          }
        }
        if (values.length > 0) {
          const joined = values.join(" + ");
          write(hasText ? joined : `(${joined}) || " "`);
        }
        literal("-->");
        return;
      }
      case "raw-element": {
        // `<html-script>`/`<html-style>` are Marko's spelling of a literal
        // `<script>`/`<style>` element, since the bare names are core tags.
        if (data.tag === "script") {
          scriptElement(tag);
          return;
        }
        write(quote(`<${data.tag}>`));
        for (const child of tag.children) {
          if (child.kind === "Text") write(quote(child.value));
          else if (child.kind === "Interpolation") {
            interpolation(mappedExpr(child.expr), child.escaped);
          }
        }
        write(quote(`</${data.tag}>`));
        return;
      }
      case "style": {
        // `<style>` is a core tag in Marko (scoped styles); its body is raw
        // text.
        const text = tag.children
          .filter(
            (c): c is Extract<IrNode, { kind: "Text" }> => c.kind === "Text",
          )
          .map((c) => c.value)
          .join("");
        write(quote(`<style>${text}</style>`));
        return;
      }
      case "try": {
        // A `<try>` without a `<@placeholder>` is a plain try/catch: the body
        // renders into a buffered sub-sink that is committed only when it
        // finishes, so a throw drops the half-rendered body and `<@catch>`
        // renders in its place, as in Marko 6.4.4.
        const katch = tag.attributeTags.find((t) => t.name === "catch");
        if (!katch) {
          // Without `<@catch>` Marko rethrows: the error propagates out of the
          // render (or to an enclosing `<try>`, whose own sub-sink drops this
          // body's output too). Nothing is caught, so nothing needs buffering;
          // the block only keeps the body's bindings scoped as before.
          push("{");
          state.indent++;
          drive(emitter, tag.children);
          state.indent--;
          push("}");
          return;
        }
        const outerSink = state.sink;
        const trySink = `__mxTry${state.tryTemp++}`;
        push(`const ${trySink} = __mxCreateBufferedOut(${outerSink});`);
        push("try {");
        state.indent++;
        state.sink = trySink;
        drive(emitter, tag.children);
        state.sink = outerSink;
        push(`${trySink}.commit();`);
        state.indent--;
        push(`} catch (${katch.block.params.join(", ") || "__mxError"}) {`);
        state.indent++;
        drive(emitter, katch.block.children);
        state.indent--;
        push("}");
        return;
      }
      case "dynamic": {
        // The children are the ones the **core** already resolved into
        // `tag.children`. Re-resolving them in `resolveDelegatedTag` (the shape
        // this replaced) walked the same Marko nodes a second time, which
        // replayed every lowerer side effect — hoists and binding
        // registrations — and made nested dynamic tags lower exponentially.
        const content: Block | null =
          tag.children.length > 0
            ? {
                // The body's tag params (`<${L}|item, i|>…</>`) bind in the
                // content, as they do for a named component call; the callee
                // calls `content(item, i)`.
                hasParams: tag.params.length > 0,
                params: tag.params,
                children: tag.children,
                loc: tag.loc,
              }
            : null;
        emitter.component({
          kind: "Component",
          target: { kind: "dynamic", expr: data.expr } as ComponentTarget,
          nameSpan: null,
          ...(tag.span ? { span: tag.span } : {}),
          // Spreads included: `renderDynamic` receives them in source order
          // like any other component call.
          attrs: tag.attrs,
          content,
          // `tag.attributeTags` is what the core already resolved for this
          // `DelegatedTag` — forwarding it is what keeps `<${expr}><@header>…</@header></>`
          // from silently dropping the attribute tag (measured against Marko
          // 6.4.4: attribute tags on a dynamic tag ARE forwarded).
          attributeTags: tag.attributeTags,
          // `<${Tag}/n/>` binds the callee's `render` value, as Marko 6.4.4
          // does; dropping it here was `dynamic-tag-var-silent-drop`.
          var: tag.var,
          attributeTagTree: tag.attributeTagTree,
          attrTagProps: tag.attrTagProps,
          args: tag.args ?? [],
          loc: tag.loc,
        });
        return;
      }
    }
  }

  return emitter;
}

/**
 * Does this node declare a name in the block it sits in? A `<const>`, a
 * `<let>`, a `<define>`, a `/var` on a tag call, or a delegated tag that binds
 * its `/var`: each is written as a `const` where the node stands.
 */
function declaresBinding(node: IrNode): boolean {
  switch (node.kind) {
    case "Const":
    case "Define":
      return true;
    case "Component":
      return Boolean(node.var);
    case "DelegatedTag":
      return (
        Boolean(node.tag.var) ||
        (node.tag.data as DelegatedTagData | undefined)?.kind === "binding"
      );
    default:
      return false;
  }
}

/** One slice of a `client` statement's code, mapped to where the author wrote it. */
function clientPiece(piece: ClientPiece): MappedCode {
  if (piece.parts) {
    return concatMapped(
      ...piece.parts.map((part) => mapped(part.code, part.span ?? null)),
    );
  }
  return mapped(piece.code, piece.span ?? null);
}

/**
 * Under `typeCheck`, decides where each interface and type alias of a `client`
 * statement stands, and places the function that holds the client code.
 *
 * A type stays at module level (the template, `Input` and the importers of
 * the page read it there) unless it mentions a client value, which is
 * `undefined` there; it then moves into the client scope, with the types that
 * mention it in turn. The function is called where the last `client` statement
 * stands, in the order the author wrote the module, so a client statement
 * that reads a `static` or `server` name declared after it is still reported
 * as used before its declaration.
 */
function placeClientCode(state: State): void {
  const blocked = new Set(state.clientNames);
  const moved = new Set<ClientType>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { type } of state.clientTypes) {
      if (moved.has(type) || !type.refs.some((name) => blocked.has(name))) {
        continue;
      }
      moved.add(type);
      blocked.add(type.name);
      changed = true;
    }
  }
  const movedNames = new Set([...moved].map((type) => type.name));
  const listed = new Set(
    state.clientTypeExports.flatMap(({ list }) =>
      list.specifiers.map((specifier) => specifier.local),
    ),
  );
  const inScope: MappedCode[] = [];
  for (const { type, start } of state.clientTypes) {
    if (moved.has(type)) {
      inScope.push(clientPiece(type.bodyPiece));
      // Exported in the source, so unread here would be `noUnusedLocals`
      // noise the author never had.
      if (type.exported || listed.has(type.name)) {
        const fill =
          type.arity > 0 ? `<${"any, ".repeat(type.arity - 1)}any>` : "";
        inScope.push(
          concatMapped(`void (null as unknown as [${type.name}${fill}]);`),
        );
      }
    } else state.moduleHoisted.push({ code: clientPiece(type.piece), start });
  }
  // A type in the client scope is not an export of the module.
  for (const { list, start } of state.clientTypeExports) {
    const kept = list.specifiers.filter(
      (specifier) => !movedNames.has(specifier.local),
    );
    if (kept.length === 0) continue;
    state.moduleHoisted.push({
      code: concatMapped(
        "export type { ",
        ...kept.flatMap((specifier, index) => [
          ...(index > 0 ? [", "] : []),
          clientPiece(specifier.piece),
        ]),
        " };",
      ),
      start,
    });
  }
  // `client export { a }` reads `a` where it ends, whichever side of the
  // declaration it stands on (an export list is hoisted).
  const listedValues = [...new Set(state.clientListed)].filter((name) =>
    state.clientNames.includes(name),
  );
  const body = [
    ...inScope,
    ...state.clientBody,
    ...(listedValues.length > 0
      ? [concatMapped(`void [${listedValues.join(", ")}];`)]
      : []),
  ];
  if (body.length === 0) return;
  state.moduleHoisted.push({
    code: concatMapped(
      "(async () => {\n",
      ...body.map((code) => concatMapped(INDENT, code, "\n")),
      "})();",
    ),
    start: state.clientStart,
  });
}

/**
 * The `static`/`export` statements and the host's own hoisted statements
 * (`server`, `client`) in the order the author wrote them, as Marko emits
 * them. A host statement with no known position follows the rest.
 */
function inSourceOrder(
  authored: Ir["hoisted"],
  own: Array<{ code: MappedCode; start: number | undefined }>,
): Array<string | MappedCode> {
  const entries: Array<{ code: MappedCode; start: number | undefined }> =
    authored
      .filter((node) => node.code !== "")
      .map((node) => ({
        code: { code: node.code, mappings: [] },
        start: node.span?.sourceStart,
      }));
  for (const statement of own) {
    const { start } = statement;
    const before =
      start === undefined
        ? -1
        : entries.findIndex(
            (entry) => entry.start !== undefined && entry.start > start,
          );
    if (before === -1) entries.push(statement);
    else entries.splice(before, 0, statement);
  }
  // A statement without a closing `;` ends at the newline only when the next
  // line cannot continue it, and `(`, `[`, a template, `+`, `-` and `/` can
  // (`server let x = a` then `static (() => {})()` is one call). A `;` on its
  // own line ends it, and a trailing `// comment` cannot swallow it.
  return entries.flatMap((entry, index) => {
    // Always, never "only when the previous text ends in `;`": that text can
    // end in a `// comment;`, and an empty statement is harmless.
    const joins = index > 0 && /^\s*[([`+\-/]/.test(entry.code.code);
    return joins ? [";", entry.code] : [entry.code];
  });
}

/**
 * Builds the emitted TypeScript module for one resolved template.
 *
 * The module shape is fixed (S3): the runtime import, the author's hoisted
 * module scope, their `Input` interface, then the two entries:
 *
 * - the default export, `(input) => string`, named after the file: it creates
 *   a sink, renders into it, and returns the string;
 * - `render(input, out)` (declared as `__mxRender`, so it cannot collide with
 *   an author's own `render`), which writes to `out` and returns the
 *   `<return>` value. It is also reachable as `<Name>.render`, which is how a
 *   caller holding only the default export (a dynamic tag, a barrel
 *   re-export) renders into its own sink.
 */
export function emitModuleWithMappings(
  ir: Ir,
  escapeFrom: string,
  options: { typeCheck?: boolean; source?: string } = {},
): MappedCode {
  const name = moduleExportName(ir, "@mxlang/target-html");
  const emitter = createEmitter(name, options);
  drive(emitter, ir.body);
  const body = emitter.done();
  const buffered = body.some((line) => line.includes("__mxCreateBufferedOut("));

  const lines: Array<string | MappedCode> = [
    `import { escape as __mxEscape, createOut as __mxCreateOut, ${
      buffered ? "createBufferedOut as __mxCreateBufferedOut, " : ""
    }type Out as __MxOut } from "${escapeFrom}";`,
  ];
  if (ir.needsAttrTagImport) {
    lines.push(`import type { AttrTag } from "${escapeFrom}";`);
  }
  placeClientCode(emitter.state);
  const hoisted = [
    ...ir.imports.map((node) => node.code),
    ...inSourceOrder(ir.hoisted, emitter.state.moduleHoisted),
  ];
  const inputType = ir.tagMetadata.readsContent
    ? "Input & { content?: () => string }"
    : "Input";
  if (hoisted.length > 0) lines.push("", ...hoisted);
  lines.push(
    "",
    ir.inputInterface?.code ?? "export interface Input {}",
    "",
    // Named after the file, never anonymous: a tag whose template calls its
    // own name resolves to this declaration, so self-recursion needs no
    // self-import (design invariant §7.5-7).
    `export default function ${name}(input: ${inputType}): string {`,
    `${INDENT}const __mxOut = __mxCreateOut();`,
    `${INDENT}__mxRender(input, __mxOut);`,
    `${INDENT}return __mxOut.toString();`,
    "}",
    `${name}.render = __mxRender;`,
    "",
    // A unit that declares `<return>` returns the value from `render` and
    // writes its output to the sink, so the value never travels in the output.
    // Its return type is left un-annotated so it is *inferred* from the
    // `<return>` expression: that inference is what gives a `/var` binding at
    // the call site its type (C6).
    `function __mxRender(input: ${inputType}, __mxOut: __MxOut)${
      ir.returnValue ? "" : ": void"
    } {`,
    // Hoisted statements precede the body, so a hoisted declaration is in
    // scope for all of it.
    ...[...ir.prelude.map((node) => node.code), ...emitter.state.prelude].map(
      (code) => INDENT + code,
    ),
    ...body.map((code, index) => ({
      code,
      mappings: emitter.state.bodyMappings[index] ?? [],
    })),
    ...(ir.returnValue ? [`${INDENT}return ${ir.returnValue.code};`] : []),
    "}",
    "export { __mxRender as render };",
    // A module cannot load with a top-level `return`; the function above would
    // hide it, so each one stands here too, at the author's token.
    ...emitter.state.clientReturns,
    "",
  );
  return concatMapped(
    ...lines.flatMap((line, index) =>
      index === lines.length - 1 ? [line] : [line, "\n"],
    ),
  );
}

export function emitModule(ir: Ir, escapeFrom: string): string {
  return emitModuleWithMappings(ir, escapeFrom).code;
}

export { DYNAMIC };
