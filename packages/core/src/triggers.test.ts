/**
 * Layer-2 syntax modules (decision 182 addendum 5): the module form of
 * `mx.syntax` and of the `syntax` option, `lowerTrigger` dispatch in the
 * three positions with the built-in node kinds, the guards on a hook's
 * result, `lowerBlockTag`/`lowerFilter`, and the module's `afterLower` and
 * `productName`. The `&` member shapes through `parseData` are pinned in
 * `@mxlang/data`'s `member-syntax.test.ts`.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { type Ctx, newCtx, TranslateError } from "./core.ts";
import memberSyntax, { MEMBER } from "./fixtures/syntax/member-syntax.ts";
import { parseFragment } from "./fragment.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { lowerChildren } from "./lower.ts";
import {
  resolveSyntaxOf,
  type SyntaxModule,
  type Trigger,
} from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/syntax/member-syntax.ts");

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-syntax-module-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manifest(at: string, mx: unknown): string {
  mkdirSync(at, { recursive: true });
  const file = join(at, "package.json");
  writeFileSync(file, `{\n  "name": "x",\n  "mx": ${JSON.stringify(mx)}\n}\n`);
  return file;
}

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    if (!(error instanceof TranslateError)) throw error;
    return error;
  }
  throw new Error("expected an error");
}

/** The IR `compileSource` lowers `source` to, with `syntax` or the file's manifest. */
function irOf(
  source: string,
  file = join(dir, "page.mx"),
  syntax?: SyntaxModule,
): Ir {
  let ir: Ir | undefined;
  compileSource(source, file, declarations, {
    targets,
    ...(syntax ? { syntax } : {}),
    emitIr: (lowered) => {
      ir = lowered;
      return "";
    },
  });
  return ir as Ir;
}

type Element = Extract<IrNode, { kind: "Element" }>;

function elements(nodes: readonly IrNode[]): Element[] {
  return nodes.filter((node): node is Element => node.kind === "Element");
}

function attr(node: Element, name: string): Attr {
  const found = node.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

/** A module overlaying `rows` with `lowerTrigger` (and any other hook). */
function moduleWith(
  rows: Partial<SyntaxModule["table"]>,
  hooks: Omit<SyntaxModule, "table"> = {},
): SyntaxModule {
  return { table: rows, ...hooks };
}

describe("the member module through the `syntax` option", () => {
  it("an expression trigger is the module's node; the authored text and atoms stay", () => {
    const source = "rule check=(() => &status === :sent)\n";
    const [rule] = elements(irOf(source, undefined, memberSyntax).body);
    const check = attr(rule as Element, "check");
    expect(check.kind).toBe("dynamic");
    if (check.kind !== "dynamic") return;
    // Spliced like the atom beside it (review 451 r1): emitting targets read `code`.
    expect(check.value.code).toBe('() => self.status === "sent"');
    const body = (
      check.value.node as { body: { left: unknown; right: unknown } }
    ).body;
    expect(body.left).toMatchObject({
      type: "MemberExpression",
      object: { type: "Identifier", name: "self" },
      property: { type: "Identifier", name: "status" },
      start: 18,
      end: 25,
      extra: {
        mxMember: { name: "status", span: { sourceStart: 18, sourceEnd: 25 } },
      },
    });
    expect(body.right).toMatchObject({
      type: "StringLiteral",
      value: "sent",
      extra: { mxAtom: { span: { sourceStart: 30, sourceEnd: 35 } } },
    });
  });

  it("`[&a, &b]` is an array of marked members", () => {
    const [rule] = elements(
      irOf("rule load=[&a, &b]\n", undefined, memberSyntax).body,
    );
    const load = attr(rule as Element, "load");
    if (load.kind !== "dynamic") throw new Error(load.kind);
    expect(load.value.node).toMatchObject({
      type: "ArrayExpression",
      elements: [
        { type: "MemberExpression", extra: { mxMember: { name: "a" } } },
        { type: "MemberExpression", extra: { mxMember: { name: "b" } } },
      ],
    });
  });

  it("an attribute trigger is a static attribute carrying the member", () => {
    const [sort] = elements(
      irOf("sort asc &dueOn\n", undefined, memberSyntax).body,
    );
    expect(attr(sort as Element, "member")).toMatchObject({
      kind: "static",
      value: "dueOn",
      member: {
        kind: "member",
        name: "dueOn",
        span: { sourceStart: 9, sourceEnd: 15 },
      },
    });
  });

  it("a line trigger is a child tag through the normal tag path", () => {
    const source = "fields\n  &title\n  &amount=qty * &price\n";
    const [input] = elements(irOf(source, undefined, memberSyntax).body);
    const children = elements((input as Element).children);
    expect(children.map((child) => child.name)).toEqual(["member", "member"]);
    expect(attr(children[0] as Element, "name")).toMatchObject({
      kind: "static",
      value: "title",
      valueSpan: { sourceStart: 10, sourceEnd: 15 },
    });
    const value = attr(children[1] as Element, "value");
    if (value.kind !== "dynamic") throw new Error(value.kind);
    expect(value.value.code).toBe("qty * self.price");
    expect(value.value.node).toMatchObject({
      type: "BinaryExpression",
      right: {
        type: "MemberExpression",
        extra: { mxMember: { name: "price" } },
      },
    });
    // Named at the `=`, zero width: the default-attribute convention.
    expect(value.nameSpan).toEqual({ sourceStart: 25, sourceEnd: 25 });
  });

  it("calls the hook once per trigger, in source order", () => {
    const seen: string[] = [];
    const counting: SyntaxModule = {
      ...memberSyntax,
      lowerTrigger: (id, text, span, ctx) => {
        seen.push(`${ctx.position}:${text}`);
        return (
          memberSyntax.lowerTrigger as NonNullable<SyntaxModule["lowerTrigger"]>
        )(id, text, span, ctx);
      },
    };
    irOf("sort asc &a\n  &b=&c\nrule x=&d\n", undefined, counting);
    expect(seen).toEqual([
      "attribute:&a",
      "expression:&c",
      "line:&b",
      "expression:&d",
    ]);
  });
});

describe("`package.json#mx.syntax` naming a syntax module", () => {
  it("an absolute specifier loads the module and its hooks", () => {
    manifest(dir, { syntax: FIXTURE });
    const [sort] = elements(irOf("sort asc &dueOn\n").body);
    expect(attr(sort as Element, "member")).toMatchObject({
      member: { name: "dueOn" },
    });
  });

  it("a relative specifier resolves from the manifest", () => {
    writeFileSync(
      join(dir, "syntax.ts"),
      `export { default } from ${JSON.stringify(FIXTURE)};\n`,
    );
    manifest(dir, { syntax: "./syntax.ts" });
    const [input] = elements(irOf("fields\n  &title\n").body);
    expect(elements((input as Element).children)[0]?.name).toBe("member");
  });

  it("an edited module is resolved again (Vitest keeps its own module registry, so not re-evaluated here)", () => {
    const file = join(dir, "syntax.ts");
    writeFileSync(
      file,
      `export default { table: { attributeTriggers: [${JSON.stringify(MEMBER)}] }, lowerTrigger: (id, text, span, ctx) => ctx.attribute("m", { kind: "member", name: text.slice(1) }) };\n`,
    );
    manifest(dir, { syntax: "./syntax.ts" });
    const page = join(dir, "page.mx");
    const first = resolveSyntaxOf(page);
    expect(first.module?.lowerTrigger).toBeTypeOf("function");
    expect(resolveSyntaxOf(page)).toBe(first);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const second = resolveSyntaxOf(page);
    expect(second).not.toBe(first);
    expect(resolveSyntaxOf(page)).toBe(second);
  });

  it.each([
    [
      "an unresolvable specifier",
      "./missing.ts",
      "`mx.syntax` could not resolve `./missing.ts` from",
    ],
  ])("%s is an error at the mx.syntax key", (_, syntax, message) => {
    const file = manifest(dir, { syntax });
    const error = caught(() => irOf("div\n"));
    expect(error.file).toBe(file);
    expect([error.line, error.column]).toEqual([3, 9]);
    expect(error.message).toContain(message);
  });

  it("a `{ call }` trigger with no `lowerTrigger` is an error at the mx.syntax key", () => {
    writeFileSync(
      join(dir, "syntax.ts"),
      `export default { table: { lineTriggers: [${JSON.stringify(MEMBER)}] } };\n`,
    );
    const file = manifest(dir, { syntax: "./syntax.ts" });
    const error = caught(() => irOf("div\n"));
    expect(error.file).toBe(file);
    expect([error.line, error.column]).toEqual([3, 9]);
    expect(error.message).toBe(
      '`mx.syntax` (./syntax.ts): `table.lineTriggers[0]` (trigger "member") has a `{ call }` node, and the module exports no `lowerTrigger`',
    );
  });

  it("an inline `mx.syntax` with a `{ call }` trigger is an error at the key", () => {
    const file = manifest(dir, { syntax: { lineTriggers: [MEMBER] } });
    const error = caught(() => irOf("div\n"));
    expect(error.file).toBe(file);
    expect(error.message).toBe(
      '`mx.syntax.lineTriggers[0]` (trigger "member"): a `{ call }` node is lowered by a syntax module\'s `lowerTrigger`, and an inline `mx.syntax` is a table only; move the table into a module and name it (`"syntax": "./syntax.ts"`)',
    );
  });

  it.each([
    [
      "export default 1;",
      "syntax module must `export default` a syntax module object",
    ],
    ["export default { };", "`table` is required"],
    [
      "export default { table: {}, lower: () => 1 };",
      "`lower` is not a syntax module field",
    ],
    [
      "export default { table: {}, lowerTrigger: 1 };",
      "`lowerTrigger` must be a function",
    ],
    [
      "export default { table: {}, productName: '' };",
      "`productName` must be a non-empty string",
    ],
    [
      "export default { table: { tagTypes: {} } };",
      "`table.tagTypes` is not a manifest field",
    ],
  ])("a module `%s` is an error in the module file", (body, message) => {
    const module = join(dir, "syntax.ts");
    writeFileSync(module, `${body}\n`);
    manifest(dir, { syntax: "./syntax.ts" });
    const error = caught(() => irOf("div\n"));
    expect(error.file).toBe(module);
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).toContain(message);
  });
});

describe("the built-in node kinds lower in core", () => {
  const row = (node: Trigger["node"]): Trigger => ({ ...MEMBER, node });

  it('`"string"` and `"identifier"` in an expression', () => {
    const strings = irOf(
      "rule x=&a\n",
      undefined,
      moduleWith({ expressionTriggers: [row("string")] }),
    );
    // A whole-value string literal is a static attribute.
    expect(attr(elements(strings.body)[0] as Element, "x")).toMatchObject({
      kind: "static",
      value: "&a",
      valueSpan: { sourceStart: 7, sourceEnd: 9 },
    });
    const ids = irOf(
      "rule x=&a\n",
      undefined,
      moduleWith({ expressionTriggers: [row("identifier")] }),
    );
    const y = attr(elements(ids.body)[0] as Element, "x");
    expect(y.kind === "dynamic" && y.value.node).toMatchObject({
      type: "Identifier",
      name: "&a",
    });
  });

  it('`"attribute"` in an attribute list: named after the sigil, bare or with its `=value`', () => {
    const syntax = moduleWith({ attributeTriggers: [row("attribute")] });
    const tag = elements(irOf("sort &a &b=1\n", undefined, syntax).body)[0];
    expect(attr(tag as Element, "a")).toMatchObject({ kind: "boolean" });
    expect(attr(tag as Element, "b")).toMatchObject({
      kind: "dynamic",
      value: { code: "1" },
    });
  });

  it.each([
    ["expressionTriggers", "attribute", "rule x=&a\n", "an expression", 1, 7],
    ["attributeTriggers", "string", "sort &a\n", "an attribute list", 1, 5],
    ["lineTriggers", "identifier", "div\n  &a\n", "a tagless line", 2, 2],
  ] as const)(
    "%s with `%s` is a positioned error",
    (list, node, source, where, line, column) => {
      const error = caught(() =>
        irOf(source, undefined, moduleWith({ [list]: [row(node)] })),
      );
      expect(error.message).toBe(
        `the \`member\` trigger's \`node: "${node}"\` has no meaning in ${where}; use \`{ call }\` and a syntax module's \`lowerTrigger\``,
      );
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );
});

describe("a hook's result is checked", () => {
  const rows = {
    expressionTriggers: [MEMBER],
    attributeTriggers: [MEMBER],
    lineTriggers: [MEMBER],
  };

  it("a `{ call }` trigger with no `lowerTrigger` in an option module has no lowering yet", () => {
    const error = caught(() =>
      irOf("rule x=&a\n", undefined, moduleWith(rows)),
    );
    expect(error.message).toBe("`member` trigger has no lowering yet");
    expect([error.line, error.column]).toEqual([1, 7]);
  });

  it.each([
    ["rule x=&a\n", "ctx.expression(node)", "an expression"],
    ["sort &a\n", "ctx.attribute(name, value)", "an attribute list"],
    ["div\n  &a\n", "ctx.child(tagName, attrs)", "a tagless line"],
  ])("%j: the result must fit the position", (source, want, where) => {
    const wrong = moduleWith(rows, {
      lowerTrigger: (_id, _text, _span, ctx) =>
        ctx.position === "line"
          ? ctx.expression({ type: "NullLiteral" })
          : ctx.child("x", []),
    });
    expect(caught(() => irOf(source, undefined, wrong)).message).toBe(
      `the \`member\` trigger's \`lowerTrigger\` must return \`${want}\` for a trigger in ${where}`,
    );
  });

  it("`ctx.expression` refuses a node that is not an expression", () => {
    const statement = moduleWith(rows, {
      lowerTrigger: (_id, _text, _span, ctx) =>
        ctx.expression({
          type: "ExpressionStatement",
          expression: { type: "NullLiteral" },
        }),
    });
    expect(
      caught(() => irOf("rule x=&a\n", undefined, statement)).message,
    ).toBe(
      "the `member` trigger's `lowerTrigger`: `ctx.expression` takes a Babel expression node, got a `ExpressionStatement`",
    );
  });

  it("a module-built expression value prints into `code`", () => {
    const built = moduleWith(rows, {
      lowerTrigger: (_id, text, _span, ctx) =>
        ctx.attribute(
          "of",
          ctx.expression({
            type: "MemberExpression",
            object: { type: "Identifier", name: "self" },
            property: { type: "Identifier", name: text.slice(1) },
            computed: false,
          }),
        ),
    });
    const [sort] = elements(irOf("sort &dueOn\n", undefined, built).body);
    expect(attr(sort as Element, "of")).toMatchObject({
      kind: "dynamic",
      value: { code: "self.dueOn", span: { sourceStart: 5, sourceEnd: 11 } },
    });
  });

  it("a hand-made result is refused", () => {
    const forged = moduleWith(rows, {
      lowerTrigger: () =>
        ({ kind: "expression", node: { type: "NullLiteral" } }) as never,
    });
    expect(caught(() => irOf("rule x=&a\n", undefined, forged)).message).toBe(
      "the `member` trigger's `lowerTrigger` must return what `ctx.expression`, `ctx.attribute` or `ctx.child` built",
    );
  });

  it("a hook that throws is positioned at the trigger", () => {
    const throwing = moduleWith(rows, {
      lowerTrigger: () => {
        throw new Error("no such member");
      },
    });
    const error = caught(() => irOf("div\n  rule x=&a\n", undefined, throwing));
    expect(error.message).toBe(
      "the `member` trigger's `lowerTrigger` threw: no such member",
    );
    expect([error.line, error.column]).toEqual([2, 9]);
  });

  it("a `TranslateError` from the hook passes through", () => {
    const own = moduleWith(rows, {
      lowerTrigger: () => {
        throw new TranslateError("Mesh: unknown member", 9, 9);
      },
    });
    const error = caught(() => irOf("rule x=&a\n", undefined, own));
    expect([error.message, error.line, error.column]).toEqual([
      "Mesh: unknown member",
      9,
      9,
    ]);
  });

  it.each([
    ["sort asc &a=1\n", 1, 12],
    ["sort asc &a = 1\n", 1, 14],
  ])(
    "%j: a `=value` the hook drops is an error at the value",
    (source, line, column) => {
      const error = caught(() => irOf(source, undefined, memberSyntax));
      expect(error.message).toBe(
        "`&a` takes no `=value` here: the `member` trigger's `lowerTrigger` did not use it",
      );
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );

  it("a line trigger that drops its `=value` is an error too", () => {
    const dropping = moduleWith(rows, {
      lowerTrigger: (_id, text, _span, ctx) =>
        ctx.child("member", [ctx.attribute("name", text.slice(1))]),
    });
    expect(
      caught(() => irOf("fields\n  &a=1\n", undefined, dropping)).message,
    ).toContain("takes no `=value` here");
  });

  it.each([
    ["rule x=((&a) => 1)\n", 1, 9],
    ["rule x=(({ &a }) => 1)\n", 1, 11],
    ["rule x=(([&a = 1]) => 1)\n", 1, 10],
  ])("%j: a trigger in binding position is refused", (source, line, column) => {
    const error = caught(() => irOf(source, undefined, memberSyntax));
    expect(error.message).toBe(
      "`&a` (the `member` trigger) cannot be declared: it lowers to an expression, and a parameter or declaration needs a plain name",
    );
    expect([error.line, error.column]).toEqual([line, column]);
  });

  it("assignment to a member is an ordinary expression", () => {
    const tag = elements(
      irOf("rule x=(() => { &a = 1 })\n", undefined, memberSyntax).body,
    )[0];
    const x = attr(tag as Element, "x");
    expect(x.kind).toBe("dynamic");
  });
});

describe("block tags and filters", () => {
  const table = {
    blockTag: { open: "{%", close: "%}" },
    filter: { open: "::", close: "::" },
  };

  it("go to `lowerBlockTag` and `lowerFilter` with their raw text and `ctx.build`", () => {
    const calls: unknown[] = [];
    const syntax = moduleWith(table, {
      lowerBlockTag: (text, span, ctx) => {
        calls.push(["block", text, span]);
        return ctx.build.text(`[${text.trim()}]`);
      },
      lowerFilter: (name, body, span, ctx) => {
        calls.push(["filter", name, body, span]);
        return [ctx.build.text(name), ctx.build.text(body)];
      },
    });
    const [p] = elements(
      irOf("<p>{% x %}::md::y::</p>", undefined, syntax).body,
    );
    expect((p as Element).children).toMatchObject([
      { kind: "Text", value: "[x]" },
      { kind: "Text", value: "md" },
      { kind: "Text", value: "y" },
    ]);
    expect(calls).toEqual([
      ["block", " x ", { sourceStart: 3, sourceEnd: 10 }],
      ["filter", "md", "y", { sourceStart: 10, sourceEnd: 19 }],
    ]);
  });

  it("a module without them keeps the no-lowering error", () => {
    const syntax = moduleWith(table);
    expect(
      caught(() => irOf("<p>{% x %}</p>", undefined, syntax)).message,
    ).toBe("a block tag has no lowering yet");
    expect(
      caught(() => irOf("<p>::md::y::</p>", undefined, syntax)).message,
    ).toBe("the `md` filter has no lowering yet");
  });

  it("a hook that returns no IR is refused", () => {
    const syntax = moduleWith(table, {
      lowerBlockTag: () => ({}) as IrNode,
    });
    expect(
      caught(() => irOf("<p>{% x %}</p>", undefined, syntax)).message,
    ).toBe(
      "the syntax module's `lowerBlockTag` must return IR nodes (build them with `ctx.build`)",
    );
  });
});

describe("`afterLower` and `productName`", () => {
  it("the module's `afterLower` joins the list once and sees its `productName`", () => {
    const seen: (string | undefined)[] = [];
    const syntax: SyntaxModule = {
      ...memberSyntax,
      productName: "Mesh",
      afterLower: (ctx: Ctx) => {
        seen.push(ctx.productName);
      },
    };
    irOf("sort asc &a\n", undefined, syntax);
    expect(seen).toEqual(["Mesh"]);
  });

  it("the host's `productName` wins", () => {
    const seen: (string | undefined)[] = [];
    compileSource("div\n", join(dir, "page.mx"), declarations, {
      targets,
      productName: "Host",
      syntax: {
        ...memberSyntax,
        productName: "Mesh",
        afterLower: (ctx: Ctx) => {
          seen.push(ctx.productName);
        },
      },
      emitIr: () => "",
    });
    expect(seen).toEqual(["Host"]);
  });
});

describe("a fragment lowers with its syntax", () => {
  it("`parseFragment` + `lowerChildren` lower the triggers", () => {
    const source = "<sort asc &dueOn/>";
    const { body } = parseFragment(source, {
      filename: join(dir, "page.solid.mx"),
      syntax: memberSyntax,
    });
    const ctx = newCtx(
      source,
      () => "",
      declarations,
      undefined,
      join(dir, "page.solid.mx"),
      targets,
    );
    const [sort] = elements(lowerChildren(ctx, body));
    expect(attr(sort as Element, "member")).toMatchObject({
      member: { name: "dueOn" },
    });
  });
});
