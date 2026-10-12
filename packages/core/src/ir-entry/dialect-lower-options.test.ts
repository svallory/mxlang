/**
 * A dialect states its own defaults for `lowerSource`'s `structural`,
 * `imports` and `unknownTags` on its module. When a call leaves an option
 * out, the dialect the file lowers under supplies it (`option ?? dialect
 * field ?? default`), for a routed file and for the `dialect` option alike;
 * a call that states the option wins, in both directions. `.mx` files route
 * to no dialect, so nothing changes for them.
 *
 * The fixture dialect claims `.member.mx`, closes its vocabulary with
 * `contracts` (`entity`, and `field` under it) and parses with the `none`
 * tag rules. Source {@link S} has one hit of each kind:
 *
 *   1  import x from "./x"          (b) `import`
 *   2  entity
 *   3    field
 *   4    <if=true><field/></if>     (a) `<if>`, at 4:2
 *   5  widget                       (c) unknown tag, at 5:0
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
import { clearScanCache, scanCached } from "../scan-cache.ts";
import { type Dialect, resolveSyntaxOf } from "../syntax-table.ts";
import { clearTagFileCache } from "../tag-file.ts";
import { dialectProject } from "../test-dialect-project.ts";
import { testTargetLookup } from "../test-targets.ts";
import {
  type LowerSourceOptions,
  type LowerSourceResult,
  lowerFile,
  lowerSource,
} from "./index.ts";

const targets = testTargetLookup();

const S = `import x from "./x"
entity
  field
  <if=true><field/></if>
widget
`;

/** S without the `<if>` and the unknown tag: valid under every setting but `imports`. */
const VALID = `import x from "./x"
entity
  field
`;

const IF = {
  severity: "error",
  message:
    "the data tree is static; this file's consumer does not evaluate `<if>`",
  line: 4,
  column: 2,
  code: "MX_STRUCTURAL_CONSTRUCT",
} as const;
const IMPORT = {
  severity: "error",
  message:
    "the data tree is static; this file's consumer does not evaluate `import`",
  line: 1,
  column: 0,
  code: "MX_STRUCTURAL_CONSTRUCT",
} as const;
const UNKNOWN = {
  severity: "error",
  message: "`<widget>` is not a known tag in the `test` dialect",
  line: 5,
  column: 0,
  code: "MX_UNKNOWN_TAG",
} as const;

type Fields = Pick<Dialect, "structural" | "imports" | "unknownTags">;

const CONTRACTS = { entity: {}, field: { parents: ["entity"] } };

/** The fixture dialect as an object, for the `dialect` option. */
const explicit = (fields: Record<string, unknown> = {}): Dialect =>
  ({
    id: "test",
    name: "Test",
    table: {},
    tagRules: "none",
    contracts: CONTRACTS,
    ...fields,
  }) as Dialect;

const STRICT: Fields = {
  structural: "reject",
  imports: "pass",
  unknownTags: "reject",
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-lower-options-")));
  file = join(dir, "a.member.mx");
  clearScanCache();
  clearTagFileCache();
  (globalThis as unknown as { __modes: string[] }).__modes = [];
});
afterEach(() => {
  clearScanCache();
  clearTagFileCache();
  rmSync(dir, { recursive: true, force: true });
});

/** The routed fixture dialect: `fields` are module fields, `extra` is module source. */
function project(fields: Record<string, unknown> = {}, extra = "") {
  return dialectProject(dir, {
    manifest: { id: "test", name: "Test", extensions: [".member.mx"] },
    module: `export default {
  table: {},
  tagRules: "none",
  contracts: ${JSON.stringify(CONTRACTS)},
  ...${JSON.stringify(fields)},
  ${extra}
};`,
  });
}

const brief = (result: LowerSourceResult) =>
  result.diagnostics.map(({ severity, message, line, column, code }) => ({
    severity,
    message,
    line,
    column,
    ...(code === undefined ? {} : { code }),
  }));

const lowerWith = (
  dialect: Dialect,
  options: LowerSourceOptions = {},
  source = S,
) => lowerSource(source, file, { dialect, ...options });

describe("a routed dialect's defaults", () => {
  it("R1: `lowerSource` and `lowerFile` check the file with the dialect's values", () => {
    project(STRICT);
    writeFileSync(file, S);
    const viaSource = lowerSource(S, file);
    expect(brief(viaSource)).toEqual([IF, UNKNOWN]);
    expect(viaSource.ir).toBeUndefined();
    expect(brief(lowerFile(file))).toEqual([IF, UNKNOWN]);
  });

  it("R1: without `imports` it follows the dialect's `structural`", () => {
    project({ structural: "reject", unknownTags: "reject" });
    expect(brief(lowerSource(S, file))).toEqual([IMPORT, IF, UNKNOWN]);
  });

  it.each<[Fields, unknown[]]>([
    [{ unknownTags: "reject" }, [UNKNOWN]],
    [{ structural: "reject", imports: "pass" }, [IF]],
  ])("R1: %j alone changes only its own check", (fields, expected) => {
    project(fields);
    expect(brief(lowerSource(S, file))).toEqual(expected);
  });

  it("R4: a routed dialect without the fields checks as before", () => {
    project();
    const result = lowerSource(S, file);
    expect(brief(result)).toEqual([]);
    expect(result.ir).toBeDefined();
  });

  it("R4: a `.mx` file in the same project is unchanged", () => {
    project(STRICT);
    const result = lowerSource(S, join(dir, "a.mx"));
    expect(brief(result)).toEqual([]);
    expect(result.ir?.imports).toHaveLength(1);
  });

  it("R4: `undefined` fields are absent", () => {
    project();
    expect(
      brief(
        lowerWith(
          explicit({
            structural: undefined,
            imports: undefined,
            unknownTags: undefined,
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("the three ways to state the values give one answer", () => {
  it("R2: routed, `dialect: D` and a bare dialect with the options passed agree", () => {
    project(STRICT);
    const routed = lowerSource(S, file);
    const viaOption = lowerWith(explicit(STRICT));
    const passed = lowerWith(explicit(), STRICT);
    expect(brief(routed)).toEqual([IF, UNKNOWN]);
    expect(viaOption.diagnostics).toEqual(routed.diagnostics);
    expect(passed.diagnostics).toEqual(routed.diagnostics);
  });

  it("R2: a valid file lowers to an equal IR, with one import", () => {
    project(STRICT);
    const routed = lowerSource(VALID, file);
    const viaOption = lowerWith(explicit(STRICT), {}, VALID);
    const passed = lowerWith(explicit(), STRICT, VALID);
    expect(routed.diagnostics).toEqual([]);
    expect(routed.ir?.imports).toHaveLength(1);
    expect(viaOption.ir).toEqual(routed.ir);
    expect(passed.ir).toEqual(routed.ir);
  });
});

describe("R3: a call's option wins, field by field and both ways", () => {
  it("`structural`", () => {
    expect(
      brief(
        lowerWith(explicit({ structural: "reject" }), { structural: "pass" }),
      ),
    ).toEqual([]);
    expect(
      brief(lowerWith(explicit(), { structural: "reject" })).map((d) => d.line),
    ).toEqual([1, 4]);
  });

  it("`unknownTags`", () => {
    expect(
      brief(
        lowerWith(explicit({ unknownTags: "reject" }), {
          unknownTags: "allow",
        }),
      ),
    ).toEqual([]);
    expect(brief(lowerWith(explicit(), { unknownTags: "reject" }))).toEqual([
      UNKNOWN,
    ]);
  });

  // [dialect fields, call options, whether the `import` is rejected]
  it.each<[Fields, Fields, boolean]>([
    [{ structural: "reject" }, {}, true],
    [{ structural: "reject", imports: "pass" }, { structural: "pass" }, false],
    [{ structural: "reject" }, { structural: "pass" }, false],
    [{ imports: "reject" }, { structural: "reject" }, true],
    [{}, { structural: "reject", imports: "pass" }, false],
    [{ imports: "reject" }, {}, true],
    [{ imports: "reject" }, { imports: "pass" }, false],
    [{ imports: "pass" }, { imports: "reject" }, true],
    [{ structural: "reject", imports: "pass" }, {}, false],
  ])(
    "`imports`: dialect %j, call %j: rejected %s",
    (fields, options, rejected) => {
      const messages = brief(lowerWith(explicit(fields), options)).map(
        (d) => d.message,
      );
      expect(messages.includes(IMPORT.message)).toBe(rejected);
    },
  );
});

describe("R5: a value outside the option's set", () => {
  it.each([
    ["structural", '"strict"', '`structural` must be "pass" or "reject"'],
    ["imports", "true", '`imports` must be "pass" or "reject"'],
    ["unknownTags", '"deny"', '`unknownTags` must be "allow" or "reject"'],
  ])("a module's `%s: %s` is an error in the module", (_, value, message) => {
    const { packageDir } = dialectProject(dir, {
      manifest: { id: "test", name: "Test", extensions: [".member.mx"] },
      module: `export default { table: {}, ${_}: ${value} };`,
    });
    const result = lowerSource(S, file);
    expect(result.ir).toBeUndefined();
    expect(
      result.diagnostics.map((d) => [d.message, d.file, d.line, d.column]),
    ).toEqual([[message, join(packageDir, "index.mjs"), 1, 0]]);
  });

  it.each([
    ["structural", "strict", '`dialect.structural` must be "pass" or "reject"'],
    ["imports", true, '`dialect.imports` must be "pass" or "reject"'],
    [
      "unknownTags",
      "deny",
      '`dialect.unknownTags` must be "allow" or "reject"',
    ],
  ])("the `dialect` option's `%s: %j`", (field, value, message) => {
    const result = lowerWith(explicit({ [field]: value }));
    expect(result.ir).toBeUndefined();
    expect(brief(result)).toEqual([
      {
        severity: "error",
        message: `the \`dialect\` option is not a valid dialect: ${message}`,
        line: 1,
        column: 0,
        code: "MX_INVALID_DIALECT_MODULE",
      },
    ]);
  });

  it("a call's option does not rescue an invalid module field", () => {
    const result = lowerWith(explicit({ structural: "strict" }), {
      structural: "pass",
    });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'the `dialect` option is not a valid dialect: `dialect.structural` must be "pass" or "reject"',
    ]);
  });
});

describe("R6: the unknown-tag explainer sees the effective mode", () => {
  const HOOK = `explainUnknownTag(tag) {
    globalThis.__modes.push(tag.mode);
    return undefined;
  },`;
  const modes = () => (globalThis as unknown as { __modes: string[] }).__modes;

  it("the dialect's value with no option, the call's when it states one", () => {
    project({ unknownTags: "reject" }, HOOK);
    lowerSource("entity\nwidget\n", file);
    expect(modes()).toEqual(["reject"]);
    modes().length = 0;
    lowerSource("entity\nwidget\n", file, { unknownTags: "allow" });
    expect(modes()).toEqual(["allow"]);
  });

  it("a dialect that states none reads as `allow`", () => {
    project({}, HOOK);
    lowerSource("entity\nwidget\n", file);
    expect(modes()).toEqual(["allow"]);
  });
});

describe("R7: a dialect's tag files", () => {
  const TAG_FILE = `tagFile(input, ctx) {
    const result = ctx.lower(input.source.includes("PASS") ? { structural: "pass" } : {});
    return {
      contract: {},
      diagnostics: result.diagnostics.map((d) => ({
        severity: d.severity, message: d.message, line: d.line, column: d.column,
      })),
    };
  },`;

  function tagProject() {
    dialectProject(dir, {
      manifest: {
        id: "test",
        name: "Test",
        extensions: [".member.mx"],
        tagDirs: ["concepts"],
      },
      module: `export default { table: {}, tagRules: "none", structural: "reject", ${TAG_FILE} };`,
    });
  }

  function write(path: string, text: string) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  const callMoney = () =>
    lowerSource("<money/>\n", file, {
      customTags: scanCached(file, { targets }).customTags,
    });

  it("`ctx.lower()` gets the dialect's `structural`", () => {
    tagProject();
    write("concepts/money.member.mx", "<if=true><div/></if>\n");
    expect(
      brief(callMoney()).map((d) => [d.message, d.line, d.column]),
    ).toEqual([
      [
        "`<money>`'s definition has errors (concepts/money.member.mx:1:1)",
        1,
        0,
      ],
      [IF.message, 1, 0],
    ]);
  });

  it('`ctx.lower({ structural: "pass" })` does not', () => {
    tagProject();
    write("concepts/money.member.mx", "<!-- PASS -->\n<if=true><div/></if>\n");
    expect(brief(callMoney())).toEqual([]);
  });
});

describe("an explicit dialect is isolated from the routed one", () => {
  it("R1: in a strict routed project, a bare table and a field-less dialect check nothing", () => {
    project(STRICT);
    expect(brief(lowerSource(S, file))).toEqual([IF, UNKNOWN]);
    const bare = resolveSyntaxOf(join(dir, "z.mx")).table;
    expect(brief(lowerSource(S, file, { dialect: bare }))).toEqual([]);
    expect(brief(lowerWith(explicit()))).toEqual([]);
  });
});

describe("`unknownTags` closes the vocabulary when parsing fails", () => {
  const CLOSED = {
    entity: { children: { field: {} } },
    field: { parents: ["entity"] },
  };
  const MISSPELT = "entity\n  wiget\n";

  function closedProject(unknownTags: "allow" | "reject") {
    return dialectProject(dir, {
      manifest: { id: "test", name: "Test", extensions: [".member.mx"] },
      module: `export default {
  table: {},
  tagRules: "none",
  contracts: ${JSON.stringify(CLOSED)},
  unknownTags: ${JSON.stringify(unknownTags)},
};`,
    });
  }

  it("the dialect's `reject` names the misspelt child as unknown", () => {
    closedProject("reject");
    expect(brief(lowerSource(MISSPELT, file))).toEqual([
      {
        severity: "error",
        message: "`<wiget>` is not a known tag in the `test` dialect",
        line: 2,
        column: 2,
        code: "MX_UNKNOWN_TAG",
      },
    ]);
  });

  it("the call's `allow` wins and the closed parent refuses the child", () => {
    closedProject("reject");
    expect(
      brief(lowerSource(MISSPELT, file, { unknownTags: "allow" })),
    ).toEqual([
      {
        severity: "error",
        message:
          "`<entity>`: `<wiget>` is not allowed here; allowed children: `<field>`",
        line: 2,
        column: 2,
        code: "MX_TAG_NOT_ALLOWED",
      },
    ]);
  });
});
