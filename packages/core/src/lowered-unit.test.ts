/**
 * Slice a2 of `lang-ext-move-sugars-to-mesh` (lead ruling Q2 A): a syntax
 * module's `afterLower(unit)` sees a public view of the unit
 * (`LoweredUnit`), and `contractFields` hands contract keys to the module.
 *
 * - The atom contract checks, run by the reference module from that view,
 *   against core's built-in path: same error text, position, spans and code.
 * - The view: calls, attributes in every kind, attribute tags at any depth,
 *   ancestors and their scope identity, `declared`, frozen.
 * - `fail` and `warn`.
 * - `contractFields`: shape, registration acceptance and refusal, takeover
 *   (core stops checking a claimed key), through the `syntax` option, a
 *   manifest's `mx.syntax`, `mx.contracts` and a sidecar.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import {
  isTranslateError,
  type MxWarning,
  type TranslateError,
} from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { ContractAttr, LoweredUnit } from "./lowered-unit.ts";
import { scanCustomTags } from "./scan.ts";
import meshSyntax from "./syntax/mesh.ts";
import { defaultSyntax, type SyntaxModule } from "./syntax-table.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const FILE = "/tmp/mx-lowered-unit/page.mx";
const MESH_MODULE = join(import.meta.dirname, "syntax/mesh.ts");

const host: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => true,
  resolveDefaultTag: () => "setter",
  attrTags: 2,
};

type Syntax = SyntaxModule | ReturnType<typeof defaultSyntax>;

function compile(
  source: string,
  customTags: Record<string, CustomTag>,
  syntax: Syntax,
  options: { file?: string; warnings?: MxWarning[] } = {},
) {
  return compileSource(source, options.file ?? FILE, host, {
    targets,
    customTags,
    tagDiscoveryDirs: [],
    warnings: options.warnings ?? [],
    syntax,
    emitIr: () => "",
  });
}

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    if (!isTranslateError(error)) throw error;
    return error;
  }
  throw new Error("expected a TranslateError");
}

/** What a compile reports: success, or the error as every reporter reads it. */
function outcome(
  source: string,
  customTags: Record<string, CustomTag>,
  syntax: Syntax,
): unknown {
  const warnings: MxWarning[] = [];
  try {
    compile(source, customTags, syntax, { warnings });
    return { ok: true, warnings };
  } catch (error) {
    if (!isTranslateError(error)) throw error;
    return {
      message: error.message,
      line: error.line,
      column: error.column,
      file: error.file,
      spans: error.spans,
      diagnosticCode: error.diagnosticCode,
    };
  }
}

/** Analyze hook: declares `name` (of `kind`) at each call, optionally scoped. */
function deriving(
  kind: string,
  name: string,
  scope?: string | string[],
): CustomTag {
  return {
    analyze(calls, ctx) {
      for (const call of calls) {
        if (call.span) ctx.declare(kind, name, { span: call.span, scope });
      }
    },
  };
}

const NAMES = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
];

const vocab: Record<string, CustomTag> = {
  entity: {},
  attributes: {},
  actions: {},
  arguments: {},
  relationships: {},
  string: {
    attributes: { name: { type: "atom" } },
    declares: [
      { kind: "attribute", from: "name", under: "attributes" },
      {
        kind: "argument",
        from: "name",
        under: "arguments",
        scope: ["create", "read", "update", "destroy", "action"],
      },
    ],
  },
  action: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "action", from: "name" },
  },
  "has-many": {
    attributes: { name: { type: "atom" } },
    declares: { kind: "relationship", from: "name" },
  },
  calc: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "computed", from: "name" },
  },
  policy: {
    attributes: {
      accept: { type: "atom", ref: "attribute" },
      load: { type: "atom", ref: ["relationship", "computed"] },
      require: { type: "atom", ref: ["attribute", "argument"] },
      types: { type: "atom", values: ["create", "read", "update", "destroy"] },
      only: { type: "atom", ref: "attribute", values: ["title", "body"] },
      shaped: { type: "atom", ref: "attribute", pattern: "^t" },
    },
  },
  setter: {
    attributes: { name: { type: "atom", ref: "attribute" }, value: {} },
  },
  set: { defaultTag: "setter" },
  box: {
    attributes: {
      mode: { type: "atom", values: ["strict", "loose"] },
      slug: { type: "atom", pattern: "^[a-z]+$" },
      both: { type: "atom", values: ["a1", "b2"], pattern: "^[a-z]\\d$" },
      many: { type: "atom", values: NAMES },
      ten: { type: "atom", values: NAMES.slice(0, 10) },
    },
    attributeTags: {
      row: {
        attributes: {
          mode: { type: "atom", values: ["a", "b"] },
          to: { type: "atom", ref: "node" },
        },
        attributeTags: {
          cell: { attributes: { k: { type: "atom", values: ["x", "y"] } } },
        },
      },
      "*": {
        pattern: "col-.*",
        attributes: { to: { type: "atom", ref: "node" } },
      },
    },
  },
  node: { attributes: { id: {} }, declares: { kind: "node", from: "id" } },
  link: { attributes: { to: { type: "atom", ref: "node" } } },
  slot: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "slot", from: "name", uniqueWith: ["node"] },
  },
  scoped: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "item", from: "name", scope: ["list", "grid"] },
  },
  list: {},
  item: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "item", from: "name", scope: "list" },
  },
  pick: { attributes: { of: { type: "atom", ref: "item" } } },
  derive: deriving("node", "made"),
  "derive-scoped": deriving("node", "lost", "nowhere"),
  "derive-list": deriving("item", "auto", "list"),
};

const nodes = (names: readonly string[]) =>
  names.map((name) => `<node#${name}/>`).join("");

/** Sources the built-in path rejects: the module must reject them identically. */
const FAILING: readonly string[] = [
  "<box mode=:strct/>",
  "<box mode=:zzzzzz/>",
  "<box slug=:ab-c/>",
  "<box both=:b9/>",
  "<box both=:c3/>",
  "<box mode=[:strict, :lose]/>",
  "<box mode=(c ? :strict : :lose)/>",
  "<box many=:zz/>",
  "<box many=:alpah/>",
  "<box ten=:zz/>",
  "<box mode='strict'/>",
  "<box mode=1/>",
  "<link to='a'/>",
  `${nodes(["a", "b"])}<link to="c"/>`,
  `${nodes(["a"])}<link to=:b/>`,
  `${nodes(["alpha"])}<link to=:alpah/>`,
  `${nodes(NAMES)}<link to=:zz/>`,
  `${nodes(["a"])}\n<node#a/>`,
  `<entity>\n  <attributes><string :a/></attributes>\n</entity>\n<slot :a/><node#a/>`,
  "<node#a/><slot :a/>",
  "<scoped :q/>",
  "<derive-scoped/>",
  "<derive/><node#made/>",
  "<list><item :a/></list><pick of=:a/>",
  "<list><item :a/></list><list><item :b/><pick of=:a/></list>",
  "<list><derive-list/><pick of=:autoo/></list>",
  `<entity :invoice>
  <attributes>
    <string :title/>
    <string :body/>
  </attributes>
  <policy accept=[:title, :bdy]/>
</entity>`,
  `<entity :invoice>
  <relationships><has-many :items/></relationships>
  <attributes><string :title/><calc :total/></attributes>
  <policy load=[:items, :title]/>
</entity>`,
  `<entity :invoice>
  <attributes><string :status/></attributes>
  <actions>
    <action :pay>
      <set>
        <:statuss="paid"/>
      </set>
    </action>
  </actions>
</entity>`,
  `<entity :invoice>
  <attributes><string name="title"/></attributes>
</entity>`,
  `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <action :rename>
      <arguments><string :newTitle/></arguments>
    </action>
    <action :other>
      <policy require=:newTitle/>
    </action>
  </actions>
</entity>`,
  `<entity>
  <attributes><string :title/><string :body/><string :tag/></attributes>
  <policy only=:tag/>
  <policy shaped=:body/>
</entity>`,
  `<entity>\n  <attributes><string :title/></attributes>\n  <policy accept="title"/>\n</entity>`,
  "<box><@row mode=:c/></box>",
  `${nodes(["n"])}<box><@row to=:m/></box>`,
  "<box><@row><@cell k=:z/></@row></box>",
  "<box><@row><@cell k=[:x, :w]/></@row></box>",
  `${nodes(["n"])}<box><@col-1 to=:nn/></box>`,
  `${nodes(["n"])}<box><@col-1 to="n"/></box>`,
];

/** Sources the built-in path accepts. */
const PASSING: readonly string[] = [
  "<box mode=:strict slug=:abc both=:a1/>",
  "<box mode=[:strict, :loose]/>",
  `${nodes(["a"])}<link to=:a/>`,
  "<link to=:later/><node#later/>",
  "<list><item :a/><pick of=:a/></list>",
  "<list><derive-list/><pick of=:auto/></list>",
  "<derive/><link to=:made/>",
  `<entity :invoice>
  <attributes><string :title/></attributes>
  <actions>
    <action :rename>
      <arguments><string :newTitle/></arguments>
      <policy require=[:title, :newTitle]/>
    </action>
  </actions>
</entity>`,
  `${nodes(["n"])}<box><@row mode=:a to=:n><@cell k=:x/></@row><@col-2 to=:n/></box>`,
];

/** Registration errors core raises for the claimed keys; the module raises them file-level. */
const REGISTRATION: ReadonlyArray<
  readonly [string, Record<string, CustomTag>]
> = [
  ["values", { box: { attributes: { a: { type: "string", values: ["a"] } } } }],
  ["pattern", { box: { attributes: { a: { type: "string", pattern: "a" } } } }],
  ["ref", { box: { attributes: { a: { ref: "k" } } } }],
  ["bad values", { box: { attributes: { a: { type: "atom", values: [1] } } } }],
  [
    "bad pattern",
    { box: { attributes: { a: { type: "atom", pattern: "(" } } } },
  ],
  ["bad ref", { box: { attributes: { a: { type: "atom", ref: [] } } } }],
  [
    "nested values",
    {
      box: {
        attributeTags: {
          row: { attributes: { a: { type: "string", values: ["a"] } } },
        },
      },
    },
  ],
  [
    "wildcard values",
    {
      box: {
        attributeTags: {
          "*": {
            pattern: "r.*",
            attributes: { a: { type: "string", values: ["a"] } },
          },
        },
      },
    },
  ],
  ["declares from", { box: { declares: { kind: "k", from: "nope" } } }],
  ["declares kind", { box: { declares: { from: "name" } } }],
  [
    "declares key",
    { box: { declares: { kind: "k", from: "id", scoped: "x" } } },
  ],
  ["declares empty", { box: { declares: [] } }],
  ["declares entry", { box: { declares: [1] } }],
  [
    "declares scope",
    { box: { declares: { kind: "k", from: "id", scope: "" } } },
  ],
  [
    "declares uniqueWith",
    { box: { declares: { kind: "k", from: "id", uniqueWith: "x" } } },
  ],
  [
    "inline children contract",
    {
      box: {
        children: {
          "*": [
            { pattern: "a-.*", contract: "box" },
            { pattern: "b-.*", attributes: { a: { pattern: "x" } } },
          ],
        },
      },
    },
  ],
  [
    "attribute tag inside an inline children contract",
    {
      box: {
        children: {
          "*": {
            pattern: "b-.*",
            attributeTags: {
              row: { attributes: { a: { type: "atom", ref: "" } } },
            },
          },
        },
      },
    },
  ],
] as unknown as ReadonlyArray<readonly [string, Record<string, CustomTag>]>;

describe("the module's contract checks match core's built-in path", () => {
  it.each(FAILING)("%s", (source) => {
    const builtIn = outcome(source, vocab, defaultSyntax());
    expect(builtIn).toHaveProperty("message");
    expect(outcome(source, vocab, meshSyntax)).toEqual(builtIn);
  });

  it.each(PASSING)("%s", (source) => {
    expect(outcome(source, vocab, defaultSyntax())).toEqual({
      ok: true,
      warnings: [],
    });
    expect(outcome(source, vocab, meshSyntax)).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it.each(REGISTRATION)("registration: %s", (_, tags) => {
    // The tag is never called: the module's `checkContract` runs at
    // registration, as core's own check does.
    const builtIn = outcome("<div/>", tags, defaultSyntax());
    expect(builtIn).toMatchObject({ line: 0, column: 0, file: undefined });
    expect(outcome("<div/>", tags, meshSyntax)).toEqual(builtIn);
    expect(outcome("<box/>", tags, meshSyntax)).toEqual(
      outcome("<box/>", tags, defaultSyntax()),
    );
  });

  it("a duplicate carries both spans, the first then the second", () => {
    const source = "<node#a/>\n<node#a/>";
    const error = caught(() => compile(source, vocab, meshSyntax));
    expect(error.message).toBe("`a` is already declared as `node` at 1:7");
    expect(error.spans).toEqual([
      { sourceStart: 6, sourceEnd: 7 },
      { sourceStart: 16, sourceEnd: 17 },
    ]);
    expect([error.line, error.column]).toEqual([2, 6]);
  });
});

describe("completion facts are core's built-in path only (lead 14:29)", () => {
  it("a module that claims the atom fields leaves `atomFacts` empty, and unset on an error", () => {
    const source = "<node#a/><link to=:a/>";
    const facts = (syntax: Syntax) =>
      (compile(source, vocab, syntax).atomFacts as unknown as { calls: [] })
        .calls.length;
    expect(facts(defaultSyntax())).toBe(2);
    expect(facts(meshSyntax)).toBe(0);
    const failing = "<node#a/><link to=:b/>";
    expect(
      caught(() => compile(failing, vocab, defaultSyntax())).atomFacts,
    ).toBeDefined();
    expect(
      caught(() => compile(failing, vocab, meshSyntax)).atomFacts,
    ).toBeUndefined();
  });
});

/** The unit a module's `afterLower` was handed (`fields` claimed). */
function unitOf(
  source: string,
  customTags: Record<string, CustomTag>,
  fields: SyntaxModule["contractFields"] = { tag: ["relations"] },
): LoweredUnit {
  let seen: LoweredUnit | undefined;
  compile(source, customTags, {
    ...meshSyntax,
    contractFields: fields,
    afterLower: (unit) => {
      seen = unit;
    },
  });
  if (!seen) throw new Error("afterLower did not run");
  return seen;
}

describe("the `LoweredUnit` view", () => {
  const tags: Record<string, CustomTag> = {
    open: { relations: ["x"] } as CustomTag,
    group: {},
    item: {
      analyze(calls, ctx) {
        calls.forEach((call, index) => {
          if (call.span) {
            ctx.declare("node", `auto${index}`, {
              span: call.span,
              scope: ["group"],
            });
          }
        });
      },
    },
    box: vocab.box as CustomTag,
  };

  it("lists every call with its contract, its attributes in each kind, and the file", () => {
    const source =
      "<open :named s='str' a=:at e=(x + :y) b v:=w ...rest/>\n<open &due/>";
    const unit = unitOf(source, tags);
    expect(unit.file).toBe(FILE);
    expect(unit.source).toBe(source);
    const [call] = unit.calls;
    expect(call?.tag).toBe("open");
    expect(call?.nameSpan).toEqual({ sourceStart: 1, sourceEnd: 5 });
    expect(call?.span).toEqual({
      sourceStart: 0,
      sourceEnd: source.indexOf("\n"),
    });
    // A claimed tag key is carried as written; unclaimed core keys are not.
    expect(call?.contract).toEqual({ relations: ["x"] });
    const kinds = Object.fromEntries(
      (call?.attrs ?? []).map((attr) => [
        attr.kind === "spread" ? "...spread" : attr.name,
        attr,
      ]),
    ) as Record<string, ContractAttr>;
    expect(kinds.name).toMatchObject({
      kind: "atom",
      value: "named",
      authored: ":named",
      label: "`:named` (`name`)",
      span: { sourceStart: 6, sourceEnd: 12 },
    });
    expect(kinds.s).toMatchObject({
      kind: "string",
      value: "str",
      label: "`s`",
      span: { sourceStart: 15, sourceEnd: 20 },
      nameSpan: { sourceStart: 13, sourceEnd: 14 },
    });
    expect(kinds.a).toMatchObject({ kind: "atom", value: "at" });
    expect(kinds.e).toMatchObject({ kind: "expression", code: 'x + "y"' });
    const marked = (kinds.e as { node: { right: { extra: unknown } } }).node
      .right.extra;
    expect(marked).toMatchObject({ mxAtom: { span: { sourceStart: 34 } } });
    expect(kinds.b).toMatchObject({ kind: "boolean", label: "`b`" });
    expect(kinds.v).toMatchObject({ kind: "expression", bound: true });
    expect(kinds["...spread"]).toMatchObject({
      kind: "spread",
      span: { sourceStart: 48, sourceEnd: 52 },
    });
    // A whole-value member a module built.
    expect(unit.calls[1]?.attrs).toEqual([
      expect.objectContaining({ kind: "member", value: "due" }),
    ]);
  });

  it("gives attribute tags at any depth, each with the declaration it matched", () => {
    const unit = unitOf(
      "<box><@row mode=:a><@cell k=:x/></@row><@col-1 to=:n/></box><node#n/>",
      { ...vocab, ...tags },
    );
    const box = unit.calls.find((call) => call.tag === "box");
    const [row, col] = box?.attributeTags ?? [];
    expect(row?.name).toBe("row");
    const declared = vocab.box?.attributeTags?.row as CustomTag | undefined;
    expect(row?.contract?.attributes).toBe(declared?.attributes);
    expect(row?.attrs[0]).toMatchObject({ kind: "atom", value: "a" });
    const [cell] = row?.attributeTags ?? [];
    expect(cell?.name).toBe("cell");
    expect(cell?.contract?.attributes).toEqual({
      k: { type: "atom", values: ["x", "y"] },
    });
    expect(cell?.attrs[0]).toMatchObject({ kind: "atom", value: "x" });
    // A wildcard entry is resolved for the module.
    expect(col?.name).toBe("col-1");
    expect(col?.contract?.attributes).toEqual({
      to: { type: "atom", ref: "node" },
    });
  });

  it("gives each call its ancestors, outermost first, with one scope per tag instance", () => {
    const unit = unitOf(
      "<group><item/><item/></group><group><item/></group>",
      tags,
    );
    const items = unit.calls.filter((call) => call.tag === "item");
    const groups = unit.calls.filter((call) => call.tag === "group");
    expect(items).toHaveLength(3);
    expect(groups).toHaveLength(2);
    const [a, b, c] = items;
    expect(a?.ancestors.map((each) => each.tag)).toEqual(["group", "item"]);
    // The two items of the first group share its scope; the third does not.
    expect(a?.ancestors[0]?.scope).toBe(b?.ancestors[0]?.scope);
    expect(a?.ancestors[0]?.scope).not.toBe(c?.ancestors[0]?.scope);
    // A call's own scope ends its chain, and is the one its children see.
    expect(a?.ancestors[1]?.scope).not.toBe(b?.ancestors[1]?.scope);
    const first = groups.find(
      (group) => group.span?.sourceStart === a?.ancestors[0]?.span?.sourceStart,
    );
    expect(first?.ancestors.at(-1)?.scope).toBe(a?.ancestors[0]?.scope);
    expect(Object.isFrozen(a?.ancestors[0]?.scope)).toBe(true);
  });

  it("lists what `analyze` hooks declared, in call order", () => {
    const unit = unitOf("<group><item/><item/></group>", tags);
    expect(unit.declared).toEqual([
      {
        kind: "node",
        name: "auto0",
        span: { sourceStart: 7, sourceEnd: 14 },
        scope: ["group"],
      },
      {
        kind: "node",
        name: "auto1",
        span: { sourceStart: 14, sourceEnd: 21 },
        scope: ["group"],
      },
    ]);
  });

  it("is frozen, and built once", () => {
    const unit = unitOf("<group><item a=1/></group>", tags);
    expect(Object.isFrozen(unit)).toBe(true);
    expect(unit.calls).toBe(unit.calls);
    expect(Object.isFrozen(unit.calls)).toBe(true);
    expect(Object.isFrozen(unit.calls[0])).toBe(true);
    expect(Object.isFrozen(unit.calls[0]?.attrs)).toBe(true);
    expect(Object.isFrozen(unit.calls[0]?.contract)).toBe(true);
    expect(Object.isFrozen(unit.declared)).toBe(true);
  });

  it("runs after core's own checks: a core error stops the unit first", () => {
    let ran = false;
    const error = caught(() =>
      compile("<box mode=1/>", vocab, {
        ...meshSyntax,
        afterLower: () => {
          ran = true;
        },
      }),
    );
    expect(error.message).toMatch(/must be atom, got number/);
    expect(ran).toBe(false);
  });
});

describe("`unit.fail` and `unit.warn`", () => {
  const failing = (
    run: (unit: LoweredUnit) => void,
    source = "<x/>\n<y/>",
    warnings: MxWarning[] = [],
  ) =>
    caught(() =>
      compile(
        source,
        {},
        { ...meshSyntax, afterLower: run },
        {
          warnings,
        },
      ),
    );

  it("positions the error at `at`, with `code` and `also`", () => {
    const also = [
      { sourceStart: 0, sourceEnd: 2 },
      { sourceStart: 6, sourceEnd: 7 },
    ];
    const error = failing((unit) =>
      unit.fail("nope", {
        at: { sourceStart: 6, sourceEnd: 7 },
        code: "MESH_X",
        also,
      }),
    );
    expect(error.message).toBe("nope");
    expect([error.line, error.column]).toEqual([2, 1]);
    expect(error.diagnosticCode).toBe("MESH_X");
    expect(error.spans).toEqual(also);
    expect(error.file).toBeUndefined();
  });

  it("without `at` the error is file-level (0:0), with no code or spans", () => {
    const error = failing((unit) => unit.fail("whole file"));
    expect([error.line, error.column]).toEqual([0, 0]);
    expect(error.diagnosticCode).toBeUndefined();
    expect(error.spans).toBeUndefined();
  });

  it.each([
    [{ sourceStart: -5, sourceEnd: 0 }],
    [{ sourceStart: 500, sourceEnd: 600 }],
    [{ sourceStart: 3, sourceEnd: 1 }],
  ])("refuses an `at` outside the document (%o)", (at) => {
    expect(failing((unit) => unit.fail("x", { at })).message).toBe(
      "the syntax module's `afterLower`: `unit.fail`'s `at` is a `{ sourceStart, sourceEnd }` span inside the document (0 to 9)",
    );
    expect(
      failing((unit) =>
        unit.fail("x", { also: [{ sourceStart: 0, sourceEnd: 1 }, at] }),
      ).message,
    ).toBe(
      "the syntax module's `afterLower`: each of `unit.fail`'s `also` is a `{ sourceStart, sourceEnd }` span inside the document (0 to 9)",
    );
  });

  it("refuses an empty message", () => {
    expect(failing((unit) => unit.fail("")).message).toBe(
      "the syntax module's `afterLower`: `unit.fail` takes a non-empty message",
    );
  });

  it("`warn` records a positioned or file-level warning", () => {
    const warnings: MxWarning[] = [];
    compile(
      "<x/>\n<y/>",
      {},
      {
        ...meshSyntax,
        afterLower: (unit) => {
          unit.warn("here", { sourceStart: 6, sourceEnd: 7 });
          unit.warn("file");
        },
      },
      { warnings },
    );
    expect(warnings).toEqual([
      { message: "here", line: 2, column: 1 },
      { message: "file", line: 0, column: 0 },
    ]);
  });
});

describe("`contractFields`", () => {
  const claiming = (
    fields: SyntaxModule["contractFields"],
    afterLower?: SyntaxModule["afterLower"],
  ): SyntaxModule => ({
    table: {},
    contractFields: fields,
    ...(afterLower ? { afterLower } : {}),
  });

  it.each([
    [[], "`syntax.contractFields` must be an object"],
    [{ attr: [] }, "`syntax.contractFields.attr` is not a contract field list"],
    [
      { tag: [""] },
      "`syntax.contractFields.tag` must be an array of non-empty",
    ],
    [
      { attribute: "values" },
      "`syntax.contractFields.attribute` must be an array",
    ],
    [{ attribute: ["type"] }, "cannot claim `type`: core checks it"],
    [{ tag: ["children"] }, "cannot claim `children`: core checks it"],
  ])("refuses the shape %o", (fields, message) => {
    const error = caught(() =>
      compile("<x/>", {}, claiming(fields as SyntaxModule["contractFields"])),
    );
    expect(error.message).toContain(
      "the `syntax` option is not a valid syntax module: ",
    );
    expect(error.message).toContain(message);
  });

  it("a key core does not know is refused, unless the module claims it; then it is the module's data", () => {
    const tags: Record<string, CustomTag> = {
      box: {
        attributes: { a: { type: "atom", facet: "wide" } as never },
        attributeTags: {
          row: { attributes: { b: { facet: "narrow" } as never } },
        },
      },
    };
    expect(caught(() => compile("<box/>", tags, defaultSyntax())).message).toBe(
      'Unknown key "facet" in the "a" attribute declaration of tag "box"; allowed: type, items, required, enum, default, literalOnly, values, pattern, ref',
    );
    let facets: unknown[] = [];
    compile(
      "<box a=:x><@row b=1/></box>",
      tags,
      claiming({ attribute: ["facet"] }, (unit) => {
        const [box] = unit.calls;
        facets = [
          box?.contract.attributes?.a?.facet,
          box?.attributeTags[0]?.contract?.attributes?.b?.facet,
        ];
      }),
    );
    expect(facets).toEqual(["wide", "narrow"]);
  });

  it("core stops checking a claimed key: registration, and the file-level check", () => {
    const tags: Record<string, CustomTag> = {
      box: { attributes: { mode: { type: "atom", values: ["a", "b"] } } },
      node: { declares: { kind: "node", from: "id" } },
    };
    const values = claiming({ attribute: ["values"] });
    expect(() => compile("<box mode=:zz/>", tags, defaultSyntax())).toThrow(
      /is not one of :a, :b/,
    );
    expect(() => compile("<box mode=:zz/>", tags, values)).not.toThrow();
    const malformed = {
      box: { attributes: { mode: { type: "string", values: 5 } } },
    } as unknown as Record<string, CustomTag>;
    expect(() => compile("<box/>", malformed, defaultSyntax())).toThrow(
      /`values` requires `type: "atom"`/,
    );
    expect(() => compile("<box/>", malformed, values)).not.toThrow();

    const declares = claiming({ tag: ["declares"] });
    const dup = "<node#a/><node#a/>";
    expect(() => compile(dup, tags, defaultSyntax())).toThrow(
      /already declared/,
    );
    expect(() => compile(dup, tags, declares)).not.toThrow();
    const bad = {
      node: { declares: { kind: "" } },
    } as unknown as Record<string, CustomTag>;
    expect(() => compile("<node/>", bad, declares)).not.toThrow();
  });

  it("core keeps the whole-value shape check, quoting claimed `values` as it always did", () => {
    const tags: Record<string, CustomTag> = {
      box: { attributes: { mode: { type: "atom", values: ["b", "a"] } } },
    };
    const claimed = claiming({ attribute: ["values", "pattern", "ref"] });
    for (const syntax of [defaultSyntax(), claimed]) {
      expect(
        caught(() => compile("<box mode='s'/>", tags, syntax)).message,
      ).toBe(
        "`<box>`: attribute `mode` must be atom, got string (one of :a, :b)",
      );
    }
  });
});

describe("`checkContract`", () => {
  const tags: Record<string, CustomTag> = {
    plain: { attributes: { a: { type: "string" } } },
    used: { attributes: { a: { type: "atom", facet: 1 } as never } },
    deep: {
      attributeTags: {
        "*": [
          {
            pattern: "r.*",
            attributes: { b: { facet: 2 } as never },
          },
        ],
      },
    },
    tagged: { relations: "many" } as CustomTag,
  };

  it("runs at registration for each contract that uses a claimed key, at any depth, called or not", () => {
    const seen: unknown[] = [];
    compile("<div/>", tags, {
      table: {},
      contractFields: { attribute: ["facet"], tag: ["relations"] },
      checkContract: (tag, contract) => {
        seen.push([tag, Object.keys(contract).sort()]);
      },
    });
    expect(seen).toEqual([
      ["used", ["attributes"]],
      ["deep", ["attributeTags"]],
      ["tagged", ["relations"]],
    ]);
  });

  it("hands over `children` as plain data", () => {
    const children = {
      "*": { pattern: "x-.*", attributes: { c: { facet: 3 } } },
    };
    let seen: unknown;
    compile(
      "<div/>",
      { box: { children } as unknown as CustomTag },
      {
        table: {},
        contractFields: { attribute: ["facet"] },
        checkContract: (_, contract) => {
          seen = contract.children;
        },
      },
    );
    expect(seen).toBe(children);
  });

  it("`ctx.fail` is a registration error carrying `code`; a throw is named", () => {
    const failing = (check: SyntaxModule["checkContract"]) =>
      caught(() =>
        compile("<div/>", tags, {
          table: {},
          contractFields: { attribute: ["facet"] },
          checkContract: check,
        }),
      );
    const error = failing((tag, _, ctx) =>
      ctx.fail(`\`${tag}\` is wrong`, { code: "MESH_FACET" }),
    );
    expect(error.message).toBe("`used` is wrong");
    expect([error.line, error.column, error.file]).toEqual([0, 0, undefined]);
    expect(error.diagnosticCode).toBe("MESH_FACET");
    expect(
      failing(() => {
        throw new Error("boom");
      }).message,
    ).toBe('the syntax module\'s `checkContract` threw on tag "used": boom');
  });

  it("must be a function", () => {
    expect(
      caught(() =>
        compile(
          "<div/>",
          {},
          {
            table: {},
            checkContract: 1 as never,
          },
        ),
      ).message,
    ).toContain("`syntax.checkContract` must be a function");
  });
});

describe("`contractFields` through a manifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-contract-fields-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function project(
    mx: Record<string, unknown>,
    files: Record<string, string>,
    root = dir,
  ) {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "x", mx }, null, 2),
    );
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return join(root, "page.mx");
  }

  /** Scans and compiles `page` as a host does, the syntax from its manifest. */
  function build(page: string, source: string) {
    const { customTags } = scanCustomTags(page, { targets, stopAt: dir });
    return compileSource(source, page, host, {
      targets,
      customTags,
      tagDiscoveryDirs: [],
      warnings: [],
      emitIr: () => "",
    });
  }

  const SYNTAX = `export { default } from ${JSON.stringify(MESH_MODULE)};\n`;
  const CONTRACTS = `export default {
  node: { attributes: { id: {} }, declares: { kind: "node", from: "id" } },
  link: { attributes: { to: { type: "atom", ref: "node" } } },
};\n`;

  it("`mx.contracts` refuses `declares` without a module that claims it", () => {
    const page = project(
      { contracts: "./contracts.ts" },
      {
        "contracts.ts": CONTRACTS,
      },
    );
    expect(() => build(page, "<node#a/>")).toThrow(
      "`<node>`: `declares` is not allowed in `mx.contracts`",
    );
  });

  it("`mx.syntax` claims it: `mx.contracts` carries `declares` to the module", () => {
    const page = project(
      { syntax: "./syntax.ts", contracts: "./contracts.ts" },
      { "syntax.ts": SYNTAX, "contracts.ts": CONTRACTS },
    );
    expect(() => build(page, "<node#a/><link to=:a/>")).not.toThrow();
    expect(caught(() => build(page, "<node#a/><link to=:b/>")).message).toBe(
      "`<link>`: attribute `to`: `:b` is not a declared node here (one of :a)",
    );
  });

  it("a sidecar's claimed keys reach the module", () => {
    const page = project(
      { syntax: "./syntax.ts" },
      {
        "syntax.ts": SYNTAX,
        "tags/node.tag.ts": `export default { attributes: { id: {} }, declares: { kind: "node", from: "id" } };\n`,
        "tags/link.tag.ts": `export default { attributes: { to: { type: "atom", ref: "node" } } };\n`,
      },
    );
    expect(
      caught(() => build(page, "<node#alpha/><link to=:alpah/>")).message,
    ).toBe(
      "`<link>`: attribute `to`: `:alpah` is not a declared node here (one of :alpha); did you mean `:alpha`?",
    );
  });

  /**
   * The registration error of `files` on a page that calls none of its
   * tags: built-in (no `mx.syntax`) and through the module, each project
   * in its own directory. `file` is relative to the project.
   */
  function placed(files: Record<string, string>, mx = {}) {
    return ["builtin", "module"].map((name) => {
      const root = join(dir, name);
      const page = project(
        name === "module" ? { ...mx, syntax: "./syntax.ts" } : mx,
        name === "module" ? { ...files, "syntax.ts": SYNTAX } : files,
        root,
      );
      const error = caught(() => build(page, "<div/>"));
      return {
        message: error.message,
        line: error.line,
        column: error.column,
        file: error.file?.slice(root.length + 1),
      };
    });
  }

  it.each([
    ["values", `{ attributes: { a: { type: "string", values: ["a"] } } }`],
    ["pattern", `{ attributes: { a: { type: "atom", pattern: "(" } } }`],
    ["declares", `{ declares: { kind: "k", from: "nope" } }`],
  ])(
    "a sidecar's malformed `%s` points at the sidecar, called or not",
    (_, body) => {
      const [builtIn, module] = placed({
        "tags/box.tag.ts": `export default ${body};\n`,
      });
      expect(builtIn).toMatchObject({
        file: "tags/box.tag.ts",
        line: 1,
        column: 0,
      });
      expect(module).toEqual(builtIn);
    },
  );

  it("an `mx.contracts` module's malformed claimed key points at the module file, 1:0", () => {
    const [builtIn, module] = placed(
      {
        "contracts.ts": `export default { box: { attributes: { a: { type: "string", values: ["a"] } } } };\n`,
      },
      { contracts: "./contracts.ts" },
    );
    expect(builtIn).toEqual({
      message:
        'Invalid "a" attribute declaration of tag "box": `values` requires `type: "atom"`',
      line: 1,
      column: 0,
      file: "contracts.ts",
    });
    expect(module).toEqual(builtIn);
  });

  it("an `mx.contracts` module's malformed `declares` (claimed) points at the module file", () => {
    const page = project(
      { syntax: "./syntax.ts", contracts: "./contracts.ts" },
      {
        "syntax.ts": SYNTAX,
        "contracts.ts": `export default { box: { declares: { kind: "k", from: "nope" } } };\n`,
      },
    );
    const error = caught(() => build(page, "<div/>"));
    expect(error.message).toBe(
      'Invalid `declares` of tag "box": `from` must be "id" or "name"',
    );
    expect([error.file, error.line, error.column]).toEqual([
      join(dir, "contracts.ts"),
      1,
      0,
    ]);
  });
});
