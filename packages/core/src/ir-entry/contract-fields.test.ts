/**
 * Slice a2 of `lang-ext-move-sugars-to-mesh`: the atom contract checks
 * (`values`, `pattern`, `ref`, `declares`) run from the reference module's
 * `afterLower`, which claims those keys (`contractFields`). Through
 * `lowerSource` a Mesh file gets the diagnostics the built-in path gives, field
 * for field (message, line, column, offset, file, code), whether the module
 * comes from the `dialect` option or a dialect package that claims the file's
 * extension (decision 212), registration
 * errors included (the module's `checkContract`, called tag or not); a
 * module's own check reaches the diagnostic with its position and `code`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { type Dialect, defaultSyntax } from "../syntax-table.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";
import { dialectPackage } from "./test-dialect-package.ts";

const MODULE = join(import.meta.dirname, "../syntax/mesh.ts");

/** Through Node's strip-only `require`, as a dialect package's module loads. */
const meshSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: Dialect }
).default;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-contract-fields-")));
  dialectPackage(dir, MODULE, { id: "mesh", name: "Mesh" });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const customTags: Record<string, CustomTag> = {
  entity: { attributes: { name: { type: "atom" } } },
  attributes: {},
  actions: {},
  arguments: {},
  string: {
    attributes: { name: { type: "atom" } },
    declares: [
      { kind: "attribute", from: "name", under: "attributes" },
      { kind: "argument", from: "name", under: "arguments", scope: "action" },
    ],
  },
  action: {
    attributes: { name: { type: "atom" } },
    declares: { kind: "action", from: "name" },
  },
  policy: {
    attributes: {
      accept: { type: "atom", ref: "attribute" },
      require: { type: "atom", ref: ["attribute", "argument"] },
      types: { type: "atom", values: ["create", "read", "update", "destroy"] },
      slug: { type: "atom", pattern: "^[a-z]+$" },
    },
  },
};

const FAILING: readonly string[] = [
  `entity :Invoice
  attributes
    string :title
    string :body
  policy accept=[:title, :bdy]
`,
  `entity :Invoice
  attributes
    string :title
  policy accept="title"
`,
  `entity :Invoice
  policy types=:craete
`,
  `entity :Invoice
  policy slug=:Upper
`,
  `entity :Invoice
  attributes
    string :title
    string :title
`,
  `entity :Invoice
  actions
    action :rename
      arguments
        string :newTitle
    action :other
      policy require=:newTitle
`,
  `entity :Invoice
  arguments
    string :orphan
`,
];

const PASSING = `entity :Invoice
  attributes
    string :title
  actions
    action :rename
      arguments
        string :newTitle
      policy require=[:title, :newTitle] types=:update slug=:abc
`;

/** The built-in path: the `.mx` default row, explicitly (no module). */
const builtIn = (source: string) =>
  lowerSource(source, "/v/invoice.mx", {
    customTags,
    dialect: defaultSyntax(),
  }).diagnostics;

const LOADERS: [string, () => [string, LowerSourceOptions]][] = [
  ["the `dialect` option", () => ["/v/invoice.mx", { dialect: meshSyntax }]],
  ["a dialect package", () => [join(dir, "invoice.mesh"), {}]],
];

describe.each(LOADERS)("through %s", (_, loader) => {
  const viaModule = (source: string) => {
    const [file, options] = loader();
    return lowerSource(source, file, { ...options, customTags }).diagnostics;
  };

  it.each(FAILING)("matches the built-in diagnostics: %s", (source) => {
    const expected = builtIn(source);
    expect(expected).toHaveLength(1);
    expect(expected[0]?.severity).toBe("error");
    expect(viaModule(source)).toEqual(expected);
  });

  it("accepts what the built-in path accepts", () => {
    expect(builtIn(PASSING)).toEqual([]);
    expect(viaModule(PASSING)).toEqual([]);
  });

  it.each([
    ["called", "box\n"],
    ["never called", "other\n"],
  ])(
    "reports a malformed claimed key at registration, file-level, on a tag %s",
    (_, source) => {
      const tags = {
        other: {},
        box: { attributes: { a: { type: "string", values: ["a"] } } },
      } as unknown as Record<string, CustomTag>;
      const [file, options] = loader();
      const expected = {
        severity: "error",
        message:
          'Invalid "a" attribute declaration of tag "box": `values` requires `type: "atom"`',
        line: 1,
        column: 0,
        offset: 0,
      };
      expect(
        lowerSource(source, "/v/x.mx", {
          customTags: tags,
          dialect: defaultSyntax(),
        }).diagnostics,
      ).toEqual([expected]);
      expect(
        lowerSource(source, file, { ...options, customTags: tags }).diagnostics,
      ).toEqual([expected]);
    },
  );
});

describe("a module's own contract key", () => {
  it("passes through registration and reaches its `afterLower`, whose `fail` is a positioned, coded diagnostic", () => {
    const source = "entity :Invoice\n  index on=:title\n";
    const tags: Record<string, CustomTag> = {
      entity: { attributes: { name: { type: "atom" } } },
      index: {
        attributes: { on: { type: "atom", unique: true } as never },
        relations: "many",
      } as CustomTag,
    };
    // Without a module that claims them, `unique` is an unknown key.
    expect(
      lowerSource(source, "/v/x.mx", { customTags: tags, dialect: meshSyntax })
        .diagnostics[0]?.message,
    ).toMatch(/Unknown key "unique"/);

    const seen: unknown[] = [];
    const module: Dialect = {
      ...meshSyntax,
      contractFields: { attribute: ["unique"], tag: ["relations"] },
      afterLower(unit) {
        for (const call of unit.calls) {
          if (call.tag !== "index") continue;
          seen.push([call.tag, call.contract.relations]);
          const on = call.attrs.find(
            (attr) => attr.kind !== "spread" && attr.name === "on",
          );
          if (on?.kind === "atom" && call.contract.attributes?.on?.unique) {
            unit.fail(`\`:${on.value}\` is not unique`, {
              at: on.span,
              code: "MESH_UNIQUE",
            });
          }
        }
      },
    };
    const { diagnostics } = lowerSource(source, "/v/x.mx", {
      customTags: tags,
      dialect: module,
    });
    expect(seen).toEqual([["index", "many"]]);
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message: "`:title` is not unique",
        line: 2,
        column: 11,
        offset: source.indexOf(":title"),
        code: "MESH_UNIQUE",
      },
    ]);
  });
});
