/**
 * The vanilla HTML host's string emitter, over `@mxlang/core`'s IR
 * (decision 79).
 *
 * The core lowers a template to an `Ir`; this file turns that tree into the
 * emitted module's lines. Nothing here walks a Marko node: every decision was
 * already made by `lower()`, and what arrives is kinds, printed expressions
 * and positions.
 *
 * ## Byte compatibility is the whole contract
 *
 * This replaced an emitting walk whose output is pinned three ways: this
 * package's own test suite asserts the module shape, `@mxlang/astro`'s
 * `vite-pages.ts` text-matches the emitted tail to wrap a page, and
 * `oracle:marko` renders every fixture and compares the HTML against real
 * Marko. So the output is reproduced exactly, not merely equivalently —
 * including the literal merging, the `$forN` temporaries, and the spacing
 * inside a component's props object.
 *
 * Two of those are worth naming because they look accidental and are not:
 *
 * - **Literals merge across node boundaries.** An element's tag, its
 *   attributes and the text after it become one `out += "…"`, because
 *   `emitLiteral` folds into the preceding line when it is a literal append.
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
  moduleExportName,
  propKey,
  quote,
  TranslateError,
  VOID_TAGS,
} from "@mxlang/core";
import type { DelegatedTagData } from "./translate.ts";
import { DYNAMIC, escapeComment } from "./translate.ts";

const INDENT = "  ";

/**
 * A well-formed HTML attribute name, as source text for the emitted module.
 *
 * Validates spread keys, which are only known at run time. Anything containing
 * a space, quote, `/` or `>` could end the attribute name and start live markup
 * inside the tag, so it is skipped rather than emitted (decisions 42/44).
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
   * A `server` block is the only one: it is server-side code and this *is* the
   * server render, so it runs once per module and its bindings are readable
   * from the template. Putting it in `prelude` instead would place it inside
   * the render function, where `static`'s own siblings are not — verified by
   * the suite, which asserts the binding appears *above* `function render`.
   */
  moduleHoisted: string[];
  indent: number;
  /**
   * Serial for the temps a `/var` call site binds its result to.
   *
   * Per emit rather than on the IR: one MX IR is emitted by six host
   * emitters, and a generated name cached on shared IR is exactly the bug
   * Marko paid for by sharing uid counters between its two backends
   * (invariant §7.5-6).
   */
  returnTemp: number;
  /** Serial for local arrays and source temporaries in attribute-tag loops. */
  attrTagTemp: number;
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
export function createEmitter(): StringEmitter {
  const state: State = {
    body: [],
    bodyMappings: [],
    prelude: [],
    moduleHoisted: [],
    indent: 1,
    returnTemp: 0,
    attrTagTemp: 0,
  };

  const push = (line: string | MappedCode): void => {
    const emitted = concatMapped(INDENT.repeat(state.indent), line);
    state.body.push(emitted.code);
    state.bodyMappings.push(emitted.mappings);
  };

  /**
   * Appends a run of literal HTML, merging into the preceding `out +=`.
   *
   * An element's tag, attributes and text would otherwise each take a line.
   */
  const literal = (text: string): void => {
    if (text === "") return;
    const last = state.body[state.body.length - 1];
    const prefix = INDENT.repeat(state.indent);
    if (last?.startsWith(`${prefix}out += "`) && last.endsWith('";')) {
      const existing = JSON.parse(last.slice(prefix.length + 7, -1)) as string;
      state.body[state.body.length - 1] =
        `${prefix}out += ${quote(existing + text)};`;
      return;
    }
    push(`out += ${quote(text)};`);
  };

  const expression = (code: string, escaped: boolean): void => {
    push(`out += ${escaped ? `escape(${code})` : `(${code})`};`);
  };

  /**
   * Renders a child list as a self-contained `() => string` function.
   *
   * The body gets its own `out` local, so a block never appends to the
   * enclosing template's buffer and can be called zero or many times by the
   * component that receives it.
   */
  const blockFunction = (children: IrNode[], params = ""): MappedCode => {
    const outerBody = state.body;
    const outerBodyMappings = state.bodyMappings;
    const outerPrelude = state.prelude;
    const outerIndent = state.indent;
    state.body = [];
    state.bodyMappings = [];
    state.prelude = [];
    state.indent = outerIndent + 1;
    push('let out = "";');
    drive(emitter, children);
    push("return out;");
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
        return concatMapped(`...${attr.value.code}`);
      }
      const value =
        attr.kind === "boolean"
          ? "true"
          : attr.kind === "static"
            ? quote(attr.value)
            : attr.value.code;
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
        ? concatMapped("((", content, `) satisfies ${valueType})`)
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
      ? concatMapped("(", value, ` satisfies ${valueType})`)
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
    const result = `$attrTags${serial}`;
    const sourceName = `$attrTagSource${serial}`;
    const [first = "item", second] = node.loop.params;
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

    const start = `$attrTagStart${serial}`;
    const bound = `$attrTagBound${serial}`;
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
  const structured = (name: string, code: string): string | undefined => {
    if (name === "class") return `classValue(${code})`;
    if (name === "style") return `styleValue(${code})`;
    return undefined;
  };

  /**
   * One attribute into the open tag.
   *
   * Static values are baked into the literal and escaped at compile time, so
   * the emitted double-quoted style is independent of the author's quoting — a
   * single-quoted `title='a" onerror="…'` cannot close the attribute early
   * (decision 42). A spread emits a runtime loop that validates each key.
   */
  const attribute = (attr: Attr): void => {
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
    // initial value is the whole of it — decision 65's "evaluate initial
    // value" row, and what Marko's own server render emits.
    if (attr.kind === "bound") {
      const source = structured(attr.name, attr.value.code);
      literal(` ${attr.name}="`);
      expression(source ?? attr.value.code, true);
      literal('"');
      return;
    }

    // Phase B of `dom-events` (decision 101, design note §8): an expression-
    // valued event handler needs a runtime, and this target renders once to
    // a string. A *string*-valued handler (`onclick="…"`) is an ordinary
    // static attribute and passes through verbatim above; only a function
    // value reaches this kind, and it is rejected rather than silently
    // emitted as dead inline JS.
    if (attr.kind === "event") {
      fail(
        `\`${attr.name}\` is an event handler and requires a runtime; @mxlang/html renders once to a string`,
        attr,
      );
    }

    const source = structured(attr.name, attr.value.code);
    if (source) {
      // A structured value renders itself; interpolating it into quotes would
      // double-escape the separators the helper already produced.
      push("{");
      state.indent++;
      push(`const value = ${source};`);
      push(`if (value !== "") out += " ${attr.name}=\\"" + value + "\\"";`);
      state.indent--;
      push("}");
      return;
    }

    literal(` ${attr.name}="`);
    expression(attr.value.code, true);
    literal('"');
  };

  /**
   * An explicit attribute as a JS expression for its rendered text, for the
   * merged-object form below. Same rendering as `attribute`, evaluated where the
   * object is built, so an attribute's expression runs in authored order.
   */
  const attributeText = (attr: Exclude<Attr, { kind: "spread" }>): string => {
    switch (attr.kind) {
      case "boolean":
        return quote(` ${attr.name}`);
      case "static":
        return quote(` ${attr.name}="${escape(attr.value)}"`);
      case "bound": {
        const source = structured(attr.name, attr.value.code);
        return `${quote(` ${attr.name}="`)} + escape(${source ?? attr.value.code}) + "\\""`;
      }
      case "event":
        return fail(
          `\`${attr.name}\` is an event handler and requires a runtime; @mxlang/html renders once to a string`,
          attr,
        );
      default: {
        const source = structured(attr.name, attr.value.code);
        if (source) {
          return `((value) => value === "" ? "" : ${quote(` ${attr.name}="`)} + value + "\\"")(${source})`;
        }
        return `${quote(` ${attr.name}="`)} + escape(${attr.value.code}) + "\\""`;
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
   * (`Object.assign({}, {a: f()}, x, {b: g()}, y)`), so an attribute's expression
   * runs before the spread that follows it, a key keeps its first slot when a
   * later spread overwrites it, and a `null`/`undefined` spread is ignored. A
   * browser keeps the FIRST duplicate of a concatenated string, so the same
   * result is built explicitly here (decision 135 and its addendum).
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
      if (value) attribute(value);
      for (const attr of attrs) if (attr !== value) attribute(attr);
      return;
    }

    const isInput = name === "input";
    const tail = isInput ? [] : attrs.slice(lastSpread + 1);
    const head = isInput ? attrs : attrs.slice(0, lastSpread + 1);
    for (const attr of tail) attribute(attr);
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
      push("const $raw = Symbol();");
      const parts = head.map((attr) =>
        attr.kind === "spread"
          ? attr.value.code
          : `{ ${JSON.stringify(attr.name)}: { [$raw]: ${attributeText(attr)} } }`,
      );
      push(`const $attrs = Object.assign({}, ${parts.join(", ")});`);
      entries = "Object.entries($attrs)";
    }
    push(`for (const [key, value] of ${entries}) {`);
    state.indent++;
    if (written.length > 0) {
      push(
        `if (${written.map((n) => `key === ${JSON.stringify(n)}`).join(" || ")}) continue;`,
      );
    }
    if (only?.kind !== "spread") {
      push(
        'if (value !== null && typeof value === "object" && $raw in value) { out += value[$raw]; continue; }',
      );
    }
    push(
      "if (value === false || value === null || value === undefined) continue;",
    );
    push(`if (!${ATTR_NAME_PATTERN}.test(key)) continue;`);
    push(
      'out += value === true ? " " + key : " " + key + "=\\"" + escape(value) + "\\"";',
    );
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
  ): {
    parts: MappedCode[];
    named: Map<string, string>;
    spreads: string[];
  } => {
    // `parts` is built in **source order**, spreads included, because that is
    // what decides precedence: `<C name="a" ...rest name="b"/>` must emit
    // `{ name: "a", ...rest, name: "b" }`, so `rest.name` overrides the first
    // and is overridden by the second. Partitioning spreads out and emitting
    // them first (the shape this replaced) silently inverted that for every
    // key a spread shares with an earlier named prop.
    const parts: MappedCode[] = [];
    // The named values alone, for the positional `<define>` lookup, which asks
    // by parameter name rather than by position in the source.
    const named = new Map<string, string>();
    const spreads: string[] = [];

    const setNamed = (
      name: string,
      value: string | MappedCode,
      span: { sourceStart: number; sourceEnd: number } | null = null,
    ): void => {
      named.set(name, typeof value === "string" ? value : value.code);
      parts.push(concatMapped(mapped(propKey(name), span), ": ", value));
    };

    for (const attr of attrs) {
      switch (attr.kind) {
        case "spread":
          spreads.push(attr.value.code);
          parts.push(concatMapped(`...${attr.value.code}`));
          break;
        case "boolean":
          setNamed(attr.name, "true", attr.nameSpan);
          break;
        case "static":
          setNamed(attr.name, quote(attr.value), attr.nameSpan);
          break;
        default:
          setNamed(attr.name, attr.value.code, attr.nameSpan);
      }
    }

    // Decision 106: cardinality and value shape come from the callee's Input,
    // already resolved by core. The legacy flat occurrence list is retained
    // for tooling only; v2 hosts emit exclusively from this plan.
    for (const prop of attrTagProps) {
      setNamed(
        prop.name,
        attrTagPropValue(prop, ownerType),
        attrTagNameSpan(prop.source),
      );
    }

    // Ordinary children become `content`, not `children`: that is the prop
    // name Marko's own `<${input.content}/>` reads.
    if (content) {
      setNamed(
        "content",
        blockFunction(content.children, content.params.join(", ")),
      );
    }

    return { parts, named, spreads };
  };

  const emitter: StringEmitter = {
    state,

    text(node) {
      // Already decision 33: Marko's own `onText` dropped newline-bearing
      // whitespace runs and collapsed the rest before the lowerer saw them.
      literal(node.value);
    },

    interpolation(node) {
      expression(node.expr.code, node.escaped);
    },

    element(node) {
      literal(`<${node.name}`);
      elementAttributes(node.name, node.attrs);
      literal(">");
      if (node.void || VOID_TAGS.has(node.name)) return;
      drive(emitter, node.children);
      literal(`</${node.name}>`);
    },

    component(node) {
      const target = node.target;
      // A discovered `tags/*.marko` tag is called through the local the
      // module imported it as; everything else by its own name.
      const callee =
        target.kind === "name" ? (target.binding ?? target.name) : "";
      const ownerType =
        target.kind === "name" ? `Parameters<typeof ${callee}>[0]` : null;
      const { parts, named, spreads } = propsOf(
        node.attrs,
        node.attrTagProps,
        node.content,
        ownerType,
      );
      const joinedParts = concatMapped(
        ...parts.flatMap((part, index) =>
          index === 0 ? [part] : [", ", part],
        ),
      );

      if (target.kind === "dynamic") {
        // The value may be a component function, a renderable block, or a tag
        // name as a string; all three are resolved at run time by
        // `renderDynamic`, emitted into the module rather than imported.
        // `parts` carries spreads in source order too: dropping them here (the
        // shape this replaced) silently lost every spread on a dynamic tag.
        push(
          concatMapped(
            `out += renderDynamic(${target.expr.code}, { `,
            joinedParts,
            " }",
            node.args.length > 0
              ? `, [${node.args.map((arg) => arg.code).join(", ")}]`
              : "",
            ");",
          ),
        );
        return;
      }

      if (target.kind === "define") {
        if (spreads.length > 0) {
          fail(
            `spreading into \`<${target.name}>\` is not supported: a <define> is called positionally, and a spread's keys are only known at run time`,
            node,
          );
        }
        // `<Row(input.a)/>` — Marko's tag-argument form, and the ordinary way
        // to call a `<define>` that declares params. Falling back to the
        // named-prop lookup keeps `<Row it=x/>` working for the same define.
        //
        // Decision 109: args now combine with a body/attribute tag (Marko's
        // own lenient dynamic-tag rule, `rejectArgsWithProps`; core has
        // already rejected a plain attribute alongside args, so `named` here
        // only ever holds `content`/attribute-tag values). A `<define>` has no
        // declared `Input` to destructure a single trailing props object
        // against — measured against real Marko 6.3.51: its own codegen for
        // this exact shape (`Card('a')><@head>H</@head></Card>` against
        // `<define/Card|title, head|>`) binds `head` to the whole
        // `{ head: attrTagValue }` object rather than the attribute tag's
        // value, and renders `<div>a</div>`/`<div>[object Object]</div>`
        // silently dropping the content Marko's own comment calls "fallback
        // content" — so literal parity here would regress MX's already-working
        // no-args `<define>` attribute-tag binding (the test right above this
        // one) for no benefit. MX instead extends that same positional
        // named-lookup scheme args already partially consume: params beyond
        // the args are filled from `named`, one value per param, exactly as
        // the no-args path below already does.
        const args =
          node.args.length > 0
            ? [
                ...node.args.map((a: Expr) => a.code),
                ...target.params
                  .slice(node.args.length)
                  .map((param) => named.get(param) ?? "undefined"),
              ]
            : target.params.map((param) => named.get(param) ?? "undefined");
        push(
          concatMapped(
            "out += ",
            mapped(target.name, node.nameSpan),
            `(${args.join(", ")});`,
          ),
        );
        return;
      }

      // No props at all: the call's empty object literal is where
      // TypeScript anchors a missing-required-property error (`{}` is
      // the diagnostic's own span). With no attribute to map, fall back
      // to the tag name so that diagnostic still lands inside the `.mx`
      // file instead of being dropped as unmapped generated text.
      const props =
        parts.length === 0
          ? mapped("{  }", node.nameSpan)
          : concatMapped("{ ", joinedParts, " }");

      // A unit that declares `<return>` hands back `{ value, output }`, so
      // the call site unwraps it whether or not it binds the value.
      if (node.returnsValue) {
        if (node.var) {
          // The statement sequence of invariant §7.5-4: the attribute-tag
          // statements (already pushed by `propsOf`), then the call bound to
          // a temp, then the `/var`, then the output where the call stood.
          // The temp exists because the call must be evaluated exactly once
          // while both of its halves are read.
          const temp = `$mx_ret${state.returnTemp++}`;
          push(
            concatMapped(
              `const ${temp} = `,
              mapped(callee, node.nameSpan),
              "(",
              props,
              ");",
            ),
          );
          push(`const ${node.var} = ${temp}.value;`);
          push(`out += ${temp}.output;`);
          return;
        }
        push(
          concatMapped(
            "out += ",
            mapped(callee, node.nameSpan),
            "(",
            props,
            ").output;",
          ),
        );
        return;
      }

      push(
        concatMapped(
          "out += ",
          mapped(callee, node.nameSpan),
          "(",
          props,
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
        const temp = `$for${state.body.length}`;
        push(`const ${temp} = ${source};`);
        return temp;
      };

      const [first = "item", second] = node.params;
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
      push(concatMapped(`const ${node.name} = `, fn, ";"));
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
        state.moduleHoisted.push(data.code);
        return;
      }
      case "html-comment": {
        literal("<!--");
        for (const child of tag.children) {
          if (child.kind === "Text") {
            // A static run is escaped at compile time by the same rule, and
            // merged into the surrounding literal so a fully static comment
            // stays one `out +=`.
            literal(escapeComment(child.value));
          } else if (child.kind === "Interpolation") {
            push(`out += escapeComment(${child.expr.code});`);
          } else if (child.kind !== "Comment") {
            fail(
              "`<html-comment>` takes only text and placeholders; a comment cannot contain markup",
              child,
            );
          }
        }
        literal("-->");
        return;
      }
      case "raw-element": {
        // `<html-script>`/`<html-style>` are Marko's spelling of a literal
        // `<script>`/`<style>` element, since the bare names are core tags.
        push(`out += ${quote(`<${data.tag}>`)};`);
        for (const child of tag.children) {
          if (child.kind === "Text") push(`out += ${quote(child.value)};`);
          else if (child.kind === "Interpolation") {
            expression(child.expr.code, child.escaped);
          }
        }
        push(`out += ${quote(`</${data.tag}>`)};`);
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
        push(`out += ${quote(`<style>${text}</style>`)};`);
        return;
      }
      case "try": {
        // A `<try>` without a `<@placeholder>` is a plain try/catch: the body
        // renders, and `<@catch>` renders instead if it throws.
        const katch = tag.attributeTags.find((t) => t.name === "catch");
        push("try {");
        state.indent++;
        drive(emitter, tag.children);
        state.indent--;
        if (katch) {
          push(`} catch (${katch.block.params.join(", ") || "_error"}) {`);
          state.indent++;
          drive(emitter, katch.block.children);
          state.indent--;
          push("}");
        } else {
          push("} catch {}");
        }
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
                hasParams: false,
                params: [],
                children: tag.children,
                loc: tag.loc,
              }
            : null;
        emitter.component({
          kind: "Component",
          target: { kind: "dynamic", expr: data.expr } as ComponentTarget,
          nameSpan: null,
          // Spreads included: `renderDynamic` receives them in source order
          // like any other component call.
          attrs: tag.attrs,
          content,
          // `tag.attributeTags` is what the core already resolved for this
          // `DelegatedTag` — forwarding it is what keeps `<${expr}><@header>…</@header></>`
          // from silently dropping the attribute tag (measured against Marko
          // 6.3.51: attribute tags on a dynamic tag ARE forwarded).
          attributeTags: tag.attributeTags,
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
 * Builds the emitted TypeScript module for one resolved template.
 *
 * The module shape is fixed (S3): the escape import, the author's hoisted
 * module scope, their `Input` interface, and one default-exported render
 * function concatenating into a single local.
 */
export function emitModuleWithMappings(ir: Ir, escapeFrom: string): MappedCode {
  const emitter = createEmitter();
  drive(emitter, ir.body);
  const body = emitter.done();

  const lines: Array<string | MappedCode> = [
    `import { escape } from "${escapeFrom}";`,
  ];
  if (ir.needsAttrTagImport) {
    lines.push(`import type { AttrTag } from "${escapeFrom}";`);
  }
  const hoisted = [
    ...ir.imports.map((node) => node.code),
    ...ir.hoisted.map((node) => node.code),
    ...emitter.state.moduleHoisted,
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
    // A unit that declares `<return>` hands back `{ value, output }` rather
    // than the output alone (design §3.3). Two shapes, chosen by the tag and
    // never by a call site — and because the tag compiles without seeing its
    // callers, the choice is made once here rather than resolved across them.
    //
    // The returning shape is left un-annotated so the value's type is
    // *inferred* from the `<return>` expression: that inference is what gives
    // a `/var` binding at the call site its type (C6), and an annotation here
    // could only widen it.
    `export default function ${moduleExportName(ir, "@mxlang/html")}(input: ${inputType})${
      ir.returnValue ? "" : ": string"
    } {`,
    `${INDENT}let out = "";`,
    // Hoisted statements precede the body but follow `out`, so a hoisted
    // declaration may not reference the buffer — which is the point: it is a
    // declaration, not output.
    ...[...ir.prelude.map((node) => node.code), ...emitter.state.prelude].map(
      (code) => INDENT + code,
    ),
    ...body.map((code, index) => ({
      code,
      mappings: emitter.state.bodyMappings[index] ?? [],
    })),
    ir.returnValue
      ? `${INDENT}return { value: ${ir.returnValue.code}, output: out };`
      : `${INDENT}return out;`,
    "}",
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
