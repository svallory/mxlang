/**
 * Dialects (decisions 182 addendum 5, 202, 212): a dialect package and the
 * `dialect` option, `lowerTrigger` dispatch in the three positions with the
 * built-in node kinds, the guards on a hook's result,
 * `lowerBlockTag`/`lowerFilter`, and the dialect's `afterLower` and
 * `name`. Discovery and routing are pinned in `dialect-discovery.test.ts`.
 * Node types (`node: { type, dialect }`) are pinned in
 * `dialect-registry.test.ts`. The `&` member shapes through `lowerSource`
 * are pinned in `ir-entry/member-syntax.test.ts`.
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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreBabel } from "./babel.ts";
import { compileSource } from "./compile.ts";
import { newCtx, TranslateError } from "./core.ts";
import { parseFragment } from "./fragment.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { lowerChildren } from "./lower.ts";
import type { LoweredUnit } from "./lowered-unit.ts";
import memberSyntax, { MEMBER } from "./syntax/member.ts";
import {
  type Dialect,
  resolveSyntaxOf,
  type Trigger,
  type TriggerContext,
} from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup as targets } from "./test-targets.ts";

const FIXTURE = join(import.meta.dirname, "syntax/member.ts");

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-")));
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
  syntax?: Dialect,
): Ir {
  let ir: Ir | undefined;
  compileSource(source, file, declarations, {
    targets,
    ...(syntax ? { dialect: syntax } : {}),
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

/** A dialect overlaying `rows` with `lowerTrigger` (and any other hook). */
function dialectWith(
  rows: Partial<Dialect["table"]>,
  hooks: Partial<Omit<Dialect, "table">> = {},
): Dialect {
  // Named "MX" so core's wording in these messages stays MX's.
  return { id: "test", name: "MX", table: rows, ...hooks };
}

describe("the member dialect through the `dialect` option", () => {
  it("an expression trigger is the dialect's node; the authored text and atoms stay", () => {
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

  it("a line trigger's child carries `trigger` (id, span, text); an authored tag has none", () => {
    const source = 'div\n  &title\n  <member name="x"/>\n';
    const [div] = elements(irOf(source, undefined, memberSyntax).body);
    const [line, authored] = elements((div as Element).children);
    expect(line?.trigger).toEqual({
      id: "member",
      span: { sourceStart: 6, sourceEnd: 12 },
      text: "&title",
    });
    expect(source.slice(6, 12)).toBe("&title");
    expect(authored?.name).toBe("member");
    expect(authored && "trigger" in authored).toBe(false);
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
    const counting: Dialect = {
      ...memberSyntax,
      lowerTrigger: (id, text, span, ctx) => {
        seen.push(`${ctx.position}:${text}`);
        return (
          memberSyntax.lowerTrigger as NonNullable<Dialect["lowerTrigger"]>
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

describe("a dialect package (`package.json#mx.dialect`, decision 212)", () => {
  /**
   * The member dialect, declared by a dependency claiming `.mesh.mx`, whose
   * module (at `module`, inside the package) re-exports the fixture.
   */
  function memberProject(module = "./syntax.mjs") {
    const project = dialectProject(dir, {
      manifest: {
        id: "member",
        name: "Mesh",
        extensions: [".mesh.mx"],
        module,
      },
    });
    const file = join(project.packageDir, module);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `export { default } from ${JSON.stringify(FIXTURE)};\n`,
    );
    return project;
  }

  it("the module loads the dialect and its hooks for the files it claims", () => {
    memberProject();
    const [sort] = elements(
      irOf("sort asc &dueOn\n", join(dir, "a.mesh.mx")).body,
    );
    expect(attr(sort as Element, "member")).toMatchObject({
      member: { name: "dueOn" },
    });
    expect(resolveSyntaxOf(join(dir, "a.mx")).isDefault).toBe(true);
  });

  it("a package subpath with no `./` resolves from the dialect's package", () => {
    memberProject("lib/syntax.mjs");
    const [input] = elements(
      irOf("fields\n  &title\n", join(dir, "a.mesh.mx")).body,
    );
    expect(elements((input as Element).children)[0]?.name).toBe("member");
  });

  it("the manifest's `id` and `name` are stamped on the dialect", () => {
    dialectProject(dir, { module: "export default { table: {} };" });
    const { dialect } = resolveSyntaxOf(join(dir, "page.tst"));
    expect(dialect).toMatchObject({ id: "test", name: "Test" });
    expect(Object.isFrozen(dialect)).toBe(true);
  });

  // Before 22.20, Node cannot `require` an ES module again once its
  // evaluation threw ("Unexpected module status 5"), so a second load would
  // report Node's error in place of the dialect's. The first is kept.
  it("a module that fails to load reports that error on every load until its file changes", () => {
    const { packageDir } = dialectProject(dir, {
      module: "throw new Error('broken dialect');",
    });
    const file = join(packageDir, "index.mjs");
    const page = join(dir, "page.tst");
    const first = caught(() => resolveSyntaxOf(page));
    expect([first.message, first.file, first.line, first.column]).toEqual([
      "dialect failed to load: broken dialect",
      file,
      1,
      0,
    ]);
    expect(caught(() => irOf("div\n", page))).toBe(first);
    expect(caught(() => resolveSyntaxOf(page))).toBe(first);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(caught(() => resolveSyntaxOf(page))).not.toBe(first);
  });

  it("an edited dialect is resolved again (Vitest keeps its own module registry, so not re-evaluated here)", () => {
    const { packageDir } = dialectProject(dir, {
      module: `export default { table: { attributeTriggers: [${JSON.stringify(MEMBER)}] }, lowerTrigger: (id, text, span, ctx) => ctx.attribute("m", { kind: "member", name: text.slice(1) }) };`,
    });
    const file = join(packageDir, "index.mjs");
    const page = join(dir, "page.tst");
    const first = resolveSyntaxOf(page);
    expect(first.dialect?.lowerTrigger).toBeTypeOf("function");
    expect(resolveSyntaxOf(page)).toBe(first);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const second = resolveSyntaxOf(page);
    expect(second).not.toBe(first);
    expect(resolveSyntaxOf(page)).toBe(second);
  });

  it("a module that does not resolve is an error at `mx.dialect.module`", () => {
    const { packageFile, packageDir } = dialectProject(dir, {
      manifest: { module: "./missing.ts" },
    });
    const error = caught(() => irOf("div\n", join(dir, "page.tst")));
    expect(error.file).toBe(packageFile);
    expect([error.line, error.column]).toEqual([10, 6]);
    expect(error.message).toBe(
      `the dialect \`test\`'s module "./missing.ts" cannot be resolved from ${packageDir}. Check \`mx.dialect.module\`.`,
    );
  });

  it("a `{ call }` trigger with no `lowerTrigger` is an error in the dialect file", () => {
    const { packageDir } = dialectProject(dir, {
      module: `export default { table: { lineTriggers: [${JSON.stringify(MEMBER)}] } };`,
    });
    const error = caught(() => irOf("div\n", join(dir, "page.tst")));
    expect(error.file).toBe(join(packageDir, "index.mjs"));
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).toBe(
      '`table.lineTriggers[0]` (trigger "member") has a `{ call }` node, and the dialect exports no `lowerTrigger`',
    );
  });

  it.each([
    [
      "export default 1;",
      "dialect must `export default` a dialect object (`{ table, lowerTrigger?, … }`)",
    ],
    [
      "export default { };",
      "`table` is required: the dialect's syntax table fields",
    ],
    [
      "export default { table: {}, lower: () => 1 };",
      "`lower` is not a dialect field (id, name, table, tagRules, nodeTypes, lowerTrigger, lowerBlockTag, lowerFilter, afterLower, contractFields, checkContract, describeAttribute)",
    ],
    [
      "export default { table: {}, lowerTrigger: 1 };",
      "`lowerTrigger` must be a function",
    ],
    [
      "export default { table: {}, productName: 'Mesh' };",
      "`productName` is not a dialect field (id, name, table, tagRules, nodeTypes, lowerTrigger, lowerBlockTag, lowerFilter, afterLower, contractFields, checkContract, describeAttribute)",
    ],
    [
      "export default { id: 'other', table: {} };",
      '`id` is "other", and the dialect\'s `package.json#mx.dialect.id` is "test": leave it to the manifest, or make them agree',
    ],
    [
      "export default { name: 'Other', table: {} };",
      '`name` is "Other", and the dialect\'s `package.json#mx.dialect.name` is "Test": leave it to the manifest, or make them agree',
    ],
    [
      "export default { table: { tagTypes: {} } };",
      "`table.tagTypes` is not a manifest field: tag types are taglib-owned, computed from the tags and their parseOptions",
    ],
  ])("a dialect `%s` is an error in the dialect file", (body, message) => {
    const { packageDir } = dialectProject(dir, { module: body });
    const error = caught(() => irOf("div\n", join(dir, "page.tst")));
    expect(error.file).toBe(join(packageDir, "index.mjs"));
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).toBe(message);
  });

  it("a dialect that matches the manifest's `id` and `name` is accepted", () => {
    dialectProject(dir, {
      module: "export default { id: 'test', name: 'Test', table: {} };",
    });
    expect(resolveSyntaxOf(join(dir, "page.tst")).dialect?.id).toBe("test");
  });

  it("the removed `mx.syntax` is an error at its key, on every file of the project", () => {
    const file = manifest(dir, { syntax: "./syntax.ts" });
    for (const page of ["page.mx", "page.tst"]) {
      const error = caught(() => irOf("div\n", join(dir, page)));
      expect(error.file).toBe(file);
      expect([error.line, error.column]).toEqual([3, 9]);
      expect(error.message).toBe(
        "`mx.syntax` is removed: a syntax of your own is a dialect, a package that declares itself in its `package.json#mx.dialect` (`id`, `name`, the `extensions` it claims, its `module`) and is one of the project's dependencies; a file goes to the dialect that claims its extension. `.mx` files are always MX's.",
      );
    }
  });
});

describe("the built-in node kinds lower in core", () => {
  const row = (node: Trigger["node"]): Trigger => ({ ...MEMBER, node });

  it('`"string"` and `"identifier"` in an expression', () => {
    const strings = irOf(
      "rule x=&a\n",
      undefined,
      dialectWith({ expressionTriggers: [row("string")] }),
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
      dialectWith({ expressionTriggers: [row("identifier")] }),
    );
    const y = attr(elements(ids.body)[0] as Element, "x");
    expect(y.kind === "dynamic" && y.value.node).toMatchObject({
      type: "Identifier",
      name: "&a",
    });
  });

  it('`"attribute"` in an attribute list: named after the sigil, bare or with its `=value`', () => {
    const syntax = dialectWith({ attributeTriggers: [row("attribute")] });
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
        irOf(source, undefined, dialectWith({ [list]: [row(node)] })),
      );
      expect(error.message).toBe(
        `the \`member\` trigger's \`node: "${node}"\` has no meaning in ${where}; use \`{ call }\` and a dialect's \`lowerTrigger\``,
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

  it("a `{ call }` trigger with no `lowerTrigger` in an option dialect has no lowering yet", () => {
    const error = caught(() =>
      irOf("rule x=&a\n", undefined, dialectWith(rows)),
    );
    expect(error.message).toBe("`member` trigger has no lowering yet");
    expect([error.line, error.column]).toEqual([1, 7]);
  });

  it.each([
    ["rule x=&a\n", "ctx.expression(node)", "an expression"],
    ["sort &a\n", "ctx.attribute(name, value)", "an attribute list"],
    ["div\n  &a\n", "ctx.child(tagName, attrs)", "a tagless line"],
  ])("%j: the result must fit the position", (source, want, where) => {
    const wrong = dialectWith(rows, {
      lowerTrigger: (_id, _text, _span, ctx) =>
        ctx.position === "line"
          ? ctx.expression({ type: "NullLiteral" })
          : ctx.child("x", []),
    });
    expect(caught(() => irOf(source, undefined, wrong)).message).toBe(
      `the \`member\` trigger's \`lowerTrigger\` must return \`${want}\` for a trigger in ${where}`,
    );
  });

  it.each([
    [
      "a statement",
      { type: "ExpressionStatement", expression: { type: "NullLiteral" } },
      "an `ExpressionStatement`",
    ],
    [
      "an identifier with no name (review 451 r2)",
      { type: "Identifier" },
      "an `Identifier` whose `name` is invalid (Property name expected type of string but got undefined)",
    ],
    [
      "a member whose property has no name",
      {
        type: "MemberExpression",
        object: { type: "Identifier", name: "self" },
        property: { type: "Identifier" },
      },
      "an `Identifier` whose `name` is invalid (Property name expected type of string but got undefined)",
    ],
    ["an unknown type", { type: "Bogus" }, "a `Bogus`"],
    ["an object with no type", {}, "an object with no `type`"],
    ["undefined", undefined, "`undefined`"],
    ["a string", "self.a", "a string"],
  ])(
    "`ctx.expression` refuses %s, positioned at the trigger",
    (_, node, got) => {
      const bad = dialectWith(rows, {
        lowerTrigger: (_id, _text, _span, ctx) =>
          // SAFETY: the row's point is a node the runtime must refuse; the
          // assertion deliberately bypasses the parameter type.
          ctx.expression(node as unknown as object),
      });
      const error = caught(() => irOf("rule x=&a\n", undefined, bad));
      expect(error.message).toBe(
        `the \`member\` trigger's \`lowerTrigger\`: \`ctx.expression\` takes a Babel expression node, got ${got}`,
      );
      expect([error.line, error.column]).toEqual([1, 7]);
    },
  );

  it("a Babel-typed node satisfies ctx.expression's parameter (type-level)", () => {
    // Review 485 r3: the parameter must keep accepting Babel's own node
    // types — a shaped parameter with an index signature rejected
    // `t.StringLiteral` (interfaces carry no index signature). The call
    // never runs; the assertion is the type check itself, enforced by tsc.
    const types = coreBabel().types;
    const ctx = null as unknown as TriggerContext;
    expect(() => ctx.expression(types.stringLiteral("x"))).toThrow();
  });

  it("`ctx.expression` accepts a node that leaves out a field Babel defaults", () => {
    const lean = dialectWith(rows, {
      lowerTrigger: (_id, text, _span, ctx) =>
        ctx.expression({
          type: "MemberExpression",
          object: { type: "Identifier", name: "self" },
          property: { type: "Identifier", name: text.slice(1) },
        }),
    });
    const [rule] = elements(irOf("rule x=(&a + 1)\n", undefined, lean).body);
    const x = attr(rule as Element, "x");
    expect(x.kind === "dynamic" && x.value.code).toBe("self.a + 1");
  });

  it("a dialect-built expression value prints into `code`", () => {
    const built = dialectWith(rows, {
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
    const forged = dialectWith(rows, {
      lowerTrigger: () =>
        ({ kind: "expression", node: { type: "NullLiteral" } }) as never,
    });
    expect(caught(() => irOf("rule x=&a\n", undefined, forged)).message).toBe(
      "the `member` trigger's `lowerTrigger` must return what `ctx.expression`, `ctx.attribute`, `ctx.shorthand` or `ctx.child` built (a non-empty list of attributes and shorthands in an attribute list)",
    );
  });

  it("a hook that throws is positioned at the trigger", () => {
    const throwing = dialectWith(rows, {
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
    const own = dialectWith(rows, {
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
      const dropping = dialectWith(rows, {
        lowerTrigger: (_id, text, span, ctx) =>
          ctx.attribute("member", {
            kind: "member",
            name: text.slice(1),
            span,
          }),
      });
      const error = caught(() => irOf(source, undefined, dropping));
      expect(error.message).toBe(
        "`&a` takes no `=value` here: the `member` trigger does not place it",
      );
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );

  it.each([
    ["sort asc &a=1\n", 1, 9],
    ["sort asc &a = 1\n", 1, 9],
    ["sort asc &a(x) { return 1 }\n", 1, 9],
    ["sort asc &a := b\n", 1, 9],
  ])(
    "%j: the member dialect refuses a value after a kind, at the member (review 460 F6)",
    (source, line, column) => {
      const error = caught(() => irOf(source, undefined, memberSyntax));
      expect(error.message).toBe(
        "`&a` is a member reference and takes no value",
      );
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );

  it("a line trigger that drops its `=value` is an error too", () => {
    const dropping = dialectWith(rows, {
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
    const syntax = dialectWith(table, {
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

  it("a dialect without them keeps the no-lowering error", () => {
    const syntax = dialectWith(table);
    expect(
      caught(() => irOf("<p>{% x %}</p>", undefined, syntax)).message,
    ).toBe("a block tag has no lowering yet");
    expect(
      caught(() => irOf("<p>::md::y::</p>", undefined, syntax)).message,
    ).toBe("the `md` filter has no lowering yet");
  });

  it("a hook that returns no IR is refused", () => {
    const syntax = dialectWith(table, {
      lowerBlockTag: () => ({}) as IrNode,
    });
    expect(
      caught(() => irOf("<p>{% x %}</p>", undefined, syntax)).message,
    ).toBe(
      "the dialect's `lowerBlockTag` must return IR nodes (build them with `ctx.build`)",
    );
  });
});

describe("`afterLower` and the dialect's `name`", () => {
  it("the dialect's `afterLower` runs once, with the unit's view, and its `name` names the language", () => {
    const seen: string[] = [];
    const names: (string | undefined)[] = [];
    const file = join(dir, "page.mx");
    compileSource("sort asc &a\n", file, declarations, {
      targets,
      dialect: {
        ...memberSyntax,
        name: "Acme",
        afterLower: (unit: LoweredUnit) => {
          seen.push(unit.file);
        },
      },
      emitIr: (_ir, ctx) => {
        names.push(ctx.productName);
        return "";
      },
    });
    expect(seen).toEqual([file]);
    expect(names).toEqual(["Acme"]);
  });

  it("the host's `productName` wins", () => {
    const names: (string | undefined)[] = [];
    compileSource("div\n", join(dir, "page.mx"), declarations, {
      targets,
      productName: "Host",
      dialect: {
        ...memberSyntax,
        name: "Acme",
        afterLower: () => {},
      },
      emitIr: (_ir, ctx) => {
        names.push(ctx.productName);
        return "";
      },
    });
    expect(names).toEqual(["Host"]);
  });
});

describe("a fragment lowers with its syntax", () => {
  it("`parseFragment` + `lowerChildren` lower the triggers", () => {
    const source = "<sort asc &dueOn/>";
    const { body } = parseFragment(source, {
      filename: join(dir, "page.solid.mx"),
      dialect: memberSyntax,
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
