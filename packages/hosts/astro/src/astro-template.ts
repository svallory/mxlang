/**
 * The MX → Astro-template emitter (decisions 76c, 78 and 79).
 *
 * An `.amx` file keeps Astro's TypeScript frontmatter byte-for-byte and uses
 * MX for the template that follows it. The core parses that template,
 * resolves Marko nodes into its host-independent IR, and drives the emitter in
 * this file. No emission path here inspects a Marko node.
 */

import {
  type Attr,
  type CustomTag,
  DYNAMIC_TAG,
  drive,
  type Emitter,
  type Expr,
  emit,
  type HostDeclarations,
  type Ir,
  type IrNode,
  lower,
  type Node,
  newCtx,
  parseFragment,
  TranslateError,
} from "@mxlang/core";

/** A lowering failure positioned in the enclosing `.amx` file. */
export class AstroTemplateError extends Error {
  line: number;
  column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "AstroTemplateError";
    this.line = line;
    this.column = column;
  }
}

type Positioned = { loc: { line: number; column: number } };

function fail(message: string, node: Positioned | Node): never {
  const start = node?.loc?.start ?? node?.loc ?? { line: 0, column: 0 };
  throw new AstroTemplateError(message, start.line ?? 0, start.column ?? 0);
}

const TAGS: HostDeclarations["tags"] = {
  let: {
    kind: "error",
    reason:
      "`<let>` is reactive state and requires a runtime; `.amx` renders static markup at build time",
  },
  effect: {
    kind: "error",
    reason:
      "`<effect>` is a reactive effect and requires a runtime; `.amx` renders static markup at build time",
  },
  lifecycle: {
    kind: "error",
    reason:
      "`<lifecycle>` is a reactive lifecycle hook and requires a runtime; `.amx` renders static markup at build time",
  },
  script: {
    kind: "error",
    reason:
      "`<script>` as a Marko tag runs client code and requires a runtime; `.amx` renders static markup at build time",
  },
  client: {
    kind: "error",
    reason:
      "a `client` block is client-only and requires a runtime; `.amx` renders static markup at build time",
  },
  id: {
    kind: "error",
    reason:
      "`<id>` allocates an identifier for the reactive runtime; `.amx` renders static markup at build time",
  },
  await: {
    kind: "error",
    reason:
      "`<await>` needs a suspense-capable renderer; `.amx` renders static markup at build time",
  },
  // `<return>` is **not** listed. A `.amx` file cannot declare one — it is an
  // Astro component, whose output is its markup — but this table is consulted
  // while compiling whichever file contains the tag, so an entry here also
  // refused a `.amx` file that merely *called* a returning `.mx` tag. That
  // call is legal: the unit is a separate module, and `component()` below
  // unwraps its `{ value, output }` pair.
  const: {
    kind: "error",
    reason:
      "`<const>` declares a binding, which an Astro template expression cannot do; declare it in the `---` fence instead",
  },
  define: {
    kind: "error",
    reason:
      "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.amx` file and import it",
  },
  try: {
    kind: "error",
    reason:
      "`<try>` needs an error boundary; Astro renders components statically at build time and has no equivalent",
  },
  else: { kind: "error", reason: "`<else>` must follow an `<if>`" },
  "else-if": { kind: "error", reason: "`<else-if>` must follow an `<if>`" },
};

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

type HostTagData = { kind: "interpolation"; expr: Expr };

/** Questions the Astro host answers while Marko nodes are still available. */
const declarations: HostDeclarations = {
  tags: TAGS,
  isElement: (name) => !isComponentName(name),
  isComponent: (name) => isComponentName(name),
  keepComments: true,
  orderAttrs: (name, attrs) => {
    if (name !== "input") return attrs;
    const index = attrs.findIndex(
      (attr) => attr.kind !== "spread" && attr.name === "value",
    );
    if (index <= 0) return attrs;
    const value = attrs[index] as Attr;
    return [value, ...attrs.slice(0, index), ...attrs.slice(index + 1)];
  },
  claimsTag: (name) => name === DYNAMIC_TAG,
  resolveHostTag: (name, node): HostTagData => {
    if (name !== DYNAMIC_TAG) {
      fail(`unknown Astro host tag ${JSON.stringify(name)}`, node);
    }

    // A bare top-level `${expr}` line and a tagged `<${expr} .../>` both
    // parse to Marko's expression-named tag shape, and both are the
    // dynamic-tag construct (see the "four Marko facts" in AGENTS.md, and
    // `@mxlang/core`'s `lowerTag`) — Astro resolves component names
    // statically and cannot express either, so both are the same
    // host-specific error rather than the bare shape silently becoming an
    // interpolation.
    fail(
      "a dynamic tag name (`<${expr}>`) is not supported in an `.amx` template; Astro resolves component names statically",
      node,
    );
  },
  rejectModifier: (attr) => {
    fail(
      `attribute modifier \`${attr.name}:${attr.modifier}\` is not supported in an \`.amx\` template`,
      attr,
    );
  },
  rejectAttributeMethod: (attr) => {
    fail(
      `attribute method \`${attr.name}(...)\` is an event handler and requires a runtime; \`.amx\` renders static markup at build time`,
      attr,
    );
  },
  rejectElementAttributeTags: (name, node) => {
    const first = node.attributeTags?.[0];
    const slot = String(first?.name?.value ?? "").replace(/^@/, "");
    fail(
      `attribute tags (\`<@${slot}>\`) lower to Astro named slots, which only a component accepts; \`<${name}>\` is an HTML element`,
      first ?? node,
    );
  },
  rejectComponentTag: (name, node) => {
    if ((node.body?.params ?? []).length === 0) return;
    fail(
      `tag params (\`<${name}|…|>\`) lower to a render prop, which Astro has no equivalent for — Astro passes markup through slots, not functions`,
      node,
    );
  },
};

function escapeText(text: string): string {
  return text.replace(/[{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

type MappedWrite = (code: string, node: Node, generatedStart: number) => void;

function emitAttrs(
  attrs: Attr[],
  write: (code: string) => void,
  writeMapped: (code: string, node: Node) => void,
): void {
  const writeName = (attr: Exclude<Attr, { kind: "spread" }>): void => {
    writeMapped(attr.name, {
      loc: {
        start: attr.loc,
        end: {
          line: attr.loc.line,
          column: attr.loc.column + attr.name.length,
        },
      },
    });
  };
  for (const attr of attrs) {
    switch (attr.kind) {
      case "spread":
        write(" {...");
        writeMapped(attr.value.code, attr.value.node);
        write("}");
        break;
      case "boolean":
        write(" ");
        writeName(attr);
        break;
      case "static":
        write(" ");
        writeName(attr);
        write(`="${escapeAttr(attr.value)}"`);
        break;
      case "bound":
        fail(
          "`:=` is a two-way binding and requires a reactive runtime; `.amx` renders static markup at build time",
          attr,
        );
        break;
      case "dynamic": {
        const structuredClass =
          attr.name === "class" &&
          (attr.value.shape === "object" || attr.value.shape === "array");
        write(" ");
        writeMapped(structuredClass ? "class:list" : attr.name, {
          loc: {
            start: attr.loc,
            end: {
              line: attr.loc.line,
              column: attr.loc.column + attr.name.length,
            },
          },
        });
        write("={");
        writeMapped(attr.value.code, attr.value.node);
        write("}");
        break;
      }
    }
  }
}

/** Creates one Astro-template emitter over core's IR. */
export function createEmitter(onMappedWrite?: MappedWrite): Emitter<string> {
  const out: string[] = [];
  let length = 0;
  const write = (code: string): void => {
    out.push(code);
    length += code.length;
  };
  const writeMapped = (code: string, node: Node): void => {
    onMappedWrite?.(code, node, length);
    write(code);
  };
  const writeExpr = (expr: Expr): void => writeMapped(expr.code, expr.node);
  const writeFragment = (nodes: IrNode[]): void => {
    write("<Fragment>");
    drive(emitter, nodes);
    write("</Fragment>");
  };

  const emitter: Emitter<string> = {
    text(node) {
      write(escapeText(node.value));
    },

    interpolation(node) {
      write(node.escaped ? "{" : "<Fragment set:html={");
      writeExpr(node.expr);
      write(node.escaped ? "}" : "} />");
    },

    element(node) {
      write(`<${node.name}`);
      emitAttrs(node.attrs, write, writeMapped);
      if (node.void) {
        write(" />");
        return;
      }
      write(">");
      drive(emitter, node.children);
      write(`</${node.name}>`);
    },

    component(node) {
      if (node.target.kind !== "name") {
        fail(
          node.target.kind === "define"
            ? "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.amx` file and import it"
            : "a dynamic tag name (`<${expr}>`) is not supported in an `.amx` template; Astro resolves component names statically",
          node,
        );
      }

      const name = node.target.name;
      if (node.var) {
        // The unwrap below is an expression, and an `.amx` template has no
        // statement position to bind a value in — the `---` fence is the
        // author's, written before any of this. Refused rather than dropped.
        fail(
          `\`/var\` on \`<${node.authoredName ?? name}>\` is not supported in \`.amx\` yet; call the tag without \`/var\`, or bind the value in the \`---\` fence`,
          node,
        );
      }
      if (node.content?.params.length) {
        fail(
          `tag params (\`<${name}|…|>\`) lower to a render prop, which Astro has no equivalent for — Astro passes markup through slots, not functions`,
          node,
        );
      }
      const hasChildren =
        Boolean(node.content) || node.attributeTags.length > 0;
      write(`<${name}`);
      emitAttrs(node.attrs, write, writeMapped);
      if (!hasChildren) {
        write(" />");
        return;
      }

      write(">");
      if (node.content) drive(emitter, node.content.children);
      for (const tag of node.attributeTags) {
        if (tag.block.params.length > 0) {
          fail(
            `\`<@${tag.name}>\` declares tag params, which lower to a render prop; Astro slots carry markup, not functions`,
            tag,
          );
        }
        write(`<Fragment slot="${escapeAttr(tag.name)}">`);
        drive(emitter, tag.block.children);
        write("</Fragment>");
      }
      write(`</${name}>`);
    },

    ifChain(node) {
      write("{");
      node.branches.forEach((branch, index) => {
        if (index > 0) write(" : ");
        if (branch.condition) {
          writeExpr(branch.condition);
          write(" ? (");
          writeFragment(branch.children);
          write(")");
        } else {
          write("(");
          writeFragment(branch.children);
          write(")");
        }
      });
      if (node.branches.at(-1)?.condition) write(" : null");
      write("}");
    },

    forLoop(node) {
      if (node.source.kind === "range" && node.source.step) {
        fail(
          "`<for step=...>`: step is not supported; use a computed array",
          node,
        );
      }
      const [, second] = node.params;
      const writeParam = (index: number, fallback?: string): void => {
        const code = node.params[index] ?? fallback;
        if (code === undefined) return;
        const param = node.paramNodes[index];
        if (param) writeMapped(code, param);
        else write(code);
      };
      const writeBranch = (): void => {
        write("(");
        writeFragment(node.children);
        write(")");
      };
      if (node.source.kind === "of") {
        write("{[...");
        writeExpr(node.source.list);
        write("].map((");
        writeParam(0);
        if (second) {
          write(", ");
          writeParam(1);
        }
        write(") => ");
        writeBranch();
        write(")}");
        return;
      }
      if (node.source.kind === "in") {
        write("{Object.entries(");
        writeExpr(node.source.object);
        write(").map(([");
        writeParam(0);
        write(", ");
        writeParam(1, "value");
        write("]) => ");
        writeBranch();
        write(")}");
        return;
      }

      const writeStart = (): void => {
        if (node.source.kind === "range" && node.source.from) {
          writeExpr(node.source.from);
        } else {
          write("0");
        }
      };
      write("{Array.from({ length: Math.max(0, (");
      writeExpr(node.source.bound);
      write(") - (");
      writeStart();
      write(node.source.inclusive ? ") + 1" : ")");
      write(" }, (_, $i) => (");
      writeStart();
      write(") + $i).map((");
      writeParam(0);
      write(") => ");
      writeBranch();
      write(")}");
    },

    define(node) {
      fail(
        "`<define>` declares a reusable template block; an Astro template has no local component form — extract it into its own `.amx` file and import it",
        node,
      );
    },

    constant(node) {
      fail(
        "`<const>` declares a binding, which an Astro template expression cannot do; declare it in the `---` fence instead",
        node,
      );
    },

    hoisted(node) {
      fail(
        "a statement hoisted inside an Astro template block cannot be represented in frontmatter without changing its scope",
        node,
      );
    },

    hostTag(node) {
      const data = node.tag.data as HostTagData;
      if (data.kind !== "interpolation") {
        fail("unknown Astro host-tag lowering", node);
      }
      write("{");
      writeExpr(data.expr);
      write("}");
    },

    documentType(node) {
      write(`<!${node.value}>`);
    },

    comment(node) {
      write(`<!--${node.value}-->`);
    },

    done() {
      return out.join("");
    },
  };

  return emitter;
}

/** Emits the template half of a resolved `.amx` file. */
export function emitTemplate(ir: Ir): string {
  return emit(createEmitter(), ir);
}

export interface LowerResult {
  code: string;
  mappings: AstroTemplateMapping[];
}

export interface AstroTemplateMapping {
  sourceStart: number;
  sourceEnd: number;
  generatedStart: number;
  generatedEnd: number;
}

type HoistedStatement = Extract<
  IrNode,
  { kind: "Import" | "Static" | "Export" | "InputInterface" | "Hoisted" }
>;

function offsetAtPosition(
  source: string,
  position: { line: number; column: number },
): number {
  let offset = 0;
  for (let line = 1; line < position.line; line++) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return source.length;
    offset = newline + 1;
  }
  return Math.min(source.length, offset + position.column);
}

function rangeOfNode(source: string, node: Node): [number, number] | null {
  const start = node?.loc?.start;
  const end = node?.loc?.end;
  if (!start || !end) return null;
  return [
    typeof start.index === "number"
      ? start.index
      : offsetAtPosition(source, start),
    typeof end.index === "number" ? end.index : offsetAtPosition(source, end),
  ];
}

function emitFence(
  source: string,
  fence: string,
  statements: HoistedStatement[],
): { code: string; mappings: AstroTemplateMapping[] } {
  if (statements.length === 0) {
    return {
      code: fence,
      mappings: fence
        ? [
            {
              sourceStart: 0,
              sourceEnd: fence.length,
              generatedStart: 0,
              generatedEnd: fence.length,
            },
          ]
        : [],
    };
  }
  const newline = fence.includes("\r\n") ? "\r\n" : "\n";
  const mappings: AstroTemplateMapping[] = [];
  let code: string;
  if (fence === "") {
    code = `---${newline}`;
  } else {
    const close = fence.lastIndexOf(`${newline}---`);
    if (close < 0) return { code: fence, mappings: [] };
    code = `${fence.slice(0, close)}${newline}`;
    mappings.push({
      sourceStart: 0,
      sourceEnd: close,
      generatedStart: 0,
      generatedEnd: close,
    });
  }

  for (const [index, statement] of statements.entries()) {
    if (index > 0) code += newline;
    const generatedStart = code.length;
    code += statement.code;
    mappings.push({
      sourceStart: offsetAtPosition(source, statement.loc),
      sourceEnd: offsetAtPosition(source, statement.end),
      generatedStart,
      generatedEnd: code.length,
    });
  }

  code +=
    fence === ""
      ? `${newline}---${newline}`
      : fence.slice(fence.lastIndexOf(`${newline}---`));
  return { code, mappings };
}

/** Splits an `.amx` file, resolves its MX template, and emits Astro syntax. */
export function lowerAstroMx(
  source: string,
  filename: string,
  options: {
    /** Custom tags already discovered and loaded by the calling integration. */
    customTags?: Record<string, CustomTag>;
  } = {},
): LowerResult {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/);
  const originalFence = match ? match[0] : "";
  const template = match ? source.slice(originalFence.length) : source;
  const baseOffset = originalFence.length;
  const baseLine = originalFence ? originalFence.split("\n").length - 1 : 0;

  const { body } = parseFragment(template, {
    filename,
    baseOffset,
    baseLine,
    baseColumn: 0,
    customTags: options.customTags,
  });

  try {
    const ctx = newCtx(
      source,
      (node) => sourceOf(source, node),
      declarations,
      undefined,
      filename,
    );
    ctx.customTags = options.customTags;
    // An `.amx` file is an Astro component module, so it has a declaration to
    // name and a tag may call itself without importing itself.
    ctx.emitsModule = true;
    const ir = lower(ctx, body);
    // The `.amx` emitter has nowhere to put a returned value — an Astro
    // component's output is its markup, and the `---` fence is the author's,
    // written before any of this runs. The core parses `<return>` for every
    // host, so leaving this unchecked dropped the tag silently: it emitted
    // clean markup with the value gone, which is the failure class (S8) the
    // field guard exists to close. `/var` on a *call* is refused for the
    // same reason, in `component()`.
    if (ir.returnValue) {
      const at = ir.returnValue.node?.loc?.start;
      throw new AstroTemplateError(
        "`<return>` hands a value to whoever called this unit; an `.amx` file is an Astro component, whose output is its markup, so there is nothing to return it to — move the markup into a `.mx` tag file if the value is what you need",
        at?.line ?? 0,
        at?.column ?? 0,
      );
    }
    const statements: HoistedStatement[] = [
      ...ir.imports,
      ...ir.hoisted,
      ...(ir.inputInterface ? [ir.inputInterface] : []),
      ...ir.prelude,
    ];
    const emittedFence = emitFence(source, originalFence, statements);
    const mappings = [...emittedFence.mappings];
    const templateEmitter = createEmitter((code, node, generatedStart) => {
      const range = rangeOfNode(source, node);
      if (!range) return;
      mappings.push({
        sourceStart: range[0],
        sourceEnd: range[1],
        generatedStart: emittedFence.code.length + generatedStart,
        generatedEnd: emittedFence.code.length + generatedStart + code.length,
      });
    });
    const templateCode = emit(templateEmitter, ir);
    return {
      code: `${emittedFence.code}${templateCode}`,
      mappings,
    };
  } catch (error) {
    if (error instanceof AstroTemplateError) throw error;
    if (error instanceof TranslateError) {
      throw new AstroTemplateError(error.message, error.line, error.column);
    }
    throw error;
  }
}

/** Prints an expression by slicing its file-relative source range. */
function sourceOf(source: string, node: Node): string {
  const start = node?.loc?.start?.index;
  const end = node?.loc?.end?.index;
  if (typeof start === "number" && typeof end === "number") {
    return source.slice(start, end);
  }
  fail("expression has no source position", node);
}
