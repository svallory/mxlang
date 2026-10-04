import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CustomTag,
  clearScanCache,
  createTargetLookup,
  getCustomTags,
} from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { type ParseDataOptions, parseData } from "./parse.ts";

/**
 * The data path for `mx.contracts` (decision 142): a dialect package whose
 * entire vocabulary is one contracts module — no sidecars, no `tags/`
 * directory — reaches `parseData` through the one-liner a data consumer
 * writes: `getCustomTags(file, { targets, host: null })` handed to
 * `parseData` as `customTags`. The 25 tag names are copied from the Ash
 * resource fixture (`fixtures/ash-resource/post.mx`, the mash-shaped dialect
 * decision 131 made this target's first fixture); that file is the positive
 * proof, and small mutations of it pin each rule family: nesting, parents,
 * cardinality, `array`/`function` attribute types, and one `analyze` rule.
 *
 * The lookup is the single-target one over this package's own descriptor —
 * the same lookup `parseData` compiles under. The registry lookup is not
 * used here because `@mxlang/target-registry` already depends on
 * `@mxlang/data`; a test-only dependency back would be a cycle.
 *
 * The fixture is built in a temp dir, not committed: a committed
 * `package.json` in `fixtures/` would become the walk-up boundary for every
 * scan over the committed `.mx` files.
 */

const dataTargets = createTargetLookup([descriptor]);

/**
 * The Ash dialect as one contracts module. Concise-mode call lines carry a
 * default attribute literally named `value` (`resource="post"` is the tag's
 * `value` attribute, measured on the parsed fixture tree), so the tag and its
 * default attribute do not share a name.
 */
const ASH_CONTRACTS = `import type { ContractMap } from "@mxlang/core";

export default {
  resource: {
    parents: ["#root"],
    attributes: {
      value: { type: "string", required: true },
      table: { type: "string", required: true },
      domain: { type: "string" },
    },
    children: {
      attributes: { required: true },
      relationships: {},
      actions: {},
      policies: {},
      calculations: {},
      aggregates: {},
    },
  },
  attributes: {
    parents: ["resource"],
    children: {
      "uuid-primary-key": {},
      attribute: { repeatable: true },
      timestamps: {},
    },
  },
  "uuid-primary-key": {
    parents: ["attributes"],
    attributes: { value: { type: "string", required: true } },
  },
  attribute: {
    parents: ["attributes"],
    attributes: {
      value: { type: "string", required: true },
      type: { type: "string", required: true },
      values: { type: "array", items: "string" },
      required: { type: "boolean" },
      public: { type: "boolean" },
      default: {},
    },
  },
  timestamps: { parents: ["attributes"] },
  relationships: {
    parents: ["resource"],
    children: { "belongs-to": { repeatable: true }, "has-many": { repeatable: true } },
  },
  "belongs-to": {
    parents: ["relationships"],
    attributes: {
      value: { type: "string", required: true },
      resource: { type: "string", required: true },
    },
  },
  "has-many": {
    parents: ["relationships"],
    attributes: {
      value: { type: "string", required: true },
      resource: { type: "string", required: true },
    },
  },
  actions: {
    parents: ["resource"],
    children: {
      defaults: {},
      create: { repeatable: true },
      update: { repeatable: true },
      read: { repeatable: true },
    },
  },
  defaults: {
    parents: ["actions"],
    attributes: { value: { type: "array", items: "string", required: true } },
  },
  create: {
    parents: ["actions"],
    attributes: {
      value: { type: "string", required: true },
      accept: { type: "array", items: "string" },
    },
    children: { change: { repeatable: true } },
  },
  change: {
    parents: ["create", "update"],
    attributes: { value: { type: "function", required: true } },
  },
  update: {
    parents: ["actions"],
    attributes: { value: { type: "string", required: true } },
    children: { change: {}, validate: {} },
  },
  validate: {
    parents: ["update"],
    attributes: {
      value: { type: "function", required: true },
      message: { type: "string" },
    },
  },
  read: {
    parents: ["actions"],
    attributes: { value: { type: "string", required: true } },
    children: { filter: {}, sort: {} },
  },
  filter: {
    parents: ["read"],
    attributes: { value: { type: "function", required: true } },
  },
  sort: {
    parents: ["read"],
    attributes: { value: { type: "array", items: "string", required: true } },
  },
  policies: {
    parents: ["resource"],
    children: { policy: { repeatable: true } },
  },
  policy: {
    parents: ["policies"],
    children: { "authorize-if": { repeatable: true } },
    analyze(calls, ctx) {
      for (const call of calls) {
        const names = call.attrs.map((attr) => attr.name);
        if (!names.includes("action") && !names.includes("action-type")) {
          ctx.fail(
            "one of \`action\` or \`action-type\` is required",
            call.loc,
          );
        }
      }
    },
  },
  "authorize-if": {
    parents: ["policy"],
    attributes: { value: { type: "function", required: true } },
  },
  calculations: {
    parents: ["resource"],
    children: { calculate: { repeatable: true } },
  },
  calculate: {
    parents: ["calculations"],
    attributes: {
      value: { type: "string", required: true },
      type: { type: "string", required: true },
    },
    children: { value: {} },
  },
  value: {
    parents: ["calculate"],
    attributes: { value: { type: "function", required: true } },
  },
  aggregates: {
    parents: ["resource"],
    children: { count: { repeatable: true } },
  },
  count: {
    parents: ["aggregates"],
    attributes: {
      value: { type: "string", required: true },
      relationship: { type: "string", required: true },
    },
  },
} satisfies ContractMap;
`;

const dirs: string[] = [];
afterEach(() => {
  clearScanCache();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A package whose only tag vocabulary is the contracts module. */
function dialectProject(source: string): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-data-contracts-")));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "ash-dialect-fixture",
      mx: { target: "data", contracts: "./contracts.ts" },
    }),
  );
  writeFileSync(join(dir, "contracts.ts"), ASH_CONTRACTS);
  const file = join(dir, "post.mx");
  writeFileSync(file, source);
  return { dir, file };
}

function parseWithDialect(
  source: string,
  options: Omit<ParseDataOptions, "customTags"> = {},
) {
  const { file } = dialectProject(source);
  const customTags = getCustomTags(file, { targets: dataTargets, host: null });
  return {
    customTags,
    result: parseData(source, file, { customTags, ...options }),
  };
}

const ashSource = readFileSync(
  new URL("../fixtures/ash-resource/post.mx", import.meta.url),
  "utf8",
);

describe("mx.contracts on the data path", () => {
  it("learns the whole dialect from the module: 25 names, no sidecars", () => {
    const { dir, file } = dialectProject(ashSource);
    const customTags = getCustomTags(file, {
      targets: dataTargets,
      host: null,
    });
    expect(readdirSync(dir).sort()).toEqual([
      "contracts.ts",
      "package.json",
      "post.mx",
    ]);

    expect(Object.keys(customTags).sort()).toEqual(
      [
        "actions",
        "aggregates",
        "attribute",
        "attributes",
        "authorize-if",
        "belongs-to",
        "calculate",
        "calculations",
        "change",
        "count",
        "create",
        "defaults",
        "filter",
        "has-many",
        "policies",
        "policy",
        "read",
        "relationships",
        "resource",
        "sort",
        "timestamps",
        "update",
        "uuid-primary-key",
        "validate",
        "value",
      ].sort(),
    );
  });

  it("validates the whole Ash fixture through the module contracts", () => {
    const { result } = parseWithDialect(ashSource);

    expect(result.diagnostics).toEqual([]);
    const resource = result.tree?.children[0];
    expect(resource?.kind).toBe("tag");
    if (resource?.kind !== "tag") throw new Error("no resource tree");
    expect(resource.name).toBe("resource");
    expect(
      resource.children.map((child) =>
        child.kind === "tag" ? child.name : child.kind,
      ),
    ).toEqual([
      "attributes",
      "relationships",
      "actions",
      "policies",
      "calculations",
      "aggregates",
    ]);
  });

  it("enforces parents: a tag outside its declared parent is positioned", () => {
    const { result } = parseWithDialect('attribute="title" type="string"\n');

    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      line: 1,
      // 0-based column of the `<attribute>` call.
      column: 0,
    });
    expect(result.diagnostics[0]?.message).toContain(
      "`<attribute>` must be inside `<attributes>`",
    );
  });

  it("enforces nesting: a child not declared by its parent is positioned", () => {
    const { result } = parseWithDialect(
      [
        'resource="post" table="posts"',
        "  attributes",
        "    timestamps",
        "    policies",
      ].join("\n"),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "`<policies>` is not allowed here",
    );
    expect(result.diagnostics[0]?.message).toContain(
      "allowed children: `<uuid-primary-key>`, `<attribute>`, `<timestamps>`",
    );
    expect(result.diagnostics[0]?.line).toBe(4);
  });

  it("enforces cardinality: a missing required child and a repeated child are positioned", () => {
    // `relationships` is a valid child, so the only violation is the missing
    // required `attributes`.
    const { result } = parseWithDialect(
      ['resource="post" table="posts"', "  relationships"].join("\n"),
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "missing required child `<attributes>`",
    );
    expect(result.diagnostics[0]?.line).toBe(1);

    const repeated = parseWithDialect(
      ['resource="post" table="posts"', "  attributes", "  attributes"].join(
        "\n",
      ),
    );
    expect(repeated.result.diagnostics).toHaveLength(1);
    expect(repeated.result.diagnostics[0]?.message).toContain(
      "`<attributes>` may not be repeated",
    );
    expect(repeated.result.diagnostics[0]?.line).toBe(3);
  });

  it("enforces array types: a string literal for an array attribute is positioned", () => {
    const { result } = parseWithDialect(
      [
        'resource="post" table="posts"',
        "  attributes",
        '    attribute="state" type="enum" values="draft"',
      ].join("\n"),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "attribute `values` must be array, got string",
    );
    expect(result.diagnostics[0]?.line).toBe(3);
  });

  it("enforces function types: a string literal for a function attribute is positioned", () => {
    const { result } = parseWithDialect(
      [
        'resource="post" table="posts"',
        "  attributes",
        "  actions",
        '    create="create"',
        '      change="not a function"',
      ].join("\n"),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "attribute `value` must be function, got string",
    );
    expect(result.diagnostics[0]?.line).toBe(5);
  });

  it("runs the module's analyze rule: policy without action or action-type fails at the call", () => {
    const { result } = parseWithDialect(
      [
        'resource="post" table="posts"',
        "  attributes",
        "  policies",
        "    policy",
        "      authorize-if=({ post }) => post.state === 'published'",
      ].join("\n"),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 4,
      column: 4,
    });
    expect(result.diagnostics[0]?.message).toContain(
      "one of `action` or `action-type` is required",
    );
  });

  it('unknownTags: reject refuses an unknown root tag (Mesh\'s widget="post")', () => {
    const { result } = parseWithDialect('widget="post"\n', {
      structural: "reject",
      unknownTags: "reject",
    });

    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      line: 1,
      column: 0,
      message:
        "`<widget>` is not a known tag: it has no contract in `customTags`",
    });
  });
});

/**
 * The direct one-liner a dialect's own build uses: import the module's
 * `ContractMap` and pass it as `customTags`, with no scan. Mesh depends on
 * `analyze` running on this path under `structural: "reject"` for its
 * conditional rules (enum `values`, `action`/`action-type`), so it is pinned
 * here rather than inferred from the scan path above.
 */
describe("a directly imported ContractMap on the data path", () => {
  async function importedContracts() {
    const { dir } = dialectProject("");
    const module = (await import(join(dir, "contracts.ts"))) as {
      default: Record<string, CustomTag>;
    };
    return { dir, contracts: module.default };
  }

  it("runs analyze with customTags passed directly and structural: reject", async () => {
    const { dir, contracts } = await importedContracts();
    const invalid = parseData(
      [
        'resource="post" table="posts"',
        "  attributes",
        "  policies",
        "    policy",
        "      authorize-if=({ post }) => post.state === 'published'",
      ].join("\n"),
      join(dir, "post.mx"),
      { customTags: contracts, structural: "reject" },
    );
    expect(
      invalid.diagnostics.map(({ line, column, message }) => ({
        line,
        column,
        message,
      })),
    ).toEqual([
      {
        line: 4,
        column: 4,
        message: "`<policy>`: one of `action` or `action-type` is required",
      },
    ]);

    const valid = parseData(
      [
        'resource="post" table="posts"',
        "  attributes",
        "  policies",
        '    policy action="read"',
        "      authorize-if=({ post }) => true",
      ].join("\n"),
      join(dir, "post.mx"),
      { customTags: contracts, structural: "reject" },
    );
    expect(valid.diagnostics).toEqual([]);
  });

  it("ignores a local tags/ file that getCustomTags would pick up", async () => {
    const { dir, contracts } = await importedContracts();
    const file = join(dir, "post.mx");
    const baseline = parseData(ashSource, file, {
      customTags: contracts,
      structural: "reject",
    });
    expect(baseline.diagnostics).toEqual([]);

    // A stray local template for a dialect name: the scan lets it win.
    mkdirSync(join(dir, "tags"));
    writeFileSync(join(dir, "tags", "attribute.mx"), "<span/>\n");
    const scanned = getCustomTags(file, { targets: dataTargets, host: null });
    expect(
      (scanned.attribute as { template?: { filename: string } } | undefined)
        ?.template?.filename,
    ).toBe(join(dir, "tags", "attribute.mx"));

    // parseData with the directly imported map does not consult tags/: the
    // same source still validates and yields the same tree.
    clearScanCache();
    const withLocalTags = parseData(ashSource, file, {
      customTags: contracts,
      structural: "reject",
    });
    expect(withLocalTags.diagnostics).toEqual([]);
    expect(withLocalTags.tree).toEqual(baseline.tree);
  });
});
