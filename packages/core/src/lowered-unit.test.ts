/**
 * A dialect's `afterLower(unit)` sees a public view of the unit
 * (`LoweredUnit`), and `contractFields` hands contract keys to the dialect.
 * The dialects here are test fixtures.
 *
 * - The view: calls, attributes in every kind, attribute tags at any depth,
 *   ancestors and their scope identity, `declared`, frozen.
 * - `fail` and `warn`.
 * - `contractFields`: shape, registration acceptance and refusal, through the `dialect` option, a
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
import atomFixture from "./fixtures/syntax/atom-fixture.ts";
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

/**
 * Contracts that use the keys a module claims (`values`, `pattern`, `ref`,
 * `declares`). Core knows none of them, so the literal is typed loosely: the
 * module that claims them gives them their meaning.
 */
const vocab = {
  box: {
    attributes: {
      any: { type: "atom" },
      mode: { type: "atom", values: ["strict", "loose"] },
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
} as unknown as Record<string, CustomTag>;

/** The keys the atom fixture claims, and a tag key a test claims on top. */
const ATOM_FIELDS = atomFixture.contractFields as {
  attribute: string[];
  tag: string[];
};

/**
 * The unit a module's `afterLower` was handed: `base`'s syntax (the atom
 * fixture's `~`, or the member fixture's `&`), claiming `fields`.
 */
function unitOf(
  source: string,
  customTags: Record<string, CustomTag>,
  fields: Dialect["contractFields"] = {
    attribute: ATOM_FIELDS.attribute,
    tag: [...ATOM_FIELDS.tag, "relations"],
  },
  base: Dialect = atomFixture,
): LoweredUnit {
  let seen: LoweredUnit | undefined;
  compile(source, customTags, {
    ...base,
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
    const source = "<open ~named s='str' a=~at e=(x + ~y) b v:=w ...rest/>";
    const unit = unitOf(source, tags);
    expect(unit.file).toBe(FILE);
    expect(unit.source).toBe(source);
    const [call] = unit.calls;
    expect(call?.tag).toBe("open");
    expect(call?.nameSpan).toEqual({ sourceStart: 1, sourceEnd: 5 });
    expect(call?.span).toEqual({
      sourceStart: 0,
      sourceEnd: source.length,
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
      label: "`name`",
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
  });

  it("hands a whole-value member a module built as `mx:Member`", () => {
    const unit = unitOf(
      "<open &due/>",
      { open: tags.open as CustomTag },
      { tag: ["relations"] },
      memberFixture,
    );
    expect(unit.calls[0]?.attrs).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ type: "mx:Member", name: "due" }),
      }),
    ]);
  });

  it("gives attribute tags at any depth, each with the declaration it matched", () => {
    const unit = unitOf(
      "<box><@row mode=~a><@cell k=~x/></@row><@col-1 to=~n/></box><node#n/>",
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
        ...atomFixture,
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

describe("core keeps its checks beside a module's claims", () => {
  const claimOnly: Dialect = {
    id: "test",
    name: "MX",
    table: {},
    contractFields: ATOM_FIELDS,
  };

  it("a plain string against a claimed-key atom declaration is core's shape error, behind the module's hook", () => {
    const source = '<link to="red"/>';
    const plain = caught(() => compile(source, vocab, claimOnly));
    expect(plain.message).toBe(
      "`<link>`: attribute `to` must be atom, got string",
    );
    expect([plain.line, plain.column]).toEqual([1, 9]);
    // The atom fixture words it from `describeAttribute`.
    const worded = caught(() =>
      compile('<box mode="red"/>', vocab, atomFixture),
    );
    expect(worded.message).toBe(
      "`<box>`: attribute `mode` must be atom, got string (one of ~strict, ~loose)",
    );
  });

  it("a module error earlier in the file keeps its place", () => {
    const source = '<node#a/><link to=:zz/><link to="red"/>';
    expect(
      caught(() =>
        compile(
          source,
          {
            node: vocab.node as CustomTag,
            link: vocab.link as CustomTag,
          },
          declaresFixture,
        ),
      ).message,
    ).toMatch(/`:zz` is not a declared node here/);
  });

  it("L4: the view's contracts are deep-frozen copies; the registered contract is untouched", () => {
    const tags: Record<string, CustomTag> = {
      box: { attributes: { b: { type: "atom", values: ["x"] } as never } },
    };
    const errors: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      compile("<box b=~x/>", tags, {
        ...atomFixture,
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
    const registered = tags.box?.attributes?.b as { values?: string[] };
    expect(registered.values).toEqual(["x"]);
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
      'Unknown key "facet" in the "a" attribute declaration of tag "box"; allowed: type, items, required, enum, default, literalOnly',
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

  it("core keeps the whole-value shape check, and the module words it", () => {
    const tags: Record<string, CustomTag> = {
      box: {
        attributes: { mode: { type: "atom", values: ["b", "a"] } as never },
      },
    };
    const claimed = claiming({ attribute: ["values", "pattern", "ref"] });
    // A module that claims `values` and words nothing: core names only what
    // it knows.
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
