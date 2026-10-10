/**
 * A dialect's `afterLower(unit)` sees a public view of the unit
 * (`LoweredUnit`), and `contractFields` hands contract keys to the dialect.
 * The dialects here are test fixtures.
 *
 * - The view: calls, attributes in every kind, attribute tags at any depth,
 *   ancestors and their scope identity, `declared`, frozen.
 * - `fail` and `warn`.
 * - `contractFields`: shape, registration acceptance and refusal, takeover
 *   (core stops checking a claimed key), through the `dialect` option, a
 *   dialect package that claims the file's extension, `mx.contracts` and a
 *   sidecar.
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
import declaresFixture from "./fixtures/syntax/declares-fixture.ts";
import memberFixture from "./fixtures/syntax/member-fixture.ts";
import type { ContractAttr, LoweredUnit } from "./lowered-unit.ts";
import { scanCustomTags } from "./scan.ts";
import {
  type Dialect,
  defaultSyntax,
  resolveSyntaxOf,
} from "./syntax-table.ts";
import { dialectProject, reexport } from "./test-dialect-project.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const FILE = "/tmp/mx-lowered-unit/page.mx";
const DECLARES_MODULE = join(
  import.meta.dirname,
  "fixtures/syntax/declares-fixture.ts",
);

/** A dialect with no rows and no hooks: the hooks a test sets are its own. */
const noHooks: Dialect = { id: "test", name: "MX", table: {} };

const host: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => true,
  resolveDefaultTag: () => "setter",
  attrTags: 2,
};

type Syntax = Dialect | ReturnType<typeof defaultSyntax>;

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
    dialect: syntax,
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
      any: { type: "atom" },
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
  // Review 466 B1: a plain string against a `ref` atom, alone, after a
  // module error, and with no declarations; a bare atom and a `values` atom.
  '<link to="red"/>',
  `${nodes(["a"])}<link to=:zz/><link to="red"/>`,
  `${nodes(["a"])}<link to="red"/><link to=:zz/>`,
  '<box any="red"/>',
  '<box mode="red"/>',
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
    "unknown key beside the claimed ones",
    { box: { attributes: { a: { type: "atom", bogus: 1 } } } },
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

/** The unit a module's `afterLower` was handed (`fields` claimed). */
function unitOf(
  source: string,
  customTags: Record<string, CustomTag>,
  fields: Dialect["contractFields"] = { tag: ["relations"] },
): LoweredUnit {
  let seen: LoweredUnit | undefined;
  compile(source, customTags, {
    ...memberFixture,
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
        "spread" in attr ? "...spread" : attr.name,
        attr,
      ]),
    ) as Record<string, ContractAttr>;
    // Each attribute is its name plus its value node, read by `type`.
    expect(kinds.name).toEqual({
      name: "name",
      nameSpan: { sourceStart: 6, sourceEnd: 12 },
      authored: ":named",
      label: "`:named` (`name`)",
      value: {
        type: "mx:Atom",
        name: "named",
        span: { sourceStart: 6, sourceEnd: 12 },
      },
    });
    expect(kinds.s).toEqual({
      name: "s",
      nameSpan: { sourceStart: 13, sourceEnd: 14 },
      label: "`s`",
      value: {
        type: "mx:String",
        value: "str",
        span: { sourceStart: 15, sourceEnd: 20 },
      },
    });
    expect(kinds.a).toMatchObject({ value: { type: "mx:Atom", name: "at" } });
    expect(kinds.e).toMatchObject({
      value: { type: "mx:Expression", code: 'x + "y"' },
    });
    const marked = (
      kinds.e as { value: { node: { right: { extra: unknown } } } }
    ).value.node.right.extra;
    expect(marked).toMatchObject({ mxAtom: { span: { sourceStart: 34 } } });
    expect(kinds.b).toEqual({
      name: "b",
      nameSpan: { sourceStart: 38, sourceEnd: 39 },
      label: "`b`",
      value: null,
    });
    expect(kinds.v).toMatchObject({
      value: { type: "mx:Expression", code: "w", bound: true },
    });
    expect(kinds["...spread"]).toEqual({
      spread: true,
      span: { sourceStart: 48, sourceEnd: 52 },
    });
    // Every attribute and value node is frozen.
    for (const attr of Object.values(kinds)) {
      expect(Object.isFrozen(attr)).toBe(true);
      if ("value" in attr && attr.value) {
        expect(Object.isFrozen(attr.value)).toBe(true);
      }
    }
    // A whole-value member a module built.
    expect(unit.calls[1]?.attrs).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ type: "mx:Member", name: "due" }),
      }),
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
    // A deep-frozen copy: the registered object stays the caller's.
    expect(row?.contract?.attributes).toEqual(declared?.attributes);
    expect(row?.contract?.attributes).not.toBe(declared?.attributes);
    expect(row?.attrs[0]).toMatchObject({
      value: { type: "mx:Atom", name: "a" },
    });
    const [cell] = row?.attributeTags ?? [];
    expect(cell?.name).toBe("cell");
    expect(cell?.contract?.attributes).toEqual({
      k: { type: "atom", values: ["x", "y"] },
    });
    expect(cell?.attrs[0]).toMatchObject({
      value: { type: "mx:Atom", name: "x" },
    });
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
        ...noHooks,
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
        { ...noHooks, afterLower: run },
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
      "the dialect's `afterLower`: `unit.fail`'s `at` is a `{ sourceStart, sourceEnd }` span inside the document (0 to 9)",
    );
    expect(
      failing((unit) =>
        unit.fail("x", { also: [{ sourceStart: 0, sourceEnd: 1 }, at] }),
      ).message,
    ).toBe(
      "the dialect's `afterLower`: each of `unit.fail`'s `also` is a `{ sourceStart, sourceEnd }` span inside the document (0 to 9)",
    );
  });

  it("refuses an empty message", () => {
    expect(failing((unit) => unit.fail("")).message).toBe(
      "the dialect's `afterLower`: `unit.fail` takes a non-empty message",
    );
  });

  it("`warn` records a positioned or file-level warning", () => {
    const warnings: MxWarning[] = [];
    compile(
      "<x/>\n<y/>",
      {},
      {
        ...noHooks,
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

/** Every subset of the four atom keys, as `contractFields`. */
const CLAIMS = Array.from({ length: 16 }, (_, bits) => {
  const attribute = ["values", "pattern", "ref"].filter(
    (_, i) => bits & (1 << i),
  );
  const tag = bits & 8 ? ["declares"] : [];
  return { attribute, tag };
});

describe("review 466 r1: core keeps its checks beside a module's claims", () => {
  const claimOnly = (fields = CLAIMS[15]): Dialect => ({
    id: "test",
    name: "MX",
    table: {},
    contractFields: fields,
  });

  it("B1: a plain string against a claimed `ref` is still core's shape error, behind the module's hook", () => {
    const source = '<link to="red"/>';
    const builtIn = caught(() => compile(source, vocab, defaultSyntax()));
    expect(builtIn.message).toBe(
      "`<link>`: attribute `to` must be atom, got string (none declared); write it as `:red`",
    );
    // A module that claims the keys and checks nothing: core's error.
    const plain = caught(() => compile(source, vocab, claimOnly()));
    expect(plain.message).toBe(
      "`<link>`: attribute `to` must be atom, got string",
    );
    expect([plain.line, plain.column]).toEqual([builtIn.line, builtIn.column]);
  });

  it("B1: a module error earlier in the file keeps its place", () => {
    const source = '<node#a/><link to=:zz/><link to="red"/>';
    expect(
      caught(() => compile(source, vocab, declaresFixture)).message,
    ).toMatch(/`:zz` is not a declared node here/);
  });

  it("completion facts are core's built-in path only: a dialect that claims the atom fields leaves `atomFacts` empty, and unset on an error", () => {
    const source = "<node#a/><link to=:a/>";
    const facts = (syntax: Syntax) =>
      (compile(source, vocab, syntax).atomFacts as unknown as { calls: [] })
        .calls.length;
    expect(facts(defaultSyntax())).toBe(2);
    expect(facts(claimOnly())).toBe(0);
    const failing = "<node#a/><link to=:b/>";
    expect(
      caught(() => compile(failing, vocab, defaultSyntax())).atomFacts,
    ).toBeDefined();
    expect(
      caught(() => compile(failing, vocab, declaresFixture)).atomFacts,
    ).toBeUndefined();
  });

  it.each(CLAIMS)(
    "L3: valid input passes under the partial claim %o",
    (fields) => {
      for (const source of [...PASSING, "<node#a/><link to=:a/>"]) {
        expect(outcome(source, vocab, claimOnly(fields))).toEqual({
          ok: true,
          warnings: [],
        });
      }
    },
  );

  it("L4: the view's contracts are deep-frozen copies; the registered contract is untouched", () => {
    const tags: Record<string, CustomTag> = {
      box: { attributes: { b: { type: "atom", values: ["x"] } } },
    };
    const errors: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      compile("<box b=:x/>", tags, {
        ...noHooks,
        afterLower: (unit) => {
          const values = unit.calls[0]?.contract.attributes?.b
            ?.values as string[];
          try {
            values.push("y");
          } catch (error) {
            errors.push(error);
          }
        },
      });
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(tags.box?.attributes?.b?.values).toEqual(["x"]);
    expect(Object.isFrozen(tags.box?.attributes?.b)).toBe(false);
  });
});

describe("`contractFields`", () => {
  const claiming = (
    fields: Dialect["contractFields"],
    afterLower?: Dialect["afterLower"],
  ): Dialect => ({
    id: "test",
    name: "MX",
    table: {},
    contractFields: fields,
    ...(afterLower ? { afterLower } : {}),
  });

  it.each([
    [[], "`dialect.contractFields` must be an object"],
    [
      { attr: [] },
      "`dialect.contractFields.attr` is not a contract field list",
    ],
    [
      { tag: [""] },
      "`dialect.contractFields.tag` must be an array of non-empty",
    ],
    [
      { attribute: "values" },
      "`dialect.contractFields.attribute` must be an array",
    ],
    [{ attribute: ["type"] }, "cannot claim `type`: core checks it"],
    [{ tag: ["children"] }, "cannot claim `children`: core checks it"],
  ])("refuses the shape %o", (fields, message) => {
    const error = caught(() =>
      compile("<x/>", {}, claiming(fields as Dialect["contractFields"])),
    );
    expect(error.message).toContain(
      "the `dialect` option is not a valid dialect: ",
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

  it("core keeps the whole-value shape check, and reads no claimed key to word it", () => {
    const tags: Record<string, CustomTag> = {
      box: { attributes: { mode: { type: "atom", values: ["b", "a"] } } },
    };
    const builtIn =
      "`<box>`: attribute `mode` must be atom, got string (one of :a, :b)";
    expect(
      caught(() => compile("<box mode='s'/>", tags, defaultSyntax())).message,
    ).toBe(builtIn);
    // A module that claims `values` and words nothing: core names only what
    // it knows.
    const claimed = claiming({ attribute: ["values", "pattern", "ref"] });
    expect(
      caught(() => compile("<box mode='s'/>", tags, claimed)).message,
    ).toBe("`<box>`: attribute `mode` must be atom, got string");
    // The module words it (`describeAttribute`), from a frozen copy.
    const seen: unknown[] = [];
    const describing: Dialect = {
      ...claimed,
      describeAttribute: (declaration) => {
        seen.push(Object.isFrozen(declaration), declaration.values);
        return " (as the module says)";
      },
    };
    expect(
      caught(() => compile("<box mode='s'/>", tags, describing)).message,
    ).toBe(
      "`<box>`: attribute `mode` must be atom, got string (as the module says)",
    );
    expect(seen).toEqual([true, ["b", "a"]]);
    // An unclaimed `values` is still core's to quote.
    expect(
      caught(() =>
        compile("<box mode=1/>", tags, claiming({ attribute: ["ref"] })),
      ).message,
    ).toBe(
      "`<box>`: attribute `mode` must be atom, got number (one of :a, :b)",
    );
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
      id: "test",
      name: "MX",
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
        id: "test",
        name: "MX",
        table: {},
        contractFields: { attribute: ["facet"] },
        checkContract: (_, contract) => {
          seen = contract.children;
        },
      },
    );
    expect(seen).toEqual(children);
    expect(Object.isFrozen((seen as typeof children)["*"].attributes.c)).toBe(
      true,
    );
    expect(Object.isFrozen(children["*"].attributes.c)).toBe(false);
  });

  it("`ctx.fail` is a registration error carrying `code`; a throw is named", () => {
    const failing = (check: Dialect["checkContract"]) =>
      caught(() =>
        compile("<div/>", tags, {
          id: "test",
          name: "MX",
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
    ).toBe('the dialect\'s `checkContract` threw on tag "used": boom');
  });

  it("must be a function", () => {
    expect(
      caught(() =>
        compile(
          "<div/>",
          {},
          {
            id: "test",
            name: "MX",
            table: {},
            checkContract: 1 as never,
          },
        ),
      ).message,
    ).toContain("`dialect.checkContract` must be a function");
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

  /**
   * A project in `root` holding `files`. With `dialect`, it depends on a
   * dialect package claiming `.fixture.mx`, whose module re-exports the
   * declares fixture (`true`) or is the given source, and the page is a `.fixture.mx` file;
   * without, the page is a `.mx` file.
   */
  function project(
    mx: Record<string, unknown>,
    files: Record<string, string>,
    root = dir,
    dialect?: true | string,
  ) {
    mkdirSync(root, { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    if (dialect === undefined) {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "x", mx }, null, 2),
      );
      return join(root, "page.mx");
    }
    dialectProject(root, {
      packageName: "fixture-dialect",
      manifest: {
        id: "fixture",
        name: "Fixture",
        extensions: [".fixture.mx"],
        ...(dialect === true ? { module: "./index.cjs" } : {}),
      },
      module: dialect === true ? reexport(DECLARES_MODULE) : dialect,
      mx,
    });
    return join(root, "page.fixture.mx");
  }

  /** The module file of a dialect `project` wrote from source. */
  const dialectModule = (root = dir) =>
    join(root, "node_modules", "fixture-dialect", "index.mjs");

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

  it("the file's dialect claims it: `mx.contracts` carries `declares` to the dialect", () => {
    const page = project(
      { contracts: "./contracts.ts" },
      { "contracts.ts": CONTRACTS },
      dir,
      true,
    );
    expect(() => build(page, "<node#a/><link to=:a/>")).not.toThrow();
    expect(caught(() => build(page, "<node#a/><link to=:b/>")).message).toBe(
      "`<link>`: attribute `to`: `:b` is not a declared node here (one of :a)",
    );
  });

  it("a sidecar's claimed keys reach the dialect", () => {
    const page = project(
      {},
      {
        "tags/node.tag.ts": `export default { attributes: { id: {} }, declares: { kind: "node", from: "id" } };\n`,
        "tags/link.tag.ts": `export default { attributes: { to: { type: "atom", ref: "node" } } };\n`,
      },
      dir,
      true,
    );
    expect(
      caught(() => build(page, "<node#alpha/><link to=:alpah/>")).message,
    ).toBe(
      "`<link>`: attribute `to`: `:alpah` is not a declared node here (one of :alpha)",
    );
  });

  it.each([
    ["throws on load", "throw new Error('broken syntax');\n"],
    ["has no `table`", "export default { lowerTrigger() {} };\n"],
  ])(
    "L2: a dialect that %s is the error, not a contract key it might claim",
    (_, body) => {
      const page = project(
        { contracts: "./contracts.ts" },
        {
          "contracts.ts": CONTRACTS,
          "tags/box.tag.ts": `export default { attributes: { a: { type: "string", values: ["a"] } } };\n`,
        },
        dir,
        body,
      );
      const expected = caught(() => resolveSyntaxOf(page));
      expect(expected.file).toBe(dialectModule());
      for (const run of [
        () => build(page, "<div/>"),
        () => scanCustomTags(page, { targets, stopAt: dir }),
      ]) {
        const error = caught(run);
        expect([error.message, error.file, error.line, error.column]).toEqual([
          expected.message,
          expected.file,
          expected.line,
          expected.column,
        ]);
      }
    },
  );
});
