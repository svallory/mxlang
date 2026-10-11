/**
 * A syntax module builds atoms; core has no atom syntax and checks no atom
 * key. These pin what core still does with the whole-value atom a module
 * built, through the atom fixture dialect
 * (`../fixtures/syntax/atom-fixture.ts`, sigil `~`), loaded two ways: a
 * dialect package naming it in `mx.dialect.module`, and the `dialect` option.
 *
 * 1. A module-built atom reaches the IR and the `LoweredUnit` as `mx:Atom`.
 * 2. The `type: "atom"` shape check accepts it and refuses a value that is
 *    not one, in one diagnostic.
 * 3. `ctx.declare` still works for a module.
 * 4. `values`, `pattern`, `ref` and `declares` are the module's to claim: a
 *    contract that uses one without a claiming module is the unknown-key
 *    error; under the fixture the fixture's check runs and core runs none.
 * 5. `ContractAtomOrMember` types the attribute view a module receives.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSource } from "../compile.ts";
import type { CustomTag } from "../custom-tags.ts";
import type { HostDeclarations } from "../declarations.ts";
import type { Attr } from "../ir.ts";
import type {
  ContractAtomOrMember,
  ContractAttr,
  ContractValue,
  LoweredUnit,
} from "../lowered-unit.ts";
import { scanCustomTags } from "../scan.ts";
import type { Dialect } from "../syntax-table.ts";
import { testTargetLookup } from "../test-targets.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";
import { dialectPackage } from "./test-dialect-package.ts";

const MODULE = join(import.meta.dirname, "../fixtures/syntax/atom-fixture.ts");

/** Loaded the way a dialect package's module loads (Node's strip-only `require`). */
const atomSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: Dialect }
).default;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-atom-")));
  dialectPackage(dir, MODULE, {
    id: "atom",
    name: "Fixture",
    extensions: [".atom.mx"],
  });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The two ways a consumer loads the module. */
const LOADERS: [string, () => [string, LowerSourceOptions]][] = [
  ["a dialect package", () => [join(dir, "entity.atom.mx"), {}]],
  ["the `dialect` option", () => ["/v/entity.mx", { dialect: atomSyntax }]],
];

const tags = (customTags: Record<string, unknown>) =>
  customTags as Record<string, CustomTag>;

/** The tag-call shape every pin uses: `pick`'s one attribute, `mode`, is an atom slot. */
const PICK = tags({
  pick: {
    attributes: {
      mode: { type: "atom", values: ["on", "off"] },
      n: {},
      name: { type: "atom" },
    },
  },
});

function messages(
  source: string,
  customTags: Record<string, CustomTag>,
  options: LowerSourceOptions = { dialect: atomSyntax },
): string[] {
  return lowerSource(source, "/v/entity.mx", {
    ...options,
    customTags,
  }).diagnostics.map((each) => each.message);
}

describe.each(LOADERS)("a module-built atom in the IR, via %s", (_, load) => {
  const lower = (source: string) => {
    const [file, options] = load();
    const result = lowerSource(source, file, options);
    expect(result.diagnostics).toEqual([]);
    return result.ir?.body[0] as unknown as {
      tag?: { attrs: Attr[] };
      attrs?: Attr[];
    };
  };
  const attrsOf = (source: string): Attr[] => {
    const node = lower(source);
    return node.tag?.attrs ?? node.attrs ?? [];
  };

  it("a whole `=value` is a static attribute carrying the atom mark", () => {
    const [mode] = attrsOf("<div mode=~on/>\n");
    expect(mode).toMatchObject({
      kind: "static",
      name: "mode",
      value: "on",
      atom: { name: "on", span: { sourceStart: 10, sourceEnd: 13 } },
    });
  });

  it("an attribute-list `~name` is the static `name` attribute, the atom unchanged", () => {
    const [name] = attrsOf("thing ~title\n");
    expect(name).toMatchObject({
      kind: "static",
      name: "name",
      value: "title",
      atom: { name: "title" },
    });
  });

  it("an atom inside an expression is a literal marked `extra.mxAtom`", () => {
    const [value] = attrsOf("<div v=(a + ~b)/>\n");
    if (value?.kind !== "dynamic") throw new Error(String(value?.kind));
    expect(value.value.code).toBe('a + "b"');
    expect(value.value.node).toMatchObject({
      type: "BinaryExpression",
      right: {
        type: "StringLiteral",
        value: "b",
        extra: {
          mxAtom: { name: "b", span: { sourceStart: 12, sourceEnd: 14 } },
        },
      },
    });
  });
});

describe("the `LoweredUnit` view of a module-built atom", () => {
  const host: HostDeclarations = {
    tags: {},
    isElement: () => true,
    isComponent: () => false,
    isDelegatedTag: () => true,
    resolveDefaultTag: () => "setter",
    attrTags: 2,
  };

  /** The unit the fixture's own `afterLower` was handed, besides its check. */
  function unitOf(source: string, customTags: Record<string, CustomTag>) {
    let seen: LoweredUnit | undefined;
    compileSource(source, "/v/page.mx", host, {
      targets: testTargetLookup(),
      customTags,
      tagDiscoveryDirs: [],
      dialect: {
        ...atomSyntax,
        afterLower: (unit) => {
          seen = unit;
        },
      },
      emitIr: () => "",
    });
    if (!seen) throw new Error("afterLower did not run");
    return seen;
  }

  const attrOf = (attrs: readonly ContractAttr[] | undefined, name: string) => {
    const found = attrs?.find(
      (each) => !("spread" in each) && each.name === name,
    );
    if (!found || "spread" in found) throw new Error(`no attribute ${name}`);
    return found;
  };

  it("each form is an `mx:Atom` value with its name and span, frozen", () => {
    const source = "<pick mode=~on n=(x + ~y)/>\n<pick ~named/>";
    const unit = unitOf(source, PICK);
    const [first, second] = unit.calls;
    const mode = attrOf(first?.attrs, "mode");
    expect(mode.value).toEqual({
      type: "mx:Atom",
      name: "on",
      span: { sourceStart: 11, sourceEnd: 14 },
    });
    expect(Object.isFrozen(mode)).toBe(true);
    expect(Object.isFrozen(mode.value)).toBe(true);
    // Inside an expression the atom is a marked literal in the expression's node.
    const n = attrOf(first?.attrs, "n");
    expect(n.value).toMatchObject({ type: "mx:Expression", code: 'x + "y"' });
    const marked = (n.value as { node: { right: { extra: unknown } } }).node
      .right.extra;
    expect(marked).toMatchObject({ mxAtom: { span: { sourceStart: 22 } } });
    // The attribute-list form is the static `name` attribute.
    expect(attrOf(second?.attrs, "name")).toEqual({
      name: "name",
      nameSpan: { sourceStart: 34, sourceEnd: 40 },
      label: "`name`",
      value: expect.objectContaining({ type: "mx:Atom", name: "named" }),
    });
  });

  it("`ContractAtomOrMember` types what the view hands a module", () => {
    const unit = unitOf("<pick mode=~on/>", PICK);
    const value: ContractValue | null | undefined = attrOf(
      unit.calls[0]?.attrs,
      "mode",
    ).value;
    // A type-level pin: the atom/member view is one arm of `ContractValue`, and
    // a module narrows to it by `type`, then casts (`type` does not narrow a
    // dialect's node).
    const atom: ContractAtomOrMember = {
      type: "mx:Atom",
      name: "on",
      span: { sourceStart: 0, sourceEnd: 3 },
    };
    const member: ContractAtomOrMember = { type: "mx:Member", name: "x" };
    const asValue: ContractValue[] = [atom, member];
    expect(asValue).toHaveLength(2);
    expect(value?.type).toBe("mx:Atom");
    const read = value as ContractAtomOrMember;
    const name: string = read.name;
    const kind: "mx:Atom" | "mx:Member" = read.type;
    expect([name, kind]).toEqual(["on", "mx:Atom"]);
  });
});

describe('the `type: "atom"` shape check on a module-built atom', () => {
  const MODE = tags({
    pick: { attributes: { mode: { type: "atom" }, other: {} } },
  });

  it.each([
    ["a whole-value atom", "<pick mode=~on/>"],
    ["an attribute-list atom", "pick ~on\n"],
    ["an array of atoms", "<pick mode=[~a, ~b]/>"],
  ])("accepts %s", (_, source) => {
    const tagsFor = source.startsWith("pick")
      ? tags({ pick: { attributes: { name: { type: "atom" } } } })
      : MODE;
    expect(messages(source, tagsFor)).toEqual([]);
  });

  it.each([
    ["a string", '<pick mode="on"/>', "got string"],
    ["a number", "<pick mode=1/>", "got number"],
    ["a function", "<pick mode=(() => 1)/>", "got function"],
  ])("refuses %s, naming the value, in core's words", (_, source, got) => {
    const expected = `\`<pick>\`: attribute \`mode\` must be atom, ${got}`;
    expect(messages(source, MODE)).toEqual([expected]);
    // The same diagnostic from a dialect with no atom row: the check is core's.
    expect(
      messages(source, MODE, {
        dialect: { id: "plain", name: "Fixture", table: {} },
      }),
    ).toEqual([expected]);
  });
});

describe("where core's `type` check reports, and what it names", () => {
  const at = (source: string, customTags: Record<string, CustomTag>) =>
    lowerSource(source, "/v/entity.mx", {
      dialect: atomSyntax,
      customTags,
    }).diagnostics.map((each) => `${each.line}:${each.column} ${each.message}`);
  const SLOTS = tags({
    pick: {
      attributes: {
        mode: { type: "atom" },
        s: { type: "string" },
        n: { type: "number" },
      },
      attributeTags: { row: { attributes: { mode: { type: "atom" } } } },
    },
  });

  it.each([
    ["<pick s=~on/>", "1:8 `<pick>`: attribute `s` must be string, got atom"],
    ["<pick n=~on/>", "1:8 `<pick>`: attribute `n` must be number, got atom"],
    ["<pick s=(~on)/>", "1:9 `<pick>`: attribute `s` must be string, got atom"],
    [
      "<pick mode=[~a, 2]/>",
      "1:16 `<pick>`: attribute `mode` must be atom, got number",
    ],
    [
      '<pick mode="on"/>',
      "1:11 `<pick>`: attribute `mode` must be atom, got string",
    ],
    [
      "<pick mode=1/>",
      "1:11 `<pick>`: attribute `mode` must be atom, got number",
    ],
    [
      '<pick><@row mode="x"/></pick>',
      "1:17 `<pick>`: `<@row>`: attribute `mode` must be atom, got string",
    ],
  ])("%s is refused once, at the value: %s", (source, expected) => {
    expect(at(source, SLOTS)).toEqual([expected]);
  });
});

describe("`ctx.declare` for a module", () => {
  it("an `analyze` hook's declaration reaches the unit a module's `afterLower` reads", () => {
    const seen: unknown[] = [];
    const analyzed: Record<string, CustomTag> = {
      item: {
        analyze(calls, ctx) {
          for (const call of calls) {
            if (call.span) {
              ctx.declare("node", "made", {
                span: call.span,
                scope: ["group"],
              });
            }
          }
        },
      },
      group: {},
    };
    lowerSource("<group><item/></group>", "/v/entity.mx", {
      dialect: {
        ...atomSyntax,
        afterLower: (unit) => {
          seen.push(...unit.declared);
        },
      },
      customTags: analyzed,
    });
    expect(seen).toEqual([
      {
        kind: "node",
        name: "made",
        span: { sourceStart: 7, sourceEnd: 14 },
        scope: ["group"],
      },
    ]);
  });
});

/**
 * The keys core no longer knows. The first three are attribute keys, refused
 * by the attribute unknown-key check; `declares` is a tag key, refused by its
 * own pin below.
 */
const FOUR_KEYS: [string, Record<string, CustomTag>, string][] = [
  [
    "values",
    tags({ box: { attributes: { mode: { type: "atom", values: ["a"] } } } }),
    'Unknown key "values" in the "mode" attribute declaration of tag "box"',
  ],
  [
    "pattern",
    tags({ box: { attributes: { mode: { type: "atom", pattern: "^a$" } } } }),
    'Unknown key "pattern" in the "mode" attribute declaration of tag "box"',
  ],
  [
    "ref",
    tags({ box: { attributes: { mode: { type: "atom", ref: "node" } } } }),
    'Unknown key "ref" in the "mode" attribute declaration of tag "box"',
  ],
];

describe("`values`, `pattern` and `ref` belong to the module that claims them, `declares` too", () => {
  const none: Dialect = { id: "plain", name: "Fixture", table: {} };

  it.each(FOUR_KEYS)(
    "`%s` without a claiming module is the unknown-key error",
    (_key, customTags, message) => {
      for (const dialect of [none, undefined]) {
        const result = messages("<box/>", customTags, {
          ...(dialect ? { dialect } : {}),
        });
        expect(result).toHaveLength(1);
        expect(result[0]).toContain(message);
      }
    },
  );

  it.each(FOUR_KEYS)(
    "`%s` is accepted, as data, once a module claims it",
    (key, customTags) => {
      const claimsOnly: Dialect = {
        ...none,
        contractFields: { attribute: [key] },
      };
      expect(messages("<box/>", customTags, { dialect: claimsOnly })).toEqual(
        [],
      );
    },
  );

  it("`declares` reaches a module only when it claims it; unclaimed it is the unknown-key error", () => {
    const declared = tags({ box: { declares: { kind: "node", from: "id" } } });
    const contractOf = (dialect: Dialect) => {
      let seen: unknown;
      lowerSource("<box/>", "/v/entity.mx", {
        dialect: {
          ...dialect,
          afterLower: (unit) => {
            seen = unit.calls[0]?.contract;
          },
        },
        customTags: declared,
      });
      return seen;
    };
    expect(
      contractOf({ ...none, contractFields: { tag: ["declares"] } }),
    ).toEqual({ declares: { kind: "node", from: "id" } });
    const refusal =
      "`<box>`: `declares` is not allowed: no syntax module claims it (`contractFields`)";
    for (const dialect of [none, undefined]) {
      expect(messages("<box/>", declared, dialect ? { dialect } : {})).toEqual([
        refusal,
      ]);
    }
  });

  it("an unclaimed `declares` is refused from a sidecar and from `mx.contracts` too", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-declares-")));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, "tags"));
      writeFileSync(
        join(root, "tags", "box.tag.ts"),
        'export default { declares: { kind: "node", from: "id" }, transform: () => [] };',
      );
      const sidecar = () =>
        // A sidecar loads on its first read of a declared key.
        (
          scanCustomTags(join(root, "page.mx"), { targets: testTargetLookup() })
            .customTags.box as CustomTag
        ).attributes;
      expect(sidecar).toThrow("`declares` is not allowed");
      rmSync(join(root, "tags"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ mx: { contracts: "./c.ts" } }),
      );
      writeFileSync(
        join(root, "c.ts"),
        'export default { box: { declares: { kind: "node", from: "id" } } };',
      );
      expect(() =>
        scanCustomTags(join(root, "page.mx"), { targets: testTargetLookup() }),
      ).toThrow("`declares` is not allowed in `mx.contracts`");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the fixture's first error is the file's, ahead of core's shape error on a later call", () => {
    const box = tags({
      box: { attributes: { mode: { type: "atom", values: ["on", "off"] } } },
    });
    expect(messages('<box mode=~zz/>\n<box mode="red"/>', box)).toEqual([
      "`<box>`: attribute `mode`: `~zz` is not one of ~on, ~off",
    ]);
  });

  it("under the fixture its own checks run and core runs none", () => {
    const box = tags({
      box: {
        attributes: {
          mode: { type: "atom", values: ["on", "off"], pattern: "^o" },
          link: { type: "atom", ref: "node" },
        },
        declares: { kind: "node", from: "id" },
      },
    });
    // The fixture's `afterLower`, not a core check (core wording is `is not one of :on, :off`).
    expect(messages("<box mode=~zz/>", box)).toEqual([
      "`<box>`: attribute `mode`: `~zz` is not one of ~on, ~off",
    ]);
    // `pattern`, `ref` and `declares` are carried and never checked: a
    // pattern the atom fails, a reference nothing declares, two declarations
    // of one name.
    expect(
      messages("<box mode=~on link=~nowhere/>\n<box mode=~off/>", box),
    ).toEqual([]);
    // The fixture's `checkContract` replaces core's registration checks.
    const malformed = tags({
      box: { attributes: { mode: { type: "atom", values: 5 } } },
    });
    expect(messages("<box/>", malformed)).toEqual([
      "`<box>`: `mode`: `values` must be an array of strings",
    ]);
  });
});
