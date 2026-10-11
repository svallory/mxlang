/**
 * `Dialect.contracts`: a dialect's own tag vocabulary, registered for every
 * file routed to the dialect and every entry given the dialect, merged with
 * the caller's (or the scan's) `customTags` by the five-rank precedence;
 * validated once per module revision; and the manifest's `mxConfigTags`.
 *
 * The test dialect `lexi` (claiming `.lexi.mx`, reserving `sealed`) is a
 * fixture, not any real dialect.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { isTranslateError } from "./core.ts";
import type { ContractMap, CustomTag } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import { INVALID_DIALECT_CONTRACT_CODE } from "./diagnostic-codes.ts";
import { parseFragment } from "./fragment.ts";
import {
  type LowerSourceOptions,
  type LowerSourceResult,
  lowerFile,
  lowerSource,
} from "./ir-entry/index.ts";
import { scanCustomTags } from "./scan.ts";
import { clearScanCache, scanCached } from "./scan-cache.ts";
import { dialectCustomTags, resolveSyntaxOf } from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup, testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const RESERVED_CODE = "MX_RESERVED_TAG";
const CODE = "MX_INVALID_DIALECT_CONTRACT";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-contracts-")));
  clearScanCache();
});
afterEach(() => {
  clearScanCache();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text = "<div/>\n", root = dir): string {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const LEXI = {
  id: "lexi",
  name: "Lexi",
  extensions: [".lexi.mx"],
  module: "./index.cjs",
  reservedTags: ["sealed"],
};

/**
 * A project at `root` using `lexi`, whose module is `module` (CommonJS,
 * re-evaluated when edited). `fields` override the manifest's.
 */
function lexiProject(
  module: string,
  options: {
    fields?: Record<string, unknown>;
    mx?: unknown;
    root?: string;
  } = {},
) {
  return dialectProject(options.root ?? dir, {
    packageName: "lexi-dialect",
    manifest: { ...LEXI, ...options.fields },
    module,
    ...(options.mx === undefined ? {} : { mx: options.mx }),
  });
}

/**
 * The shared vocabulary fixture: one CommonJS file both the dialect module
 * and the test load, so a contract passed as `customTags` and the same
 * contract in `Dialect.contracts` are the same objects.
 */
const VOCAB_SOURCE = `
const panel = {
  attributes: { title: { type: "string", required: true } },
  attributeTags: { row: { attributes: { n: { type: "number" } } } },
  children: { item: {}, "#text": {} },
  defaultTag: "item",
};
const item = { parents: ["panel"] };
const solo = {
  analyze(calls, ctx) {
    if (calls.length > 1) ctx.fail("one <solo> per file", { code: "LEXI_ONE_SOLO" });
  },
};
module.exports = { VOCAB: { panel, item, solo } };
`;

/** Writes the vocabulary fixture under `root` and loads it. */
function vocabAt(root: string): { file: string; vocab: ContractMap } {
  const file = write("fixture/vocab.cjs", VOCAB_SOURCE, root);
  const vocab = createRequire(file)(file).VOCAB as ContractMap;
  return { file, vocab };
}

/** A CommonJS dialect module whose `contracts` are the vocabulary fixture. */
const moduleWithVocab = (file: string, extra = "") =>
  `const { VOCAB } = require(${JSON.stringify(file)});\nmodule.exports = { default: { table: {}, contracts: VOCAB${extra} } };`;

/** A result with `dir` replaced, so two projects' results compare. */
const portable = (result: unknown, root: string): unknown =>
  JSON.parse(
    JSON.stringify(result ?? null)
      .split(root)
      .join("<root>"),
  );

/** The R1 call matrix: valid calls, and one bad call per contract part. */
const CALLS: Record<string, string> = {
  valid: '<panel title="t"><@row n=1/><item/>text</panel>\n<solo/>\n',
  "missing attribute": "<panel><item/></panel>\n",
  "unknown attribute": '<panel title="t" color="red"/>\n',
  "bad attribute-tag attribute": '<panel title="t"><@row z=1/></panel>\n',
  "unknown attribute tag": '<panel title="t"><@col/></panel>\n',
  "child not allowed": '<panel title="t"><solo/></panel>\n',
  "parent not allowed": "<item/>\n",
  "valid default tag": '<panel title="t"><.x/></panel>\n',
  "analyze code": "<solo/>\n<solo/>\n",
};

describe("R1: a dialect contract checks a call exactly as the same contract passed as `customTags`", () => {
  it.each(Object.entries(CALLS))("%s", (_, source) => {
    // Two projects, one shape: `viaOption` passes the vocabulary as
    // `customTags` to a contract-less dialect; `viaDialect` ships it.
    const viaOption = join(dir, "a");
    const viaDialect = join(dir, "b");
    const a = vocabAt(viaOption);
    lexiProject("module.exports = { default: { table: {} } };", {
      root: viaOption,
    });
    const b = vocabAt(viaDialect);
    lexiProject(moduleWithVocab(b.file), { root: viaDialect });
    const passed = lowerSource(source, join(viaOption, "page.lexi.mx"), {
      customTags: a.vocab,
    });
    const shipped = lowerSource(source, join(viaDialect, "page.lexi.mx"), {});
    expect(portable(shipped, viaDialect)).toEqual(portable(passed, viaOption));
    if (source === CALLS.valid || source === CALLS["valid default tag"]) {
      expect(shipped.diagnostics).toEqual([]);
      expect(shipped.ir?.body.length).toBeGreaterThan(0);
    } else {
      expect(shipped.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("each bad call has the error the contract gives, at the call", () => {
    const { file } = vocabAt(dir);
    lexiProject(moduleWithVocab(file));
    const at = (source: string) =>
      lowerSource(source, join(dir, "page.lexi.mx"), {}).diagnostics.map(
        ({ message, code, line, column, offset }) => ({
          message,
          code,
          line,
          column,
          offset,
        }),
      );
    expect(at(CALLS["missing attribute"] as string)).toEqual([
      {
        message: "`<panel>`: missing required attribute `title`",
        code: undefined,
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
    expect(at(CALLS["analyze code"] as string)).toEqual([
      {
        message: "`<solo>`: one <solo> per file",
        code: "LEXI_ONE_SOLO",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
    expect(at(CALLS["parent not allowed"] as string)).toEqual([
      expect.objectContaining({ line: 1, column: 0, offset: 0 }),
    ]);
  });
});

const policy: Policy = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

describe("R2: every entry registers the contracts; an `.mx` file never sees them", () => {
  const MODULE = `module.exports = { default: { table: {}, contracts: {
    box: {
      attributes: { need: { type: "string", required: true } },
      transform: () => [],
    },
    raw: { parseOptions: { text: true } },
  } } };`;
  /** The explicit-option form of the same dialect. */
  const BOX: CustomTag = {
    attributes: { need: { type: "string", required: true } },
    transform: () => [],
  };
  const DIALECT = {
    id: "lexi",
    name: "Lexi",
    table: {},
    contracts: { box: BOX, raw: { parseOptions: { text: true } } },
  };
  const MISSING = "`<box>`: missing required attribute `need`";
  const messages = (result: LowerSourceResult) =>
    result.diagnostics.map((d) => d.message);

  it("lowerSource, routed: the dialect's file is checked; the `.mx` file beside it is not", () => {
    lexiProject(MODULE);
    expect(messages(lowerSource("<box/>\n", join(dir, "p.lexi.mx")))).toEqual([
      MISSING,
    ]);
    const mx = lowerSource("<box/>\n", join(dir, "p.mx"), {
      unknownTags: "reject",
    });
    expect(mx.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["MX_UNKNOWN_TAG", expect.stringContaining("`<box>`")],
    ]);
  });

  it("lowerFile, routed", () => {
    lexiProject(MODULE);
    const file = write("p.lexi.mx", "<box/>\n");
    expect(messages(lowerFile(file))).toEqual([MISSING]);
    expect(messages(lowerFile(write("p.mx", "<box/>\n")))).toEqual([]);
  });

  it("lowerSource and lowerFile with an explicit dialect, on any filename", () => {
    const dialect = DIALECT;
    expect(
      messages(lowerSource("<box/>\n", join(dir, "p.mx"), { dialect })),
    ).toEqual([MISSING]);
    const file = write("q.mx", "<box/>\n");
    expect(messages(lowerFile(file, { dialect }))).toEqual([MISSING]);
  });

  it("compileSource, explicit `host.dialect` and routed", () => {
    const dialect = DIALECT;
    const compile = (file: string, extra: object) => {
      try {
        compileSource("<box/>\n", file, policy, {
          targets: lookup,
          tagDiscoveryDirs: [],
          emitIr: () => "",
          ...extra,
        });
        return undefined;
      } catch (error) {
        return isTranslateError(error) ? error.message : String(error);
      }
    };
    expect(compile(join(dir, "p.mx"), { dialect })).toContain(MISSING);
    lexiProject(MODULE);
    expect(compile(join(dir, "p.lexi.mx"), {})).toContain(MISSING);
    expect(compile(join(dir, "p.mx"), {})).toBeUndefined();
  });

  it("parseFragment, routed and explicit: a contract's `parseOptions` shape the parse", () => {
    lexiProject(MODULE);
    const shape = (base: Parameters<typeof parseFragment>[1]) =>
      parseFragment("<raw><b/></raw>", base).body.map((node) => [
        node.type,
        ((node as { body?: Array<{ type: string }> }).body ?? []).map(
          (child) => child.type,
        ),
      ]);
    // `text: true`: `<raw>`'s body is text, not a `<b>` tag.
    expect(shape({ filename: join(dir, "f.lexi.mx") })).toEqual([
      ["MxTag", ["MxText"]],
    ]);
    expect(shape({ filename: join(dir, "f.mx"), dialect: DIALECT })).toEqual([
      ["MxTag", ["MxText"]],
    ]);
    // MX's own file has no `raw` contract: `<b>` is a tag.
    expect(shape({ filename: join(dir, "f.mx") })).toEqual([
      ["MxTag", ["MxTag"]],
    ]);
  });
});

/** The dialect's two contracts: `sealed` reserved, `plain` a default. */
const RANKED_MODULE = `module.exports = { default: { table: {}, contracts: {
  sealed: { attributes: { k: { type: "string", required: true } } },
  plain: { attributes: { k: { type: "string", required: true } } },
} } };`;

/** A project definition of a name: `other` allowed, `k` not required. */
const LOOSE = '{ attributes: { other: { type: "string" } } }';

/** The diagnostics' code, message, line and column (and file when elsewhere). */
const brief = (diagnostics: readonly object[]) =>
  diagnostics.map((diagnostic) => {
    const { code, message, line, column, file } = diagnostic as {
      code?: string;
      message: string;
      line: number;
      column: number;
      file?: string;
    };
    return {
      code,
      message,
      line,
      column,
      ...(file === undefined ? {} : { file }),
    };
  });

describe("R3: precedence, one fixture per source", () => {
  const page = () => join(dir, "page.lexi.mx");
  const scanPage = () => scanCustomTags(page(), { targets });
  const lowerPage = (source: string, options: LowerSourceOptions = {}) =>
    lowerSource(source, page(), {
      customTags: scanPage().customTags,
      ...options,
    });
  const MISSING_K = (name: string) => ({
    code: undefined,
    message: `\`<${name}>\`: missing required attribute \`k\``,
    line: 1,
    column: 0,
  });

  describe("a reserved contract beats every project source, which gets MX_RESERVED_TAG", () => {
    it("a tag file", () => {
      lexiProject(RANKED_MODULE);
      write("tags/sealed.mx", "<div/>\n");
      expect(brief(scanPage().diagnostics)).toEqual([
        {
          code: RESERVED_CODE,
          message:
            "`<sealed>` cannot be defined by a tag file: Lexi reserves it",
          line: 1,
          column: 0,
          file: join(dir, "tags/sealed.mx"),
        },
      ]);
      // The call is checked against the dialect's contract.
      expect(brief(lowerPage("<sealed/>\n").diagnostics)).toEqual([
        MISSING_K("sealed"),
      ]);
    });

    it("an `mx.tags` entry", () => {
      lexiProject(RANKED_MODULE, { mx: { tags: ["shared"] } });
      write("shared/sealed.mx", "<div/>\n");
      const diagnostics = scanPage().diagnostics;
      expect(diagnostics.map((d) => [d.code, d.file])).toEqual([
        [RESERVED_CODE, join(dir, "package.json")],
      ]);
      expect(diagnostics[0]?.message).toBe(
        `\`<sealed>\` cannot be defined by a tag file: Lexi reserves it (${join(dir, "shared/sealed.mx")})`,
      );
      expect(brief(lowerPage("<sealed/>\n").diagnostics)).toEqual([
        MISSING_K("sealed"),
      ]);
    });

    it("an `mx.contracts` entry", () => {
      write("contracts.ts", `export default {\n  sealed: ${LOOSE},\n};\n`);
      lexiProject(RANKED_MODULE, { mx: { contracts: "./contracts.ts" } });
      expect(brief(scanPage().diagnostics)).toEqual([
        {
          code: RESERVED_CODE,
          message:
            "`<sealed>` cannot be defined by `mx.contracts`: Lexi reserves it",
          line: 2,
          column: 2,
          file: join(dir, "contracts.ts"),
        },
      ]);
      expect(brief(lowerPage("<sealed/>\n").diagnostics)).toEqual([
        MISSING_K("sealed"),
      ]);
    });

    it("routed `customTags`: refused at the call, which the dialect's contract then checks", () => {
      lexiProject(RANKED_MODULE);
      const loose: CustomTag = { attributes: { other: { type: "string" } } };
      const result = lowerSource("<sealed/>\n", page(), {
        customTags: { sealed: loose },
      });
      expect(brief(result.diagnostics)).toEqual([
        {
          code: RESERVED_CODE,
          message:
            "`<sealed>` cannot be defined by `customTags`: Lexi reserves it",
          line: 1,
          column: 0,
        },
        MISSING_K("sealed"),
      ]);
    });
  });

  describe("a project definition replaces a non-reserved contract, with no diagnostic", () => {
    it("a tag file", () => {
      lexiProject(RANKED_MODULE);
      write("tags/plain.tag.ts", `export default ${LOOSE};\n`);
      expect(scanPage().diagnostics).toEqual([]);
      expect(lowerPage('<plain other="x"/>\n').diagnostics).toEqual([]);
    });

    it("an `mx.tags` entry", () => {
      lexiProject(RANKED_MODULE, { mx: { tags: ["shared"] } });
      write("shared/plain.tag.ts", `export default ${LOOSE};\n`);
      expect(scanPage().diagnostics).toEqual([]);
      expect(lowerPage('<plain other="x"/>\n').diagnostics).toEqual([]);
    });

    it("an `mx.contracts` entry", () => {
      write("contracts.ts", `export default {\n  plain: ${LOOSE},\n};\n`);
      lexiProject(RANKED_MODULE, { mx: { contracts: "./contracts.ts" } });
      expect(scanPage().diagnostics).toEqual([]);
      expect(lowerPage('<plain other="x"/>\n').diagnostics).toEqual([]);
    });

    it("routed `customTags`", () => {
      lexiProject(RANKED_MODULE);
      const result = lowerSource('<plain other="x"/>\n', page(), {
        customTags: { plain: { attributes: { other: { type: "string" } } } },
      });
      expect(result.diagnostics).toEqual([]);
    });

    it("without a project definition the dialect's contract applies", () => {
      lexiProject(RANKED_MODULE);
      expect(brief(lowerPage("<plain/>\n").diagnostics)).toEqual([
        MISSING_K("plain"),
      ]);
    });
  });

  it("with an explicit dialect, `customTags` override every contract, reserved or not, silently", () => {
    const strict: CustomTag = {
      attributes: { k: { type: "string", required: true } },
    };
    const loose: CustomTag = { attributes: { other: { type: "string" } } };
    const dialect = {
      id: "lexi",
      name: "Lexi",
      table: {},
      contracts: { sealed: strict, plain: strict },
    };
    const result = lowerSource(
      '<sealed other="x"/>\n<plain other="x"/>\n',
      join(dir, "page.lexi.mx"),
      { dialect, customTags: { sealed: loose, plain: loose } },
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("routed `compileSource`: a passed `customTags` replaces a non-reserved contract, never a reserved one", () => {
    // A template compiler needs a `transform` on every tag it calls.
    lexiProject(
      RANKED_MODULE.replaceAll("} } },", "} }, transform: () => [] },"),
    );
    const loose: CustomTag = {
      attributes: { other: { type: "string" } },
      transform: () => [],
    };
    const compile = (source: string) => {
      try {
        compileSource(source, page(), policy, {
          targets: lookup,
          tagDiscoveryDirs: [],
          emitIr: () => "",
          customTags: { sealed: loose, plain: loose },
        });
        return undefined;
      } catch (error) {
        return isTranslateError(error) ? error.message : String(error);
      }
    };
    expect(compile('<plain other="x"/>\n')).toBeUndefined();
    expect(compile('<sealed other="x"/>\n')).toBe(
      "`<sealed>`: unknown attribute `other`",
    );
  });

  it("the routed dialect passed as the explicit `dialect`: `customTags` still override its reserved contracts", () => {
    lexiProject(RANKED_MODULE);
    const { dialect } = resolveSyntaxOf(page());
    expect(dialect?.contracts).toBeDefined();
    const loose: CustomTag = { attributes: { other: { type: "string" } } };
    const source = '<sealed other="x"/>\n';
    // Routed, the reserved contract wins over the caller's definition.
    expect(
      brief(
        lowerSource(source, page(), { customTags: { sealed: loose } })
          .diagnostics,
      ).map((d) => (d as { code?: string }).code),
    ).toEqual([RESERVED_CODE, undefined]);
    // Explicit, the same dialect object's caller owns the vocabulary.
    expect(
      lowerSource(source, page(), {
        dialect: dialect as NonNullable<typeof dialect>,
        customTags: { sealed: loose },
      }).diagnostics,
    ).toEqual([]);
  });

  it("a file-local capitalized binding wins over a dialect contract of its name", () => {
    const dialect = {
      id: "lexi",
      name: "Lexi",
      table: {},
      contracts: {
        Card: {
          attributes: { k: { type: "string" as const, required: true } },
        },
      },
    };
    const bound = lowerSource("<const/Card=1/>\n<Card/>\n", "/v/p.mx", {
      dialect,
    });
    // The binding names a dynamic tag, which a data file refuses: the
    // contract is never consulted.
    expect(brief(bound.diagnostics)).toEqual([
      {
        code: undefined,
        message:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: MX syntax in a message.
          "a dynamic tag (`<${expr}>`) has no name; the data tree is static and needs one",
        line: 2,
        column: 0,
      },
    ]);
    const unbound = lowerSource("<Card/>\n", "/v/p.mx", { dialect });
    expect(brief(unbound.diagnostics)).toEqual([MISSING_K("Card")]);
  });
});

describe("R4: a contract that cannot register fails the dialect at load", () => {
  /**
   * A project whose dialect is a workspace package linked into
   * `node_modules` (so its module may be TypeScript), with `index.ts`
   * holding `source`. Returns the module's path.
   */
  function moduleProject(source: string): string {
    const packageDir = join(dir, "packages", "lexi");
    write(
      "packages/lexi/package.json",
      JSON.stringify({
        name: "lexi-dialect",
        mx: { dialect: { ...LEXI, module: "./index.ts" } },
      }),
    );
    const module = write("packages/lexi/index.ts", source);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(packageDir, join(dir, "node_modules", "lexi-dialect"));
    write(
      "package.json",
      JSON.stringify({
        name: "app",
        devDependencies: { "lexi-dialect": "0.0.0" },
      }),
    );
    return module;
  }
  /** What every file of the dialect reports. */
  const reported = () =>
    lowerSource("<p/>\n", join(dir, "page.lexi.mx")).diagnostics.map(
      ({ code, message, line, column, offset, file }) => ({
        code,
        message,
        line,
        column,
        offset,
        file,
      }),
    );
  const at = (
    module: string,
    message: string,
    line: number,
    column: number,
    code = CODE,
  ) => [{ code, message, line, column, offset: -1, file: module }];
  const RESERVED = (name: string) =>
    `\`<${name}>\` cannot name a data tag: it is reserved — core consumes the structural names (\`if\`, \`else\`, \`else-if\`, \`for\`, \`const\`, \`define\`, \`return\`, \`import\`, \`export\`, \`static\`) and \`<try>\` before a target sees them`;

  it("is the code core names", () => {
    expect(INVALID_DIALECT_CONTRACT_CODE).toBe(CODE);
  });

  it.each(["if", "try"])("a core reserved name, `%s`, at its key", (name) => {
    const module = moduleProject(
      `export default {\n  table: {},\n  contracts: {\n    box: {},\n    "${name}": { attributes: {} },\n  },\n};\n`,
    );
    expect(reported()).toEqual(
      at(module, `\`contracts.${name}\`: ${RESERVED(name)}`, 5, 4),
    );
  });

  it("`template`", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: { template: {} } } };\n",
    );
    expect(reported()).toEqual(
      at(
        module,
        "`contracts.box`: `template` is not allowed in a dialect contract: a tag with a template is a tag file",
        1,
        41,
      ),
    );
  });

  it("an unknown key, and `declares` when no module claims it", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: { colour: 1 } } };\n",
    );
    expect(reported()).toEqual(
      at(
        module,
        "`contracts.box`: `colour` is not a contract key (parseOptions, attributes, attributeTags, children, parents, defaultTag, analyze, transform, finalize, or a key the dialect claims in `contractFields.tag`)",
        1,
        41,
      ),
    );
  });

  it("`declares` without a claim", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: { declares: 1 } } };\n",
    );
    expect(reported()).toEqual(
      at(
        module,
        "`contracts.box`: `declares` is not allowed: no syntax module claims it (`contractFields`)",
        1,
        41,
      ),
    );
  });

  it("a key the dialect claims is accepted", () => {
    moduleProject(
      'export default { table: {}, contractFields: { tag: ["shape"] }, contracts: { box: { shape: "round" } } };\n',
    );
    expect(reported()).toEqual([]);
  });

  it("bad `parseOptions`", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: { parseOptions: { wrap: true } } } };\n",
    );
    expect(reported()).toEqual(
      at(
        module,
        "`contracts.box`: `parseOptions.wrap` is not a parse option; expected `text`, `preserveWhitespace` or `openTagOnly`",
        1,
        41,
      ),
    );
  });

  it("a hook that is not a function", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: { analyze: 1 } } };\n",
    );
    expect(reported()).toEqual(
      at(module, "`contracts.box`: `analyze` must be a function", 1, 41),
    );
  });

  it("an unreachable `finalize`", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: { finalize: () => [] } } };\n",
    );
    expect(reported()).toEqual(
      at(
        module,
        "`contracts.box`: `<box>`: a custom tag that defines only `finalize` has no call site and nothing to collect; add a `transform`, an `analyze` or a template file",
        1,
        41,
      ),
    );
  });

  it("a declaration core refuses", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: { attributes: { a: { kind: 1 } } } } };\n",
    );
    const [first] = reported();
    expect(first).toMatchObject({ code: CODE, line: 1, column: 41 });
    expect(first?.file).toBe(module);
    expect(first?.message).toBe(
      '`contracts.box`: Unknown key "kind" in the "a" attribute declaration of tag "box"; allowed: type, items, required, enum, default, literalOnly',
    );
  });

  it("not a tag name", () => {
    const module = moduleProject(
      'export default { table: {}, contracts: { "a b": {} } };\n',
    );
    expect(reported()).toEqual(
      at(
        module,
        "`contracts.a b`: `a b` is not a tag name; a tag name starts with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots",
        1,
        41,
      ),
    );
  });

  it("an entry that is not a plain object", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: { box: [] } };\n",
    );
    expect(reported()).toEqual(
      at(module, "`contracts.box` must be a plain CustomTag object", 1, 41),
    );
  });

  it("`contracts` that is not a plain object, at the field", () => {
    const module = moduleProject(
      "export default { table: {}, contracts: [] };\n",
    );
    expect(reported()).toEqual(
      at(
        module,
        "`contracts` must be a plain object of tag contracts by tag name (a `ContractMap`)",
        1,
        28,
      ),
    );
  });

  describe("the dialect's `checkContract`", () => {
    const source = (fail: string) =>
      `export default {\n  table: {},\n  contractFields: { tag: ["shape"] },\n  checkContract(tag, contract, ctx) {\n    ${fail}\n  },\n  contracts: {\n    box: { shape: "square" },\n  },\n};\n`;
    it("its code wins", () => {
      const module = moduleProject(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source text for a fixture module.
        source('ctx.fail(`${tag} cannot be square`, { code: "LEXI_SHAPE" });'),
      );
      expect(reported()).toEqual(
        at(module, "`contracts.box`: box cannot be square", 8, 4, "LEXI_SHAPE"),
      );
    });
    it("without a code, the dialect-contract code", () => {
      const module = moduleProject(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source text for a fixture module.
        source("ctx.fail(`${tag} cannot be square`);"),
      );
      expect(reported()).toEqual(
        at(module, "`contracts.box`: box cannot be square", 8, 4),
      );
    });
  });

  describe("where the error points", () => {
    const MESSAGE = `\`contracts.if\`: ${RESERVED("if")}`;
    it("a `satisfies` literal", () => {
      const module = moduleProject(
        "export default {\n  table: {},\n  contracts: {\n    if: {},\n  } satisfies Record<string, object>,\n} satisfies object;\n",
      );
      expect(reported()).toEqual(at(module, MESSAGE, 4, 4));
    });
    it("an identifier bound to a literal", () => {
      const module = moduleProject(
        "const contracts = {\n  box: {},\n  if: {},\n};\nconst dialect = { table: {}, contracts };\nexport default dialect;\n",
      );
      expect(reported()).toEqual(at(module, MESSAGE, 3, 2));
    });
    it("a `contracts` built at run time: the module's 1:0", () => {
      const module = moduleProject(
        'const contracts = Object.fromEntries([["if", {}]]);\nexport default { table: {}, contracts };\n',
      );
      expect(reported()).toEqual(at(module, MESSAGE, 1, 0));
    });
    it("a CommonJS module: 1:0", () => {
      const { packageDir } = lexiProject(
        "module.exports = { default: { table: {}, contracts: { if: {} } } };",
      );
      expect(reported()).toEqual(
        at(join(packageDir, "index.cjs"), MESSAGE, 1, 0),
      );
    });
  });

  it("the explicit option: the caller's wording at the file's 1:0, with the code", () => {
    const result = lowerSource("<p/>\n", "/v/page.mx", {
      dialect: { id: "lexi", name: "Lexi", table: {}, contracts: { if: {} } },
    });
    expect(
      result.diagnostics.map(
        ({ code, message, line, column, offset, file }) => ({
          code,
          message,
          line,
          column,
          offset,
          file,
        }),
      ),
    ).toEqual([
      {
        code: CODE,
        message: `the \`dialect\` option is not a valid dialect: \`dialect.contracts.if\`: ${RESERVED("if")}`,
        line: 1,
        column: 0,
        offset: 0,
        file: undefined,
      },
    ]);
  });
});

describe("R5: a dialect's reserved contract is refused everywhere exactly as core's `try`", () => {
  const TRIAL_MODULE = `module.exports = { default: { table: {}, contracts: {
  trial: { attributes: { k: { type: "string", required: true } } },
} } };`;
  const TRIAL_FIELDS = { reservedTags: ["trial"] };
  /** The refusals' shape, without the wording (core's names core, Lexi's names Lexi). */
  const shape = (diagnostics: readonly object[], root: string) =>
    (
      diagnostics as Array<{
        code?: string;
        severity: string;
        line: number;
        column: number;
        file?: string;
      }>
    )
      .filter((d) => d.code === RESERVED_CODE)
      .map(({ code, severity, line, column, file }) => ({
        code,
        severity,
        line,
        column,
        file: file
          ?.split(root)
          .join("<root>")
          .replace(/\/(try|trial)\.mx$/, "/<name>.mx"),
      }));
  const roots = () => ({ core: join(dir, "core"), lexi: join(dir, "lexi") });

  /** Both projects, `core` defining `try` and `lexi` defining `trial`, from `define`. */
  function both(
    mx: unknown,
    define: (root: string, name: "try" | "trial") => void,
  ) {
    const { core, lexi } = roots();
    for (const [root, name] of [
      [core, "try"],
      [lexi, "trial"],
    ] as const) {
      lexiProject(TRIAL_MODULE, { root, mx, fields: TRIAL_FIELDS });
      define(root, name);
    }
    const scanOf = (file: string) => scanCustomTags(file, { targets });
    return {
      core: scanOf(join(core, "page.mx")),
      lexi: scanOf(join(lexi, "page.lexi.mx")),
    };
  }

  it.each([
    [
      "a tag file",
      undefined,
      (root: string, name: string) =>
        write(`tags/${name}.mx`, "<div/>\n", root),
    ],
    [
      "an `mx.tags` entry",
      { tags: ["shared"] },
      (root: string, name: string) =>
        write(`shared/${name}.mx`, "<div/>\n", root),
    ],
    [
      "an `mx.contracts` entry",
      { contracts: "./contracts.ts" },
      (root: string, name: string) =>
        write(
          "contracts.ts",
          `export default {\n  ${name}: ${LOOSE},\n};\n`,
          root,
        ),
    ],
  ] as const)("%s", (_, mx, define) => {
    const { core, lexi } = both(mx, define);
    const { core: coreRoot, lexi: lexiRoot } = roots();
    expect(shape(lexi.diagnostics, lexiRoot)).toEqual(
      shape(core.diagnostics, coreRoot),
    );
    expect(shape(lexi.diagnostics, lexiRoot)).toHaveLength(1);
    expect(Object.keys(lexi.customTags)).not.toContain("trial");
    expect(Object.keys(core.customTags)).not.toContain("try");
  });

  it("routed `customTags`", () => {
    const { core, lexi } = roots();
    lexiProject(TRIAL_MODULE, { root: core, fields: TRIAL_FIELDS });
    lexiProject(TRIAL_MODULE, { root: lexi, fields: TRIAL_FIELDS });
    const loose: CustomTag = { attributes: {} };
    const ofCore = lowerSource("<try/>\n", join(core, "page.mx"), {
      customTags: { try: loose },
    });
    const ofLexi = lowerSource("<trial/>\n", join(lexi, "page.lexi.mx"), {
      customTags: { trial: loose },
    });
    expect(shape(ofLexi.diagnostics, lexi)).toEqual(
      shape(ofCore.diagnostics, core),
    );
    expect(shape(ofLexi.diagnostics, lexi)).toHaveLength(1);
    // And the call keeps the owner's contract.
    expect(brief(ofLexi.diagnostics)[1]).toEqual({
      code: undefined,
      message: "`<trial>`: missing required attribute `k`",
      line: 1,
      column: 0,
    });
  });
});

describe("R6: freshness", () => {
  let tick = 0;
  /** Rewrites `file` with a later mtime, so a same-tick edit still reads as one. */
  function edit(file: string, text: string): void {
    writeFileSync(file, text);
    tick += 10;
    const later = statSync(file).mtimeMs / 1000 + tick;
    utimesSync(file, later, later);
  }
  const state = () =>
    globalThis as unknown as { __lexiReads?: number; __lexiDerived?: number };
  beforeEach(() => {
    state().__lexiReads = 0;
    state().__lexiDerived = 0;
  });

  /** A module whose `contracts` getter counts each validation that reads it. */
  const counted = (name: string) => `module.exports = { default: {
  table: {},
  get contracts() {
    globalThis.__lexiReads += 1;
    return { ${JSON.stringify(name)}: { attributes: { k: { type: "string", required: true } } } };
  },
} };`;
  const page = () => join(dir, "page.lexi.mx");
  const messages = () =>
    lowerSource("<box/>\n", page()).diagnostics.map((d) => d.message);
  const RESERVED_IF = expect.stringMatching(
    /^`contracts\.if`: `<if>` cannot name a data tag/,
  );

  it("registration does not re-check a contract the load validated: `checkContract` runs once per module revision", () => {
    const checking = (shape: string) => `module.exports = { default: {
  table: {},
  contractFields: { attribute: ["shape"] },
  checkContract() { globalThis.__lexiChecks = (globalThis.__lexiChecks ?? 0) + 1; },
  contracts: { box: { attributes: { k: { type: "string", required: true, shape: ${JSON.stringify(shape)} } } } },
} };`;
    const checks = () =>
      (globalThis as unknown as { __lexiChecks?: number }).__lexiChecks ?? 0;
    (globalThis as unknown as { __lexiChecks?: number }).__lexiChecks = 0;
    const { packageDir } = lexiProject(checking("square"));
    // A fresh `customTags` map each time: a new merged map, a new registration.
    const lower = () =>
      lowerSource("<box/>\n", page(), {
        customTags: { other: {} },
      }).diagnostics.map((d) => d.message);
    expect(lower()).toEqual(["`<box>`: missing required attribute `k`"]);
    expect(lower()).toEqual(["`<box>`: missing required attribute `k`"]);
    expect(lower()).toEqual(["`<box>`: missing required attribute `k`"]);
    expect(checks()).toBe(1);
    edit(join(packageDir, "index.cjs"), checking("round"));
    expect(lower()).toEqual(["`<box>`: missing required attribute `k`"]);
    expect(lower()).toEqual(["`<box>`: missing required attribute `k`"]);
    expect(checks()).toBe(2);
    // The same object registered where no dialect claims `shape` is checked
    // as any definition: the mark holds only under the dialect's claim.
    const box = resolveSyntaxOf(page()).dialect?.contracts?.box as CustomTag;
    expect(
      lowerSource("<box/>\n", join(dir, "p.mx"), {
        customTags: { box },
      }).diagnostics.map((d) => d.message),
    ).toEqual([
      'Unknown key "shape" in the "k" attribute declaration of tag "box"; allowed: type, items, required, enum, default, literalOnly',
    ]);
  });

  it("a module edit re-validates; an unchanged module is validated once", () => {
    const { packageDir } = lexiProject(counted("box"));
    const module = join(packageDir, "index.cjs");
    expect(messages()).toEqual(["`<box>`: missing required attribute `k`"]);
    expect(messages()).toEqual(["`<box>`: missing required attribute `k`"]);
    const reads = state().__lexiReads;
    expect(reads).toBeGreaterThan(0);
    lowerSource("<box/>\n", page());
    expect(state().__lexiReads).toBe(reads);
    edit(module, counted("if"));
    expect(messages()).toEqual([RESERVED_IF]);
    edit(module, counted("box"));
    expect(messages()).toEqual(["`<box>`: missing required attribute `k`"]);
  });

  it("a load failure stays cached until the module is edited", () => {
    const { packageDir } = lexiProject(counted("if"));
    const module = join(packageDir, "index.cjs");
    const first = lowerSource("<box/>\n", page()).diagnostics;
    expect(first.map((d) => [d.code, d.file, d.message])).toEqual([
      [CODE, module, RESERVED_IF],
    ]);
    const reads = state().__lexiReads;
    // Every later file reports the same error without validating again.
    expect(lowerSource("<box/>\n", page()).diagnostics).toEqual(first);
    expect(
      lowerSource("<p/>\n", join(dir, "other.lexi.mx")).diagnostics,
    ).toEqual(first);
    expect(state().__lexiReads).toBe(reads);
    edit(module, counted("box"));
    expect(messages()).toEqual(["`<box>`: missing required attribute `k`"]);
  });

  it("the scan stamps the module: an edit makes the cached scan stale", () => {
    const { packageDir } = lexiProject(counted("box"));
    const module = join(packageDir, "index.cjs");
    const first = scanCached(page(), { targets });
    expect(first.files.map((file) => file.path)).toContain(module);
    expect(scanCached(page(), { targets })).toBe(first);
    edit(module, counted("box"));
    expect(scanCached(page(), { targets })).not.toBe(first);
  });

  it("a module that failed is stamped too: fixing it re-scans", () => {
    const { packageDir } = lexiProject(counted("if"));
    const module = join(packageDir, "index.cjs");
    const first = scanCached(page(), { targets });
    expect(first.files.map((file) => file.path)).toContain(module);
    expect(scanCached(page(), { targets })).toBe(first);
    edit(module, counted("box"));
    expect(scanCached(page(), { targets })).not.toBe(first);
  });

  it("an MX file's scan does not stamp a dialect module", () => {
    const { packageDir } = lexiProject(counted("box"));
    const files = scanCached(join(dir, "page.mx"), { targets }).files;
    expect(files.map((file) => file.path)).not.toContain(
      join(packageDir, "index.cjs"),
    );
  });

  it("a module edit re-derives the dialect's tag files", () => {
    const derived = (attribute: string) => `module.exports = { default: {
  table: {},
  tagFile() {
    globalThis.__lexiDerived += 1;
    return { contract: { attributes: { ${attribute}: { type: "string", required: true } } }, diagnostics: [] };
  },
} };`;
    const { packageDir } = lexiProject(derived("a"), {
      fields: { tagDirs: ["parts"] },
    });
    write("parts/card.lexi.mx", "");
    const lowered = () =>
      lowerSource("<card/>\n", page(), {
        customTags: scanCached(page(), { targets }).customTags,
      }).diagnostics.map((d) => d.message);
    expect(lowered()).toEqual(["`<card>`: missing required attribute `a`"]);
    edit(join(packageDir, "index.cjs"), derived("b"));
    expect(lowered()).toEqual(["`<card>`: missing required attribute `b`"]);
    expect(state().__lexiDerived).toBe(2);
  });
});

describe("R8: a front end's vocabulary moves from `customTags` to `Dialect.contracts` unchanged", () => {
  const CLOSED: LowerSourceOptions = {
    structural: "reject",
    unknownTags: "reject",
    imports: "pass",
  };
  const SOURCES = {
    ...CALLS,
    unknown: "<widget/>\n",
    structural: "<if=true><item/></if>\n",
  };
  it.each(Object.entries(SOURCES))("%s", (_, source) => {
    const { vocab } = vocabAt(dir);
    const base = { id: "lexi", name: "Lexi", table: {} };
    const file = join(dir, "entity.lexi.mx");
    const before = lowerSource(source, file, {
      ...CLOSED,
      dialect: base,
      customTags: vocab,
    });
    const after = lowerSource(source, file, {
      ...CLOSED,
      dialect: { ...base, contracts: vocab },
    });
    expect(after).toEqual(before);
  });

  it("the closed vocabulary still refuses an unknown tag", () => {
    const { vocab } = vocabAt(dir);
    const result = lowerSource("<widget/>\n", join(dir, "e.lexi.mx"), {
      ...CLOSED,
      dialect: { id: "lexi", name: "Lexi", table: {}, contracts: vocab },
    });
    expect(result.diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      ["MX_UNKNOWN_TAG", 1, 0],
    ]);
  });
});

describe("R9: `mxConfigTags`, through the scan and the IR entry", () => {
  const PLAIN_MODULE = "module.exports = { default: { table: {} } };";
  const page = (name = "page.lexi.mx") => join(dir, name);
  /** A project with one definition from each source: `a` (mx.tags), `b` (mx.contracts), `c` (tags/). */
  function sources(fields: Record<string, unknown>, inConfigFile = false) {
    const mx = { tags: ["shared"], contracts: "./contracts.ts" };
    const project = lexiProject(PLAIN_MODULE, {
      fields,
      ...(inConfigFile ? {} : { mx }),
    });
    if (inConfigFile) write("mx.config.json", JSON.stringify(mx));
    write("shared/a.tag.ts", `export default ${LOOSE};\n`);
    write("contracts.ts", `export default {\n  b: ${LOOSE},\n};\n`);
    write("tags/c.tag.ts", `export default ${LOOSE};\n`);
    return project;
  }
  const names = (file: string) =>
    Object.keys(scanCached(file, { targets }).customTags).sort();
  /** Each name's call in a closed file, lowered with the scan's tags. */
  const unknownOf = (file: string) =>
    lowerSource('<a other="x"/>\n<b other="x"/>\n<c other="x"/>\n', file, {
      customTags: scanCached(file, { targets }).customTags,
      unknownTags: "reject",
    }).diagnostics.map((d) => [d.code, d.line]);

  it.each([
    ["`package.json#mx`", false],
    ["`mx.config.json`", true],
  ])(
    "`false` (%s): `mx.tags` and `mx.contracts` names are absent, silently; `tags/` still applies",
    (_, inConfigFile) => {
      sources({ mxConfigTags: false }, inConfigFile);
      expect(names(page())).toEqual(["c"]);
      expect(scanCached(page(), { targets }).diagnostics).toEqual([]);
      expect(unknownOf(page())).toEqual([
        ["MX_UNKNOWN_TAG", 1],
        ["MX_UNKNOWN_TAG", 2],
      ]);
      // MX's own file still reads the config.
      expect(names(page("page.mx"))).toEqual(["a", "b", "c"]);
      expect(unknownOf(page("page.mx"))).toEqual([]);
    },
  );

  it.each([
    ["`true`", { mxConfigTags: true }],
    ["absent", {}],
  ])("%s: every source applies", (_, fields) => {
    sources(fields);
    expect(names(page())).toEqual(["a", "b", "c"]);
    expect(unknownOf(page())).toEqual([]);
  });

  it("`false` with `tagDirs`: the dialect's directories still apply", () => {
    sources({ mxConfigTags: false, tagDirs: ["parts"] });
    write("parts/d.lexi.mx", "");
    expect(names(page())).toEqual(["d"]);
  });

  it("flipping the field re-scans", () => {
    const { packageFile } = sources({ mxConfigTags: false });
    expect(names(page())).toEqual(["c"]);
    const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
    manifest.mx.dialect.mxConfigTags = true;
    writeFileSync(packageFile, JSON.stringify(manifest, null, 2));
    const later = statSync(packageFile).mtimeMs / 1000 + 10;
    utimesSync(packageFile, later, later);
    expect(names(page())).toEqual(["a", "b", "c"]);
  });

  it("`false` still reports a `package.json` that does not parse", () => {
    const { projectFile } = sources({ mxConfigTags: false });
    expect(names(page())).toEqual(["c"]);
    writeFileSync(projectFile, "{ not json");
    const later = statSync(projectFile).mtimeMs / 1000 + 10;
    utimesSync(projectFile, later, later);
    const result = scanCached(page(), { targets });
    expect(result.diagnostics.map((d) => [d.file, d.message])).toEqual([
      [
        projectFile,
        expect.stringMatching(/^`package\.json` could not be parsed as JSON: /),
      ],
    ]);
  });

  it("a value that is not a boolean is an error at `mx.dialect.mxConfigTags`", () => {
    const { packageFile } = lexiProject(PLAIN_MODULE, {
      fields: { mxConfigTags: "no" },
    });
    const text = readFileSync(packageFile, "utf8");
    const offset = text.indexOf('"mxConfigTags"');
    const before = text.slice(0, offset);
    const result = lowerSource("<p/>\n", page());
    expect(
      result.diagnostics.map(({ message, line, column, file, offset }) => ({
        message,
        line,
        column,
        file,
        offset,
      })),
    ).toEqual([
      {
        message:
          "`mx.dialect.mxConfigTags` must be a boolean: whether the dialect's files take tag definitions from the project's `mx.tags` and `mx.contracts`",
        line: before.split("\n").length,
        column: offset - (before.lastIndexOf("\n") + 1),
        file: packageFile,
        offset: -1,
      },
    ]);
  });
});

describe("the merge is memoized per dialect and `customTags` map", () => {
  const strict: CustomTag = {
    attributes: { k: { type: "string", required: true } },
  };
  const dialect = {
    id: "lexi",
    name: "Lexi",
    table: {},
    contracts: { plain: strict },
  };

  it("the same inputs give the same merged map, so caches keyed on it stay warm", () => {
    const tags: Record<string, CustomTag> = { other: {} };
    const merged = dialectCustomTags(tags, dialect, false);
    expect(merged).not.toBe(tags);
    expect(Object.keys(merged ?? {})).toEqual(["plain", "other"]);
    expect(dialectCustomTags(tags, dialect, false)).toBe(merged);
    const none = dialectCustomTags(undefined, dialect, false);
    expect(dialectCustomTags(undefined, dialect, false)).toBe(none);
    // A routed and an explicit caller merge differently: two maps.
    expect(dialectCustomTags(tags, dialect, true)).not.toBe(merged);
    expect(dialectCustomTags({ ...tags }, dialect, false)).not.toBe(merged);
  });

  it("a merged map handed back in (`lowerSource`, then its compile) is used as is", () => {
    const merged = dialectCustomTags({ other: {} }, dialect, false);
    expect(dialectCustomTags(merged, dialect, false)).toBe(merged);
    expect(dialectCustomTags(merged, dialect, true)).toBe(merged);
  });

  it("a dialect without contracts leaves `customTags` alone", () => {
    const tags = { other: {} };
    expect(
      dialectCustomTags(tags, { ...dialect, contracts: undefined }, false),
    ).toBe(tags);
    expect(dialectCustomTags(tags, undefined, false)).toBe(tags);
  });
});
