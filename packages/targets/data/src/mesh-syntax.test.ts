/**
 * Slice a1 of `lang-ext-move-sugars-to-mesh` (decisions 183 and 196): Mesh's
 * syntax v4 reference file through `parseData` with the combined reference
 * module `@mxlang/core/syntax/mesh` (atoms and the name sugars as layer-2
 * triggers, plus the `&` member rows), loaded the two ways a consumer loads
 * it. The shapes Mesh reads stay those of the built-in path: a whole-value
 * atom is `{ kind: "atom" }`, an atom inside an expression a `StringLiteral`
 * marked `extra.mxAtom`, a member `{ kind: "member" }` or `extra.mxMember`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyntaxModule } from "@mxlang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ParseDataOptions, parseData } from "./parse.ts";
import type { DataAttr, DataTag } from "./tree.ts";

const MODULE = join(import.meta.dirname, "../../../core/src/syntax/mesh.ts");

/** Through Node's strip-only `require`, as a manifest's `mx.syntax` loads it. */
const meshSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: SyntaxModule }
).default;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-mesh-syntax-")));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mesh-app", mx: { syntax: MODULE } }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE: ParseDataOptions = { structural: "reject", imports: "pass" };

const LOADERS: [string, () => [string, ParseDataOptions]][] = [
  ["a manifest naming the module", () => [join(dir, "invoice.mesh.mx"), BASE]],
  [
    "the `syntax` option",
    () => ["/v/invoice.mesh.mx", { ...BASE, syntax: meshSyntax }],
  ],
];

/** An excerpt of Mesh's entity-file reference (its ADR 0050, `0050-entity-file-syntax.md`), every v4 form once. */
const INVOICE = `import { Customer } from "./customer.mesh.mx"

entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    enum :status values=[:draft, :sent, :paid] default=:draft
    date :dueOn
  relationships
    belongs-to :customer entity=Customer
  computed
    boolean :isOverdue() {
      return &status === :sent && &dueOn < today()
    }
  actions auto=[:read, :destroy] on:load=&visible
    update :send
      do
        set
          &status=:sent
    read :overdue
      filter=() => &isOverdue
      sort
        asc &dueOn
`;

function tags(nodes: readonly unknown[]): DataTag[] {
  return nodes.filter(
    (node): node is DataTag => (node as DataTag).kind === "tag",
  );
}

/** The first tag named `name`, depth first. */
function find(nodes: readonly unknown[], name: string): DataTag {
  for (const tag of tags(nodes)) {
    if (tag.name === name) return tag;
    try {
      return find(tag.children, name);
    } catch {
      // not under this one
    }
  }
  throw new Error(`no <${name}>`);
}

function attr(tag: DataTag, name: string): DataAttr {
  const found = tag.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name} on <${tag.name}>`);
  return found;
}

describe.each(LOADERS)("Mesh's v4 reference file through %s", (_, load) => {
  function parsed() {
    const [file, options] = load();
    const result = parseData(INVOICE, file, options);
    expect(result.diagnostics).toEqual([]);
    return result.tree as NonNullable<typeof result.tree>;
  }

  it("a declaration's name is a whole-value atom", () => {
    const tree = parsed();
    expect(attr(find(tree.children, "entity"), "name")).toMatchObject({
      kind: "atom",
      value: "Invoice",
    });
    expect(attr(find(tree.children, "uuid"), "name")).toMatchObject({
      kind: "atom",
      value: "id",
    });
  });

  it("atoms in expressions are marked string literals", () => {
    const tree = parsed();
    const status = find(tree.children, "enum");
    expect(attr(status, "default")).toMatchObject({
      kind: "atom",
      value: "draft",
    });
    const values = attr(status, "values");
    if (values.kind !== "expression") throw new Error(values.kind);
    expect(values.value.node).toMatchObject({
      type: "ArrayExpression",
      elements: [
        { type: "StringLiteral", value: "draft", extra: { mxAtom: {} } },
        { type: "StringLiteral", value: "sent" },
        { type: "StringLiteral", value: "paid" },
      ],
    });
  });

  it("`:name` then a method is the name and the default value, members inside", () => {
    const overdue = find(parsed().children, "boolean");
    expect(attr(overdue, "name")).toMatchObject({
      kind: "atom",
      value: "isOverdue",
    });
    const value = attr(overdue, "value");
    expect(value.kind).toBe("expression");
    expect(JSON.stringify(value)).toContain('"mxMember"');
    expect(JSON.stringify(value)).toContain('"mxAtom"');
  });

  it("members after a kind, on a tagless line and in a value", () => {
    const tree = parsed();
    expect(attr(find(tree.children, "asc"), "member")).toMatchObject({
      kind: "member",
      value: "dueOn",
    });
    const member = find(find(tree.children, "set").children, "member");
    expect(attr(member, "name")).toMatchObject({ value: "status" });
    expect(attr(member, "value")).toMatchObject({
      kind: "atom",
      value: "sent",
    });
    const load = find(tree.children, "actions").attrs.find(
      (each) => each.kind !== "spread" && each.name.startsWith("on"),
    );
    expect(JSON.stringify(load)).toContain('"mxMember"');
  });
});

describe("what the module refuses (decision 183)", () => {
  it.each([
    ["kind #x=1\n", "The `#x` shorthand takes no value.", 7],
    ["kind .c=1\n", "The `.c` shorthand takes no value.", 7],
    ["kind #name(p) { b }\n", "The `#name` shorthand takes no value.", 10],
  ])("%j", (source, message, offset) => {
    const { diagnostics } = parseData(source, "/v/x.mx", {
      syntax: meshSyntax,
    });
    expect(diagnostics[0]).toMatchObject({ message, offset });
  });
});

const ATOMS_SUGARS = join(
  import.meta.dirname,
  "../../../core/src/syntax/atoms-sugars.ts",
);
const atomsSugars = (
  createRequire(import.meta.url)(ATOMS_SUGARS) as { default: SyntaxModule }
).default;

/** The first diagnostic's text and position, built-in path or module path. */
function firstError(source: string, syntax?: SyntaxModule) {
  const { diagnostics } = parseData(source, "/v/x.mx", {
    ...(syntax ? { syntax } : {}),
  });
  const [first] = diagnostics;
  return (
    first && {
      message: first.message,
      line: first.line,
      column: first.column,
    }
  );
}

describe("the module path reuses the built-in texts and positions (review 460)", () => {
  it.each([
    // B1: a second default value against a written `value`, both orders.
    "<x value=1 :n=2/>",
    "<x value:=y :n=1/>",
    "<x :n=1 value=2/>",
    "<x :n(p){ return p } value=1/>",
    "<x value=1 :n(p){ return p }/>",
    "<x :a=1 :b=2/>",
    // L1: one name too many, an empty shorthand part.
    "<x :a:b/>",
    "<x #a:b:c/>",
    "<x .a..b/>",
    // L1: the built-in fix-its for arguments and a bound value.
    "<x :a(p)/>",
    "<x :n:=y/>",
    "<x #a##b/>",
  ])("%s", (source) => {
    const builtIn = firstError(source);
    expect(builtIn).toBeDefined();
    // The module's texts quote no MX decision numbers (review 460 F6).
    const message = builtIn?.message.replace(/ \(decision [^)]*\)/g, "");
    expect(firstError(source, atomsSugars)).toEqual({ ...builtIn, message });
    expect(message).not.toContain("decision");
  });

  // Core's own after-value text, raised before any trigger runs, so the same
  // on both paths.
  it("<x=1 :n=2/>", () => {
    expect(firstError("<x=1 :n=2/>", atomsSugars)).toEqual(
      firstError("<x=1 :n=2/>"),
    );
  });
});

describe("hook-contract guards and carriers (review 460)", () => {
  /** A module whose `!` attribute row calls `hook`. */
  const probe = (
    hook: NonNullable<SyntaxModule["lowerTrigger"]>,
  ): SyntaxModule => ({
    table: {
      attributeTriggers: [
        {
          id: "probe",
          chars: "!",
          match: "![a-z]+",
          standIn: "keep",
          node: { call: "probe" },
        },
      ],
    },
    lowerTrigger: hook,
  });

  it.each([
    [{ sourceStart: -5, sourceEnd: -1 }],
    [{ sourceStart: 500, sourceEnd: 600 }],
    [{ sourceStart: 3, sourceEnd: 2 }],
  ])(
    "`ctx.fail`'s `at` %j outside the document is the hook-contract error at the trigger",
    (at) => {
      const module = probe((_id, _text, _span, ctx) => ctx.fail("x", { at }));
      const { diagnostics } = parseData("<y !ab/>", "/v/x.mx", {
        syntax: module,
      });
      expect(diagnostics[0]).toMatchObject({
        message: expect.stringContaining(
          "`ctx.fail`'s `at` is a `{ sourceStart, sourceEnd }` span inside the document (0 to 8)",
        ),
        line: 1,
        column: 3,
        offset: 3,
      });
    },
  );

  it("`ctx.attribute`'s `at` outside the document is refused too", () => {
    const module = probe((_id, _text, _span, ctx) =>
      ctx.attribute("a", true, { at: { sourceStart: -5, sourceEnd: -1 } }),
    );
    const { diagnostics } = parseData("<y !ab/>", "/v/x.mx", {
      syntax: module,
    });
    expect(diagnostics[0]?.message).toContain(
      "`ctx.attribute`'s `at` is a `{ sourceStart, sourceEnd }` span inside the document",
    );
  });

  it("`ctx.fail`'s `code` reaches `DataDiagnostic.code`", () => {
    const module = probe((_id, _text, _span, ctx) =>
      ctx.fail("nope", { code: "MESH001" }),
    );
    const { diagnostics } = parseData("<y !ab/>", "/v/x.mx", {
      syntax: module,
    });
    expect(diagnostics[0]).toMatchObject({ message: "nope", code: "MESH001" });
    // A diagnostic with no code carries none.
    expect(
      parseData("<y x=(/>", "/v/x.mx", {}).diagnostics[0],
    ).not.toHaveProperty("code");
  });

  it("a method value the hook drops is named a method value", () => {
    const module = probe((_id, _text, _span, ctx) => ctx.attribute("a", true));
    const { diagnostics } = parseData("<y !ab(p) { b }/>", "/v/x.mx", {
      syntax: module,
    });
    expect(diagnostics[0]?.message).toBe(
      "`!ab` takes no method value here: the `probe` trigger does not place it",
    );
  });

  it.each([
    ["<y async !ab(p) { await p }/>", 9, "(p) { await p }"],
    ["kind async !ab<T>(p: T) { await p }\n", 11, "<T>(p: T) { await p }"],
  ])(
    "%j: a placed async method is an async function whose span starts after the trigger (review 460 F1)",
    (source, triggerStart, valueText) => {
      const seen: unknown[] = [];
      const module = probe((_id, text, span, ctx) => {
        seen.push({ form: ctx.valueForm, value: ctx.value, span });
        return ctx.attribute(text.slice(1), ctx.value ?? true);
      });
      const { tree, diagnostics } = parseData(source, "/v/x.mx", {
        syntax: module,
      });
      expect(diagnostics).toEqual([]);
      expect(seen).toEqual([
        {
          form: "async-method",
          value: { kind: "method", async: true },
          span: { sourceStart: triggerStart, sourceEnd: triggerStart + 3 },
        },
      ]);
      const placed = attr(tags(tree?.children ?? [])[0] as DataTag, "ab");
      if (placed.kind !== "expression") throw new Error(placed.kind);
      const { sourceStart, sourceEnd } = placed.value.span;
      expect(source.slice(sourceStart, sourceEnd)).toBe(valueText);
      expect(placed.value.node).toMatchObject({
        type: "FunctionExpression",
        async: true,
      });
      expect(placed.value.code).toBe("async function (p) { await p; }");
    },
  );

  it("a method without `async` is the `method` form, not async", () => {
    const seen: unknown[] = [];
    const module = probe((_id, text, _span, ctx) => {
      seen.push(ctx.valueForm, ctx.value);
      return ctx.attribute(text.slice(1), ctx.value ?? true);
    });
    const { tree } = parseData("<y !ab(p) { p }/>", "/v/x.mx", {
      syntax: module,
    });
    expect(seen).toEqual(["method", { kind: "method", async: false }]);
    const placed = attr(tags(tree?.children ?? [])[0] as DataTag, "ab");
    expect(placed).toMatchObject({ value: { node: { async: false } } });
  });
});

describe("`DataDiagnostic.file` names only another file (review 460 F8)", () => {
  const MEMBER = join(
    import.meta.dirname,
    "../../../core/src/syntax/member.ts",
  );
  const memberSyntax = (
    createRequire(import.meta.url)(MEMBER) as { default: SyntaxModule }
  ).default;
  const PATHS: [string, ParseDataOptions][] = [
    ["built-in atoms and sugars", BASE],
    ["`syntax/member` (alpha.14)", { ...BASE, syntax: memberSyntax }],
    ["`syntax/mesh` (alpha.15)", { ...BASE, syntax: meshSyntax }],
  ];
  const SOURCES = [
    "enum values=[::x]\n",
    "<x :a:b/>",
    "<y x=(/>",
    "entity :A\n  <for of=[1]|x|>\n  </for>\n",
  ];
  it.each(
    PATHS.flatMap(([path, options]) =>
      SOURCES.map((source) => [path, source, options] as const),
    ),
  )(
    "%s, %j: a diagnostic in the parsed file has no `file`",
    (_, source, options) => {
      for (const file of ["/v/x.mesh.mx", "relative/x.mesh.mx"]) {
        const { diagnostics } = parseData(source, file, options);
        expect(diagnostics.length, file).toBeGreaterThan(0);
        for (const diagnostic of diagnostics) {
          expect(diagnostic, file).not.toHaveProperty("file");
        }
      }
    },
  );
});
