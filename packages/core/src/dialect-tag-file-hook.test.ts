/**
 * Dialect tag files with a `tagFile` hook (dialect tag discovery, slice 2):
 * the dialect derives a tag's contract from its tag file, lazily, at the
 * first call, and the call gets exactly what a `tags/x.tag.ts` contract
 * would give it.
 *
 * The test dialect `kit` (claiming `.kit.mx`, scanning `concepts/` and
 * `components/`) is a fixture, not any real dialect. Its hook reads
 * directives from a leading `<!-- {json} -->` comment in the tag file: the
 * contract to return, files to `dependsOn`, whether to `ctx.lower()` the
 * file and forward its diagnostics, a throw, or a raw result. It counts its
 * runs per tag file on `globalThis.__kitTagFile`.
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
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withCalleeInputSources } from "./callee-input.ts";
import { compileSource } from "./compile.ts";
import { contractDefaultTagDiagnostics } from "./contract-default-tag.ts";
import { claimedFields } from "./contract-fields.ts";
import { isTranslateError } from "./core.ts";
import { registrationView } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { IrNode } from "./ir.ts";
import {
  type LowerSourceOptions,
  type LowerSourceResult,
  lowerSource,
} from "./ir-entry/index.ts";
import { discoverProjectTags, scanCustomTags } from "./scan.ts";
import { clearScanCache, scanCached } from "./scan-cache.ts";
import { clearTagFileCache, ownScanChecksForTests } from "./tag-file.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();

interface HookState {
  count: Record<string, number>;
}
const state = (): HookState =>
  (globalThis as unknown as { __kitTagFile: HookState }).__kitTagFile;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-tag-file-")));
  clearScanCache();
  clearTagFileCache();
  (globalThis as unknown as { __kitTagFile: HookState }).__kitTagFile = {
    count: {},
  };
});
afterEach(() => {
  clearScanCache();
  clearTagFileCache();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text = "<div/>\n"): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** The fixture dialect's module: `fields` are extra module fields (source text). */
function kitModule(fields = ""): string {
  return `
import { readFileSync } from "node:fs";
const BRAND = Symbol.for("mxTranslateError");
function positioned(message, line, column, endLine, endColumn) {
  const error = new Error(message);
  error.name = "TranslateError";
  error.line = line;
  error.column = column;
  if (endLine !== undefined) error.end = { line: endLine, column: endColumn };
  Object.defineProperty(error, BRAND, { value: true });
  return error;
}
export default {
  table: {},
  ${fields}
  tagFile(file, ctx) {
    const state = globalThis.__kitTagFile;
    const base = file.path.slice(file.path.lastIndexOf("/") + 1);
    state.count[base] = (state.count[base] ?? 0) + 1;
    state.lastInput = { ...file };
    const head = /^<!--([\\s\\S]*?)-->/.exec(file.source);
    const d = head ? JSON.parse(head[1]) : {};
    for (const path of d.dependsOn ?? []) ctx.dependsOn(path);
    if (d.throw !== undefined) {
      throw d.throwAt ? positioned(d.throw, ...d.throwAt) : new Error(d.throw);
    }
    if ("result" in d) return d.result;
    if (d.contractFrom) {
      ctx.dependsOn(d.contractFrom);
      const at = file.path.slice(0, file.path.lastIndexOf("/") + 1);
      d.contract = JSON.parse(readFileSync(at + d.contractFrom, "utf8"));
    }
    const diagnostics = [...(d.diagnostics ?? [])];
    if (d.lower) {
      const lowered = ctx.lower();
      if (d.lowerTwice && ctx.lower() !== lowered) throw new Error("not memoized");
      // \`lower: true\` passes on the objects \`ctx.lower\` returned. "copy" and
      // "reword" pass on a copy of each, the second with a message of its own;
      // "inplace" and "forge" change the object itself, its message and then
      // its code.
      for (const x of lowered.diagnostics) {
        if (d.lower === "copy") diagnostics.push({ ...x });
        else if (d.lower === "reword") diagnostics.push({ ...x, message: "x" });
        else if (d.lower === "inplace") {
          diagnostics.push(Object.assign(x, { message: "hook words" }));
        } else if (d.lower === "forge") {
          diagnostics.push(
            Object.assign(x, { code: "MX_INTERNAL_ERROR", message: "forged" }),
          );
        } else diagnostics.push(x);
      }
    }
    return { contract: d.contract ?? {}, diagnostics };
  },
};
`;
}

const KIT = {
  id: "kit",
  name: "Kit",
  extensions: [".kit.mx"],
  tagDirs: ["concepts", "components"],
};

function kitProject(fields = "", mx?: unknown) {
  return dialectProject(dir, {
    packageName: "kit-dialect",
    manifest: KIT,
    module: kitModule(fields),
    ...(mx === undefined ? {} : { mx }),
  });
}

/** Writes `concepts/<name>.kit.mx` with `directives` in its head comment, then `body`. */
function tagFile(
  name: string,
  directives: unknown,
  body = "",
  where = "concepts",
) {
  return write(
    `${where}/${name}.kit.mx`,
    `<!-- ${JSON.stringify(directives)} -->\n${body}`,
  );
}

function lowerAt(
  page: string,
  source: string,
  options: Omit<LowerSourceOptions, "customTags"> = {},
): LowerSourceResult {
  const file = join(dir, page);
  const { customTags } = scanCached(file, { targets });
  return lowerSource(source, file, { ...options, customTags });
}

const brief = (result: LowerSourceResult) =>
  result.diagnostics.map(({ message, line, column, code, file }) => ({
    message,
    line,
    column,
    ...(code === undefined ? {} : { code }),
    ...(file === undefined ? {} : { file: relative(dir, file) }),
  }));

const count = (base: string) => state().count[base] ?? 0;

/** `value` with every `definedIn` removed, at any depth. */
function withoutDefinedIn<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, field) =>
      key === "definedIn" ? undefined : field,
    ),
  );
}

function delegatedTags(nodes: readonly IrNode[] | undefined): IrNode[] {
  const out: IrNode[] = [];
  const walk = (list: readonly IrNode[]) => {
    for (const node of list) {
      if (node.kind === "DelegatedTag") out.push(node);
      if ("children" in node && Array.isArray(node.children))
        walk(node.children as IrNode[]);
    }
  };
  walk(nodes ?? []);
  return out;
}

/**
 * The pin: `<money>` defined as `tags/money.tag.ts` (called from an `.mx`
 * data file) and as `concepts/money.kit.mx` (called from a `kit` file)
 * whose hook returns the identical contract. Same caller source on both
 * sides, so the whole diagnostic (position, offset, code) must match, and
 * the call's `DelegatedTag` must match apart from `definedIn`.
 */
describe("the pin: a derived contract behaves as the same `.tag.ts` contract", () => {
  function bothSides(contract: unknown) {
    kitProject();
    // Tags the contracts name, on both sides.
    for (const side of ["tags", "components"]) {
      write(`${side}/purse.tag.ts`, "export default {};\n");
      // `class` only: an unnamed tag resolved to `<coin>` takes `<.x>` and
      // refuses `<#y>`, which shows the default really resolved to it.
      write(
        `${side}/coin.tag.ts`,
        "export default { attributes: { class: {} } };\n",
      );
    }
    write("tags/money.tag.ts", `export default ${JSON.stringify(contract)};\n`);
    tagFile("money", { contract });
  }

  const ROWS: Array<[string, unknown, string[]]> = [
    [
      "attributes",
      {
        attributes: {
          amount: { type: "number", required: true },
          currency: { enum: ["usd", "eur"] },
        },
      },
      [
        '<money amount=5 currency="usd"/>\n',
        "<div>\n  <money amount=5 bogus=1/>\n</div>\n",
        "<money/>\n",
        '<money amount=1 currency="gbp"/>\n',
        '<money amount="x"/>\n',
      ],
    ],
    [
      "attributeTags",
      {
        attributeTags: {
          note: { required: true, attributes: { lang: { type: "string" } } },
        },
      },
      [
        '<money>\n  <@note lang="en">hi</@note>\n</money>\n',
        "<money/>\n",
        "<money>\n  <@note/>\n  <@bogus/>\n</money>\n",
        "<money>\n  <@note/>\n  <@note/>\n</money>\n",
        "<money>\n  <@note other=1/>\n</money>\n",
      ],
    ],
    [
      "children",
      { children: { coin: { required: true } } },
      [
        "<money>\n  <coin/>\n</money>\n",
        "<money/>\n",
        "<money>\n  <coin/>\n  <bill/>\n</money>\n",
        "<money>\n  <coin/>\n  <coin/>\n</money>\n",
      ],
    ],
    [
      "parents",
      { parents: ["purse"] },
      [
        "<purse>\n  <money/>\n</purse>\n",
        "<wallet>\n  <money/>\n</wallet>\n",
        "<money/>\n",
      ],
    ],
    [
      "defaultTag",
      { defaultTag: "coin" },
      [
        "<money>\n  <.x/>\n</money>\n",
        "<money>\n  <#y/>\n  <coin/>\n</money>\n",
      ],
    ],
    [
      "everything at once",
      {
        attributes: { amount: { type: "number" } },
        attributeTags: { note: {} },
        children: { coin: { repeatable: true } },
        parents: ["purse"],
        defaultTag: "coin",
      },
      [
        "<purse>\n  <money amount=2>\n    <@note/>\n    <coin/>\n    <.z/>\n  </money>\n</purse>\n",
        "<purse>\n  <money amount=2 x=1>\n    <bill/>\n  </money>\n</purse>\n",
      ],
    ],
  ];

  it.each(ROWS)("%s", (_, contract, sources) => {
    bothSides(contract);
    let bad = 0;
    for (const source of sources) {
      const eager = lowerAt("data.mx", source);
      const derived = lowerAt("page.kit.mx", source);
      expect(derived.diagnostics, source).toEqual(eager.diagnostics);
      expect(withoutDefinedIn(delegatedTags(derived.ir?.body)), source).toEqual(
        delegatedTags(eager.ir?.body),
      );
      if (eager.diagnostics.length > 0) bad++;
    }
    // Every row has its valid call first, and the rest really are bad.
    expect(lowerAt("data.mx", sources[0] as string).diagnostics).toEqual([]);
    expect(bad).toBe(sources.length - 1);
  });

  it("reject-mode unknown tags inside the call: same MX_UNKNOWN_TAG on both sides", () => {
    bothSides({ children: { coin: { repeatable: true } } });
    const source = "<money>\n  <coin/>\n  <wallet/>\n</money>\n";
    const eager = lowerAt("data.mx", source, { unknownTags: "reject" });
    const derived = lowerAt("page.kit.mx", source, { unknownTags: "reject" });
    expect(eager.diagnostics.map((d) => d.code)).toContain("MX_UNKNOWN_TAG");
    // The same error, but for the source it names: the `.mx` file was given
    // no contract for the tag, the dialect's file is not in the dialect.
    expect(eager.diagnostics.map((d) => d.message)).toEqual([
      "`<wallet>` is not a known tag: no contract for it was given",
    ]);
    expect(derived.diagnostics.map((d) => d.message)).toEqual([
      "`<wallet>` is not a known tag in the `kit` dialect",
    ]);
    expect(derived.diagnostics).toEqual(
      eager.diagnostics.map((d) => ({
        ...d,
        message: "`<wallet>` is not a known tag in the `kit` dialect",
      })),
    );
  });

  it("the derived call carries `definedIn`; the sidecar's does not", () => {
    bothSides({ attributes: { amount: {} } });
    const source = "<money amount=1/>\n";
    const [derived] = delegatedTags(lowerAt("page.kit.mx", source).ir?.body);
    const [eager] = delegatedTags(lowerAt("data.mx", source).ir?.body);
    expect(derived).toMatchObject({
      tag: { name: "money", definedIn: join(dir, "concepts/money.kit.mx") },
    });
    expect(eager).toMatchObject({ tag: { name: "money" } });
    expect((eager as { tag: object }).tag).not.toHaveProperty("definedIn");
  });

  describe("`defaultTag`: the registration check, at the derived contract's call", () => {
    const SOURCE = "<money>\n  <.x/>\n</money>\n";
    // The registration check is a host-policy diagnostic and keeps its own
    // `invalid-default-tag` code; the lowering's copy at the call carries the
    // catalogue's `MX_INVALID_DEFAULT_TAG`. The two sides agree on the text.
    const messages = (list: ReadonlyArray<{ message: string }>) =>
      list.map(({ message }) => message);

    /** The eager side's registration diagnostics (the registry's check). */
    function registration(
      host?: {
        name: string;
        kind: "host" | "target";
        allowContractDefaultTag?: boolean;
      },
      builtins: string[] = ["object"],
    ) {
      const scan = scanCached(join(dir, "data.mx"), { targets });
      return contractDefaultTagDiagnostics({
        tags: scan.tags,
        customTags: scan.customTags,
        scope: { customTags: scan.customTags, builtins },
        ...(host ? { host } : {}),
      });
    }

    it("a bad value: the same message, the eager one at its declaration, the derived one at the call", () => {
      bothSides({ defaultTag: "nowhere" });
      const eager = [
        ...registration(),
        ...lowerAt("data.mx", SOURCE).diagnostics,
      ];
      const derived = lowerAt("page.kit.mx", SOURCE);
      expect(messages(derived.diagnostics)).toEqual(messages(eager));
      expect(brief(derived)).toEqual([
        {
          message:
            "invalid `defaultTag` value: `<nowhere>` is not a tag reachable from this package (contract of `<money>`)",
          line: 1,
          column: 0,
          code: "MX_INVALID_DEFAULT_TAG",
        },
      ]);
    });

    it("a bad value on an attribute-tag declaration is checked too", () => {
      bothSides({ attributeTags: { note: { defaultTag: "nowhere" } } });
      const derived = lowerAt("page.kit.mx", "<money/>\n");
      expect(messages(derived.diagnostics)).toEqual(messages(registration()));
      expect(derived.diagnostics).toHaveLength(1);
    });

    /** A policy for `compileSource`, under the lookup's default target. */
    const policyWith = (extra: Partial<Policy>): Policy => ({
      tags: {},
      isElement: () => true,
      isComponent: () => false,
      isDelegatedTag: () => true,
      attrTags: 2,
      resolveDefaultTag: () => "div",
      ...extra,
    });

    /** `SOURCE` compiled at `page` under `policy`: its errors, or none. */
    function compileErrors(page: string, policy: Policy) {
      const file = join(dir, page);
      const { customTags } = scanCached(file, { targets });
      try {
        compileSource(SOURCE, file, policy, {
          customTags,
          targets,
          tagDiscoveryDirs: [],
          emitIr: () => "",
        });
        return [];
      } catch (error) {
        if (!isTranslateError(error)) throw error;
        return (error.errors ?? [error]).map((each) => ({
          message: each.message,
          code: each.diagnosticCode,
          line: each.line,
          column: each.column,
        }));
      }
    }

    it.each([
      ["the target's own default tag", "node", {}],
      [
        "a tag the host declares built in",
        "gadget",
        { builtinTags: ["gadget"] },
      ],
    ])("%s is reachable, on both sides", (_, value, extra) => {
      bothSides({ defaultTag: value });
      const policy = policyWith(extra);
      expect(
        registration(undefined, [value]).filter(
          (each) => each.code === "invalid-default-tag",
        ),
      ).toEqual([]);
      const eager = compileErrors("data.mx", policy);
      const derived = compileErrors("page.kit.mx", policy);
      expect(derived).toEqual(eager);
      expect(derived.map((each) => each.code)).not.toContain(
        "MX_INVALID_DEFAULT_TAG",
      );
    });

    it("every problem is reported, each at the call", () => {
      bothSides({
        defaultTag: "nowhere",
        attributeTags: { note: { defaultTag: "elsewhere" } },
      });
      const derived = brief(lowerAt("page.kit.mx", "<money/>\n"));
      expect(derived).toEqual([
        expect.objectContaining({
          line: 1,
          column: 0,
          code: "MX_INVALID_DEFAULT_TAG",
        }),
        expect.objectContaining({
          line: 1,
          column: 0,
          code: "MX_INVALID_DEFAULT_TAG",
        }),
      ]);
      expect(
        messages(lowerAt("page.kit.mx", "<money/>\n").diagnostics),
      ).toEqual(messages(registration()));
    });

    it("a host that forbids per-tag default tags refuses it, naming the target", () => {
      bothSides({ defaultTag: "coin" });
      const policy = policyWith({ allowContractDefaultTag: false });
      // `page` is the lookup's default target: these declarations are not a
      // descriptor's, so the default target answers for them.
      const eager = [
        ...registration({
          name: "page",
          kind: "target",
          allowContractDefaultTag: false,
        }),
        ...compileErrors("data.mx", policy),
      ];
      const derived = compileErrors("page.kit.mx", policy);
      expect(messages(derived)).toEqual(messages(eager));
      expect(derived).toEqual([
        {
          message:
            "`defaultTag` in the contract of `<money>` is not allowed: target `page` does not permit per-tag default tags",
          code: "MX_INVALID_DEFAULT_TAG",
          line: 1,
          column: 0,
        },
      ]);
    });
  });
});

describe("lazy derivation", () => {
  it("the scan never runs the hook; the first call does, once", () => {
    kitProject();
    tagFile("money", { contract: {} });
    const page = join(dir, "page.kit.mx");
    scanCustomTags(page, { targets });
    scanCached(page, { targets });
    discoverProjectTags(dir, { targets });
    expect(count("money.kit.mx")).toBe(0);
    expect(lowerAt("page.kit.mx", "<div/>\n").diagnostics).toEqual([]);
    expect(count("money.kit.mx")).toBe(0);
    expect(lowerAt("page.kit.mx", "<money/>\n<money/>\n").diagnostics).toEqual(
      [],
    );
    expect(count("money.kit.mx")).toBe(1);
  });

  it("the hook gets the file's path, text and the tag's name", () => {
    kitProject();
    const file = tagFile("money", { contract: {} }, "<x/>\n");
    lowerAt("page.kit.mx", "<money/>\n");
    expect((state() as unknown as { lastInput: unknown }).lastInput).toEqual({
      path: file,
      source: `<!-- {"contract":{}} -->\n<x/>\n`,
      name: "money",
    });
  });

  it("a second compile, and a new scan, hit the cache", () => {
    kitProject();
    tagFile("money", { contract: {} });
    lowerAt("page.kit.mx", "<money/>\n");
    lowerAt("page.kit.mx", "<money/>\n");
    clearScanCache();
    lowerAt("page.kit.mx", "<money/>\n");
    lowerAt("other.kit.mx", "<money/>\n");
    expect(count("money.kit.mx")).toBe(1);
  });

  it("an edit re-derives only the edited file", () => {
    kitProject();
    tagFile("money", { contract: {} });
    tagFile("coin", { contract: {} });
    const source = "<money/>\n<coin/>\n";
    expect(lowerAt("page.kit.mx", source).diagnostics).toEqual([]);
    tagFile("money", {
      contract: { attributes: { amount: { required: true } } },
    });
    expect(brief(lowerAt("page.kit.mx", source))).toEqual([
      {
        message: expect.stringContaining("amount"),
        line: 1,
        column: 0,
        code: "MX_MISSING_ATTRIBUTE",
      },
    ]);
    expect(count("money.kit.mx")).toBe(2);
    expect(count("coin.kit.mx")).toBe(1);
  });

  it("a reloaded dialect module re-derives (its revision is in the key)", () => {
    const { packageDir } = kitProject();
    tagFile("money", { contract: {} });
    lowerAt("page.kit.mx", "<money/>\n");
    const module = join(packageDir, "index.mjs");
    writeFileSync(module, `${kitModule()}\n// revision 2\n`);
    const later = Date.now() / 1000 + 10;
    utimesSync(module, later, later);
    lowerAt("page.kit.mx", "<money/>\n");
    expect(count("money.kit.mx")).toBe(2);
  });

  it("a new tag beside the tag file re-derives it (its own scan changed)", () => {
    kitProject();
    tagFile("money", { lower: true }, "<bill/>\n");
    lowerAt("page.kit.mx", "<money/>\n");
    write("components/bill.tag.ts", "export default {};\n");
    lowerAt("page.kit.mx", "<money/>\n");
    expect(count("money.kit.mx")).toBe(2);
  });

  it("a contract read from a dependency: its edit re-runs the registration checks", () => {
    kitProject();
    write("money.json", "{}\n");
    tagFile("money", { contractFrom: "../money.json" });
    const source = "<money/>\n";
    expect(lowerAt("page.kit.mx", source).diagnostics).toEqual([]);
    write("money.json", '{ "attributes": { "a": { "bogus": 1 } } }\n');
    expect(brief(lowerAt("page.kit.mx", source))).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("bogus"),
        line: 1,
        column: 0,
      }),
    ]);
  });

  it.each([
    ["a sidecar", "components/coin.tag.ts", "coin", ""],
    ["an `mx.contracts` module", "contracts.mjs", "stamp", "contracts"],
  ])(
    "an edit to %s the tag file's lowering reads re-derives it, broken then fixed",
    (_, file, name, contracts) => {
      kitProject("", contracts ? { contracts: "./contracts.mjs" } : undefined);
      // Vitest keeps its own module registry, so a rewritten module is not
      // evaluated again here. The module reads its attributes from a JSON
      // file beside it at each access instead, and each version rewrites the
      // module too, so its stamp changes the way a real edit's would.
      const json = `${file}.json`;
      let version = 0;
      const define = (attributes: string) => {
        write(json, attributes);
        const read = `JSON.parse(readFileSync(${JSON.stringify(join(dir, json))}, "utf8"))`;
        const contract = `{ get attributes() { return ${read}; } }`;
        write(
          file,
          `import { readFileSync } from "node:fs";\n// version ${++version}\nexport default ${
            contracts ? `{ ${name}: ${contract} }` : contract
          };\n`,
        );
      };
      define("{}");
      tagFile("money", { lower: true }, `<${name}/>\n`);
      expect(lowerAt("page.kit.mx", "<money/>\n").diagnostics).toEqual([]);
      define('{ "v": { "required": true } }');
      expect(brief(lowerAt("page.kit.mx", "<money/>\n"))).toEqual([
        {
          message:
            "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
          line: 1,
          column: 0,
          code: "MX_TAG_FILE_ERROR",
        },
        {
          message: `\`<${name}>\`: missing required attribute \`v\``,
          line: 2,
          column: 0,
          code: "MX_MISSING_ATTRIBUTE",
          file: "concepts/money.kit.mx",
        },
      ]);
      define('{ "v": {} }');
      expect(lowerAt("page.kit.mx", "<money/>\n").diagnostics).toEqual([]);
      expect(count("money.kit.mx")).toBe(3);
    },
  );

  it("an edit to a sibling tag file the lowering never calls re-derives nothing else", () => {
    kitProject();
    tagFile("money", { lower: true }, "<div/>\n");
    tagFile("coin", { contract: {} });
    lowerAt("page.kit.mx", "<money/>\n");
    tagFile("coin", { contract: { attributes: { q: {} } } });
    lowerAt("page.kit.mx", "<money/>\n<coin/>\n");
    expect([count("money.kit.mx"), count("coin.kit.mx")]).toEqual([1, 1]);
  });

  it("a warm compile checks each tag directory's scan once per sweep, not once per tag", () => {
    kitProject();
    const names = Array.from({ length: 20 }, (_, i) => `t${i}`);
    for (const name of names) tagFile(name, { contract: {} });
    const source = names.map((name) => `<${name}/>`).join("\n");
    lowerAt("page.kit.mx", source);
    ownScanChecksForTests.count = 0;
    expect(lowerAt("page.kit.mx", source).diagnostics).toEqual([]);
    // One tag directory and one route, swept by each of the compile's two
    // registration views.
    expect(ownScanChecksForTests.count).toBeLessThanOrEqual(2);
    expect(count("t0.kit.mx")).toBe(1);
  });

  it("one registration of a copied map, after an edit, refreshes every reader", () => {
    kitProject();
    write("shared.txt", "one\n");
    tagFile("money", { contract: {}, dependsOn: ["../shared.txt"] });
    tagFile("coin", { contract: {}, dependsOn: ["../shared.txt"] });
    const { customTags } = scanCached(join(dir, "page.kit.mx"), { targets });
    lowerAt("page.kit.mx", "<money/>\n<coin/>\n");
    write("shared.txt", "two, longer\n");
    const view = registrationView({ ...customTags }, claimedFields(undefined));
    void view?.money?.attributes;
    void view?.coin?.attributes;
    expect([count("money.kit.mx"), count("coin.kit.mx")]).toEqual([2, 2]);
  });

  it("an edit to a file two tag files depend on re-derives both", () => {
    kitProject();
    write("shared.txt", "one\n");
    tagFile("money", { contract: {}, dependsOn: ["../shared.txt"] });
    tagFile("coin", { contract: {}, dependsOn: ["../shared.txt"] });
    const source = "<money/>\n<coin/>\n";
    lowerAt("page.kit.mx", source);
    write("shared.txt", "two, longer\n");
    lowerAt("page.kit.mx", source);
    expect([count("money.kit.mx"), count("coin.kit.mx")]).toEqual([2, 2]);
  });

  it("a copy of the scanned map, after an edit, reads the new contract", () => {
    kitProject();
    tagFile("money", { contract: {} });
    const file = join(dir, "page.kit.mx");
    const { customTags } = scanCached(file, { targets });
    const source = "<money/>\n";
    expect(lowerSource(source, file, { customTags }).diagnostics).toEqual([]);
    tagFile("money", {
      contract: { attributes: { amount: { required: true } } },
    });
    expect(
      lowerSource(source, file, { customTags: { ...customTags } }).diagnostics,
    ).toHaveLength(1);
  });

  it("`ctx.lower` is memoized per options", () => {
    kitProject();
    tagFile("money", { lower: true, lowerTwice: true }, "<div/>\n");
    expect(lowerAt("page.kit.mx", "<money/>\n").diagnostics).toEqual([]);
  });

  it("two tag directories: both derive", () => {
    kitProject();
    tagFile("money", { contract: { attributes: { a: {} } } });
    tagFile("coin", { contract: { attributes: { b: {} } } }, "", "components");
    expect(
      lowerAt("page.kit.mx", "<money a=1/>\n<coin b=2/>\n").diagnostics,
    ).toEqual([]);
    expect(
      brief(lowerAt("page.kit.mx", "<money b=1/>\n<coin a=2/>\n")).map((d) => [
        d.line,
        d.column,
      ]),
    ).toEqual([
      [1, 7],
      [2, 6],
    ]);
  });

  it("a dialect with no hook keeps `MX_TAG_FILE_ERROR`", () => {
    dialectProject(dir, {
      packageName: "kit-dialect",
      manifest: KIT,
      module: "export default { table: {} };",
    });
    tagFile("money", { contract: {} });
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))).toEqual([
      {
        message:
          "`<money>` is defined by concepts/money.kit.mx, but dialect `kit` has no tagFile hook to read it.",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
    ]);
  });
});

describe("dependencies", () => {
  it("`dependsOn`: an edit to the named file re-derives", () => {
    kitProject();
    write("concepts/money.json", "1\n");
    tagFile("money", { contract: {}, dependsOn: ["money.json"] });
    lowerAt("page.kit.mx", "<money/>\n");
    lowerAt("page.kit.mx", "<money/>\n");
    expect(count("money.kit.mx")).toBe(1);
    write("concepts/money.json", "22\n");
    lowerAt("page.kit.mx", "<money/>\n");
    expect(count("money.kit.mx")).toBe(2);
  });

  it("`dependsOn` a missing file: creating it re-derives", () => {
    kitProject();
    tagFile("money", { contract: {}, dependsOn: ["later.json"] });
    lowerAt("page.kit.mx", "<money/>\n");
    write("concepts/later.json", "1\n");
    lowerAt("page.kit.mx", "<money/>\n");
    expect(count("money.kit.mx")).toBe(2);
  });

  it("a tag file that calls another depends on it with no `dependsOn`", () => {
    kitProject();
    tagFile("coin", { contract: { attributes: { v: { required: true } } } });
    tagFile("money", { lower: true }, "<coin/>\n");
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))).toEqual([
      {
        message:
          "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message: expect.stringContaining("`v`"),
        line: 2,
        column: 0,
        code: "MX_MISSING_ATTRIBUTE",
        file: "concepts/money.kit.mx",
      },
    ]);
    // Fix the callee: the caller's contract is derived again.
    tagFile("coin", { contract: { attributes: { v: {} } } });
    expect(lowerAt("page.kit.mx", "<money/>\n").diagnostics).toEqual([]);
    expect(count("money.kit.mx")).toBe(2);
    expect(count("coin.kit.mx")).toBe(2);
  });

  it("transitively: an edit two calls down re-derives the whole chain", () => {
    kitProject();
    tagFile("leaf", { contract: {} });
    tagFile("coin", { lower: true }, "<leaf/>\n");
    tagFile("money", { lower: true }, "<coin/>\n");
    expect(lowerAt("page.kit.mx", "<money/>\n").diagnostics).toEqual([]);
    expect([
      count("money.kit.mx"),
      count("coin.kit.mx"),
      count("leaf.kit.mx"),
    ]).toEqual([1, 1, 1]);
    tagFile("leaf", { contract: { attributes: { v: { required: true } } } });
    const result = brief(lowerAt("page.kit.mx", "<money/>\n"));
    expect(result[0]).toEqual({
      message: "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
      line: 1,
      column: 0,
      code: "MX_TAG_FILE_ERROR",
    });
    // `lowerSource` orders other files' diagnostics by file, then position.
    expect(result.slice(1).map((d) => d.file)).toEqual([
      "concepts/coin.kit.mx",
      "concepts/money.kit.mx",
    ]);
    expect([
      count("money.kit.mx"),
      count("coin.kit.mx"),
      count("leaf.kit.mx"),
    ]).toEqual([2, 2, 2]);
  });

  it("an unrelated edit re-derives nothing", () => {
    kitProject();
    tagFile("coin", { contract: {} });
    tagFile("money", { lower: true }, "<coin/>\n");
    tagFile("other", { contract: {} });
    lowerAt("page.kit.mx", "<money/>\n<other/>\n");
    tagFile("other", { contract: { attributes: { q: {} } } });
    lowerAt("page.kit.mx", "<money/>\n<other/>\n");
    expect([
      count("money.kit.mx"),
      count("coin.kit.mx"),
      count("other.kit.mx"),
    ]).toEqual([1, 1, 2]);
  });
});

describe("diagnostics", () => {
  it("hook diagnostics are in the tag file, with `file` set; a warning reaches the caller", () => {
    kitProject();
    tagFile("money", {
      contract: {},
      diagnostics: [
        {
          severity: "warning",
          message: "careful",
          line: 3,
          column: 2,
          code: "KIT_W",
        },
      ],
    });
    const result = lowerAt("page.kit.mx", "<money/>\n<money/>\n");
    expect(
      result.diagnostics.map(
        ({ severity, message, line, column, file, code }) => ({
          severity,
          message,
          line,
          column,
          file: file && relative(dir, file),
          code,
        }),
      ),
    ).toEqual([
      {
        severity: "warning",
        message: "careful",
        line: 3,
        column: 2,
        file: "concepts/money.kit.mx",
        code: "KIT_W",
      },
    ]);
  });

  it("the definition error names the tag file's own first error, before forwarded ones", () => {
    kitProject();
    tagFile("money", {
      contract: {},
      diagnostics: [
        {
          severity: "error",
          message: "over there",
          line: 5,
          column: 1,
          file: join(dir, "elsewhere.txt"),
        },
        { severity: "error", message: "here", line: 2, column: 3 },
      ],
    });
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))[0]).toMatchObject({
      message: "`<money>`'s definition has errors (concepts/money.kit.mx:2:4)",
      code: "MX_TAG_FILE_ERROR",
    });
  });

  it("an error diagnostic fails the call, with the diagnostic beside it", () => {
    kitProject();
    tagFile("money", {
      contract: {},
      diagnostics: [
        {
          severity: "error",
          message: "bad unit",
          line: 3,
          column: 2,
          code: "KIT_E",
        },
      ],
    });
    expect(
      brief(lowerAt("page.kit.mx", "<div>\n  <money/>\n</div>\n")),
    ).toEqual([
      {
        message:
          "`<money>`'s definition has errors (concepts/money.kit.mx:3:3)",
        line: 2,
        column: 2,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message: "bad unit",
        line: 3,
        column: 2,
        code: "KIT_E",
        file: "concepts/money.kit.mx",
      },
    ]);
  });

  it("a thrown error is a diagnostic at 1:0 of the tag file, never a crash", () => {
    kitProject();
    tagFile("money", { throw: "boom" });
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))).toEqual([
      {
        message:
          "`<money>`'s definition has errors (concepts/money.kit.mx:1:1)",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message: "the dialect's `tagFile` hook threw: boom",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
        file: "concepts/money.kit.mx",
      },
    ]);
  });

  it("a thrown positioned error keeps its position", () => {
    kitProject();
    tagFile("money", { throw: "bad here", throwAt: [4, 6] });
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))).toEqual([
      {
        message:
          "`<money>`'s definition has errors (concepts/money.kit.mx:4:7)",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message: "bad here",
        line: 4,
        column: 6,
        code: "MX_TAG_FILE_ERROR",
        file: "concepts/money.kit.mx",
      },
    ]);
  });

  it("a thrown positioned error keeps its range, an `end` in the tag file", () => {
    kitProject();
    tagFile("money", { throw: "bad here", throwAt: [4, 6, 4, 9] });
    const own = lowerAt("page.kit.mx", "<money/>\n").diagnostics.find(
      (d) => d.message === "bad here",
    );
    expect(own).toMatchObject({
      file: join(dir, "concepts/money.kit.mx"),
      line: 4,
      column: 6,
      end: { line: 4, column: 9, offset: -1 },
    });
  });

  it("a failure is cached: the hook does not run again until the file changes", () => {
    kitProject();
    tagFile("money", { throw: "boom" });
    lowerAt("page.kit.mx", "<money/>\n");
    lowerAt("page.kit.mx", "<money/>\n");
    expect(count("money.kit.mx")).toBe(1);
    tagFile("money", { contract: {} });
    expect(lowerAt("page.kit.mx", "<money/>\n").diagnostics).toEqual([]);
    expect(count("money.kit.mx")).toBe(2);
  });

  it.each([
    [
      "`parseOptions`",
      { contract: { parseOptions: { text: true } } },
      "a tag file's contract cannot set `parseOptions`: a call is parsed before any contract is read, so they come from a `.tag.ts` sidecar beside the tag file",
    ],
    [
      "`template`",
      { contract: { template: "x.mx" } },
      "a tag file's contract cannot set `template`: a tag file defines a contract, and a data file never calls a template tag",
    ],
    [
      "a hook",
      { contract: { transform: 1 } },
      "a tag file's contract cannot set `transform`: hooks come from a `.tag.ts` sidecar beside the tag file",
    ],
    [
      "an unknown top-level key",
      { contract: { bogus: 1 } },
      'Unknown key "bogus" in the declaration of tag "money"; allowed: attributes, attributeTags, children, parents, defaultTag',
    ],
    [
      "no contract",
      { result: {} },
      "the dialect's `tagFile` hook returned no contract",
    ],
    [
      "a non-object result",
      { result: 7 },
      "the dialect's `tagFile` hook returned a number, not `{ contract, diagnostics }`",
    ],
  ])("%s is refused in the tag file", (_, directives, message) => {
    kitProject();
    tagFile("money", directives);
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))).toEqual([
      {
        message:
          "`<money>`'s definition has errors (concepts/money.kit.mx:1:1)",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message,
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
        file: "concepts/money.kit.mx",
      },
    ]);
  });

  it("an unknown key lists the keys the dialect claims, in the wording every contract source gives", () => {
    kitProject('contractFields: { tag: ["kind"] },');
    tagFile("money", { contract: { bogus: 1, kind: "good" } });
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))[1]).toEqual({
      message:
        'Unknown key "bogus" in the declaration of tag "money"; allowed: attributes, attributeTags, children, parents, defaultTag, kind',
      line: 1,
      column: 0,
      code: "MX_TAG_FILE_ERROR",
      file: "concepts/money.kit.mx",
    });
  });

  it("each unknown key is its own error, in the order written, and the known ones stay", () => {
    kitProject();
    tagFile("money", {
      contract: { atributes: {}, parents: ["purse"], chilren: {} },
    });
    expect(brief(lowerAt("page.kit.mx", "<money/>\n")).slice(1)).toEqual(
      ["atributes", "chilren"].map((key) => ({
        message: `Unknown key "${key}" in the declaration of tag "money"; allowed: attributes, attributeTags, children, parents, defaultTag`,
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
        file: "concepts/money.kit.mx",
      })),
    );
  });

  it("`declares` is refused unless the dialect claims it", () => {
    kitProject();
    tagFile("money", { contract: { declares: {} } });
    expect(brief(lowerAt("page.kit.mx", "<money/>\n"))[1]).toEqual({
      message:
        "`declares` is not allowed: no syntax module claims it (`contractFields`)",
      line: 1,
      column: 0,
      code: "MX_TAG_FILE_ERROR",
      file: "concepts/money.kit.mx",
    });
  });

  it("a diagnostic the hook makes up with an `MX_` code is refused as the hook's error", () => {
    kitProject();
    tagFile("money", {
      contract: {},
      diagnostics: [
        {
          severity: "error",
          message: "bad",
          line: 2,
          column: 0,
          code: "MX_UNKNOWN_TAG",
        },
      ],
    });
    const found = brief(lowerAt("page.kit.mx", "<money/>\n"));
    expect(found.map((d) => d.code)).toContain("MX_DIALECT_HOOK_ERROR");
    expect(found.map((d) => d.code)).not.toContain("MX_UNKNOWN_TAG");
    expect(found.map((d) => d.message).join("\n")).toContain(
      "code `MX_UNKNOWN_TAG` starts with `MX_`, which is MX's own prefix",
    );
  });

  it("a diagnostic `ctx.lower` reported keeps core's `MX_` code when the hook forwards it", () => {
    kitProject();
    tagFile("money", { lower: true }, "<money2/>\n");
    tagFile("money2", { contract: { attributes: { v: { required: true } } } });
    const found = brief(lowerAt("page.kit.mx", "<money/>\n"));
    expect(found).toContainEqual(
      expect.objectContaining({
        code: "MX_MISSING_ATTRIBUTE",
        file: "concepts/money.kit.mx",
      }),
    );
    expect(found.map((d) => d.code)).not.toContain("MX_DIALECT_HOOK_ERROR");
  });

  describe("forwarding a diagnostic `ctx.lower` returned", () => {
    // `<money>` lowers `<money2/>`, which lacks its required `v`: core reports
    // MX_MISSING_ATTRIBUTE to the hook, at `<money2` (line 2 of the tag file).
    const MISSING = {
      message: "`<money2>`: missing required attribute `v`",
      line: 2,
      column: 0,
      code: "MX_MISSING_ATTRIBUTE",
      file: "concepts/money.kit.mx",
    };
    const REFUSED = {
      message:
        "the dialect's `tagFile` hook returned a diagnostic whose code `MX_MISSING_ATTRIBUTE` starts with `MX_`, which is MX's own prefix for its diagnostic codes; use the dialect's own prefix (only a diagnostic object `ctx.lower` returned, passed on as it is, keeps an `MX_` code)",
      line: 2,
      column: 0,
      code: "MX_DIALECT_HOOK_ERROR",
      file: "concepts/money.kit.mx",
    };
    /** `<money>` called from a page, its tag file passing `lower` on. */
    function callMoney(
      lower: boolean | "copy" | "reword" | "inplace" | "forge",
    ) {
      kitProject();
      tagFile("money", { lower }, "<money2/>\n");
      tagFile("money2", {
        contract: { attributes: { v: { required: true } } },
      });
      return brief(lowerAt("page.kit.mx", "<money/>\n"));
    }

    it("(a) the very object `ctx.lower` returned is forwarded unchanged, with its code and range", () => {
      const found = callMoney(true);
      expect(found).toEqual([
        {
          message:
            "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
          line: 1,
          column: 0,
          code: "MX_TAG_FILE_ERROR",
        },
        MISSING,
      ]);
      const full = lowerAt("page.kit.mx", "<money/>\n").diagnostics.find(
        (d) => d.code === "MX_MISSING_ATTRIBUTE",
      );
      // The range core measured travels with it: `<money2`, in the tag file (so no offset).
      expect(full?.end).toEqual({ line: 2, column: 7, offset: -1 });
    });

    it("(b) a copy with another message is refused: the hook's words do not go under MX's code", () => {
      expect(callMoney("reword")).toEqual([
        {
          message:
            "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
          line: 1,
          column: 0,
          code: "MX_TAG_FILE_ERROR",
        },
        REFUSED,
      ]);
    });

    it("(c) an unchanged copy is refused too: the object counts, not its fields", () => {
      expect(callMoney("copy")).toEqual([
        {
          message:
            "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
          line: 1,
          column: 0,
          code: "MX_TAG_FILE_ERROR",
        },
        REFUSED,
      ]);
    });

    it("(e) the object reworded in place is refused too: it must still say what core said", () => {
      expect(callMoney("inplace")).toEqual([
        {
          message:
            "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
          line: 1,
          column: 0,
          code: "MX_TAG_FILE_ERROR",
        },
        REFUSED,
      ]);
    });

    it("(f) the object given a code core never reported is refused, naming that code", () => {
      const found = callMoney("forge");
      expect(found.map((d) => d.code)).toEqual([
        "MX_TAG_FILE_ERROR",
        "MX_DIALECT_HOOK_ERROR",
      ]);
      expect(found[1]).toEqual({
        ...REFUSED,
        message: REFUSED.message.replace(
          "MX_MISSING_ATTRIBUTE",
          "MX_INTERNAL_ERROR",
        ),
      });
    });

    it("(d) a code of the hook's own, not `MX_`, passes unchanged", () => {
      kitProject();
      tagFile("money", {
        contract: {},
        diagnostics: [
          {
            severity: "error",
            message: "bad concept",
            line: 2,
            column: 0,
            code: "KIT_BAD",
          },
        ],
      });
      expect(brief(lowerAt("page.kit.mx", "<money/>\n"))).toEqual([
        {
          message:
            "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
          line: 1,
          column: 0,
          code: "MX_TAG_FILE_ERROR",
        },
        {
          message: "bad concept",
          line: 2,
          column: 0,
          code: "KIT_BAD",
          file: "concepts/money.kit.mx",
        },
      ]);
    });
  });

  it("an unknown nested key goes through the registration checks, at the call", () => {
    kitProject();
    tagFile("money", { contract: { attributes: { a: { values: ["x"] } } } });
    expect(
      brief(lowerAt("page.kit.mx", "<div>\n  <money/>\n</div>\n")),
    ).toEqual([
      {
        message: expect.stringContaining('Unknown key "values"'),
        line: 2,
        column: 2,
        code: "MX_INVALID_CONTRACT",
      },
    ]);
  });

  it("a key the dialect claims (`contractFields`) passes, and its `checkContract` runs at the call", () => {
    kitProject(`
  contractFields: { attribute: ["values"], tag: ["kind"] },
  checkContract(tag, contract, ctx) {
    if (contract.kind === "bad") ctx.fail("kind must not be bad");
  },`);
    tagFile("money", {
      contract: { kind: "good", attributes: { a: { values: ["x"] } } },
    });
    tagFile("coin", { contract: { kind: "bad" } });
    expect(lowerAt("page.kit.mx", "<money/>\n").diagnostics).toEqual([]);
    expect(brief(lowerAt("page.kit.mx", "<div>\n  <coin/>\n</div>\n"))).toEqual(
      [
        {
          message: expect.stringContaining("kind must not be bad"),
          line: 2,
          column: 2,
          code: "MX_DIALECT_ERROR",
        },
      ],
    );
  });
});

describe("cycles", () => {
  it("two tag files calling each other: `MX_TAG_FILE_CYCLE` at the re-entering call", () => {
    kitProject();
    tagFile("a", { lower: true }, "<b/>\n");
    tagFile("b", { lower: true }, "<div>\n  <a/>\n</div>\n");
    const result = brief(lowerAt("page.kit.mx", "<a/>\n"));
    expect(result).toEqual([
      {
        message: "`<a>`'s definition has errors (concepts/a.kit.mx:2:1)",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message: "`<b>`'s definition has errors (concepts/b.kit.mx:3:3)",
        line: 2,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
        file: "concepts/a.kit.mx",
      },
      {
        message:
          "tag files call each other in a cycle: concepts/a.kit.mx → concepts/b.kit.mx → concepts/a.kit.mx",
        line: 3,
        column: 2,
        code: "MX_TAG_FILE_CYCLE",
        file: "concepts/b.kit.mx",
      },
    ]);
  });

  it("nothing on the cycle is cached, and fixing one file clears it", () => {
    kitProject();
    tagFile("a", { lower: true }, "<b/>\n");
    tagFile("b", { lower: true }, "<a/>\n");
    lowerAt("page.kit.mx", "<a/>\n");
    const after = [count("a.kit.mx"), count("b.kit.mx")];
    lowerAt("page.kit.mx", "<a/>\n");
    // Not cached: the second compile derives again.
    expect(count("a.kit.mx")).toBeGreaterThan(after[0] as number);
    tagFile("b", { lower: true }, "<div/>\n");
    expect(lowerAt("page.kit.mx", "<a/>\n").diagnostics).toEqual([]);
    expect(lowerAt("page.kit.mx", "<b/>\n").diagnostics).toEqual([]);
  });

  it("three files: a → b → c → a, at the call inside c", () => {
    kitProject();
    tagFile("a", { lower: true }, "<b/>\n");
    tagFile("b", { lower: true }, "<c/>\n");
    tagFile("c", { lower: true }, "<x>\n  <a/>\n</x>\n");
    const result = brief(lowerAt("page.kit.mx", "<a/>\n"));
    expect(result.at(-1)).toEqual({
      message:
        "tag files call each other in a cycle: concepts/a.kit.mx → concepts/b.kit.mx → concepts/c.kit.mx → concepts/a.kit.mx",
      line: 3,
      column: 2,
      code: "MX_TAG_FILE_CYCLE",
      file: "concepts/c.kit.mx",
    });
    expect(result[0]).toMatchObject({
      message: "`<a>`'s definition has errors (concepts/a.kit.mx:2:1)",
      code: "MX_TAG_FILE_ERROR",
    });
    tagFile("c", { lower: true }, "<x/>\n");
    expect(lowerAt("page.kit.mx", "<a/>\n").diagnostics).toEqual([]);
  });

  it("an unnamed child of a call on the cycle is not a second cycle", () => {
    kitProject();
    tagFile("a", { lower: true, contract: { defaultTag: "b" } }, "<b/>\n");
    tagFile("b", { lower: true }, "<a>\n  <.x/>\n</a>\n");
    const result = brief(lowerAt("page.kit.mx", "<a/>\n"));
    // Default-tag resolution reads `<a>`'s contract before the call does:
    // a read of a contract still being derived, answered "not yet".
    expect(result).toEqual([
      {
        message: "`<a>`'s definition has errors (concepts/a.kit.mx:2:1)",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message: "`<b>`'s definition has errors (concepts/b.kit.mx:2:1)",
        line: 2,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
        file: "concepts/a.kit.mx",
      },
      {
        message:
          "tag files call each other in a cycle: concepts/a.kit.mx → concepts/b.kit.mx → concepts/a.kit.mx",
        line: 2,
        column: 0,
        code: "MX_TAG_FILE_CYCLE",
        file: "concepts/b.kit.mx",
      },
    ]);
  });

  it("calling a tag on the cycle from inside it, starting elsewhere, reports the same cycle", () => {
    kitProject();
    tagFile("a", { lower: true }, "<b/>\n");
    tagFile("b", { lower: true }, "<a/>\n");
    const result = brief(lowerAt("page.kit.mx", "<b/>\n"));
    expect(result.find((d) => d.code === "MX_TAG_FILE_CYCLE")).toMatchObject({
      message:
        "tag files call each other in a cycle: concepts/b.kit.mx → concepts/a.kit.mx → concepts/b.kit.mx",
      code: "MX_TAG_FILE_CYCLE",
      file: "concepts/a.kit.mx",
    });
  });
});

/**
 * An editor's unsaved tag file (`withCalleeInputSources`, the channel an
 * unsaved `.mx` template already reaches core by): the hook is given that
 * text, and a derivation made from it is never served once it is out of
 * force, nor the disk's served while it is in force.
 */
describe("unsaved tag files", () => {
  const BROKEN = {
    contract: {},
    diagnostics: [
      {
        severity: "error",
        message: "broken concept",
        line: 2,
        column: 4,
        code: "KIT_BAD",
      },
    ],
  };
  const textOf = (directives: unknown, body = "") =>
    `<!-- ${JSON.stringify(directives)} -->\n${body}`;
  const CALLER_ERROR = [
    {
      message: "`<money>`'s definition has errors (concepts/money.kit.mx:2:5)",
      line: 1,
      column: 0,
      code: "MX_TAG_FILE_ERROR",
    },
    {
      message: "broken concept",
      line: 2,
      column: 4,
      code: "KIT_BAD",
      file: "concepts/money.kit.mx",
    },
  ];

  /** Lowers `<money/>` with `unsaved` text for `file` in force (none: the disk's). */
  function withUnsaved(file: string, unsaved: string | undefined) {
    const sources = new Map(unsaved === undefined ? [] : [[file, unsaved]]);
    return withCalleeInputSources(sources, () =>
      brief(lowerAt("page.kit.mx", "<money/>\n")),
    );
  }

  it("an unsaved fix clears the caller's error, and the disk's error is back once it is gone", () => {
    kitProject();
    const file = tagFile("money", BROKEN);
    expect(withUnsaved(file, undefined)).toEqual(CALLER_ERROR);
    expect(withUnsaved(file, textOf({ contract: {} }))).toEqual([]);
    expect(withUnsaved(file, undefined)).toEqual(CALLER_ERROR);
  });

  it("an unsaved break raises the caller's error, and the disk's clean tag file is back once it is gone", () => {
    kitProject();
    const file = tagFile("money", { contract: {} });
    expect(withUnsaved(file, undefined)).toEqual([]);
    expect(withUnsaved(file, textOf(BROKEN))).toEqual(CALLER_ERROR);
    expect(withUnsaved(file, undefined)).toEqual([]);
  });

  it("with no unsaved source the disk is used, derived once", () => {
    kitProject();
    const file = tagFile("money", BROKEN);
    const elsewhere = join(dir, "concepts/other.kit.mx");
    expect(withUnsaved(elsewhere, textOf({ contract: {} }))).toEqual(
      CALLER_ERROR,
    );
    expect(withUnsaved(file, undefined)).toEqual(CALLER_ERROR);
    expect(count("money.kit.mx")).toBe(1);
  });

  it("the hook is given the unsaved text", () => {
    kitProject();
    const file = tagFile("money", { contract: {} });
    const unsaved = textOf({ contract: {} }, "<!-- unsaved -->\n");
    withUnsaved(file, unsaved);
    expect(
      (state() as unknown as { lastInput: { source: string; path: string } })
        .lastInput,
    ).toMatchObject({ path: file, source: unsaved });
  });

  it("the same unsaved text is derived once; another text is derived again", () => {
    kitProject();
    const file = tagFile("money", BROKEN);
    const fixed = textOf({ contract: {} });
    withUnsaved(file, fixed);
    withUnsaved(file, fixed);
    expect(count("money.kit.mx")).toBe(1);
    expect(withUnsaved(file, textOf(BROKEN, "x"))).toEqual(CALLER_ERROR);
    expect(count("money.kit.mx")).toBe(2);
  });

  it("an unsaved fix to a tag file a tag file calls clears the caller's error, transitively", () => {
    kitProject();
    const coin = tagFile("coin", {
      contract: { attributes: { v: { required: true } } },
    });
    tagFile("money", { lower: true }, "<coin/>\n");
    const broken = withUnsaved(coin, undefined);
    expect(broken).toEqual([
      {
        message:
          "`<money>`'s definition has errors (concepts/money.kit.mx:2:1)",
        line: 1,
        column: 0,
        code: "MX_TAG_FILE_ERROR",
      },
      {
        message: expect.stringContaining("`v`"),
        line: 2,
        column: 0,
        code: "MX_MISSING_ATTRIBUTE",
        file: "concepts/money.kit.mx",
      },
    ]);
    expect(
      withUnsaved(coin, textOf({ contract: { attributes: { v: {} } } })),
    ).toEqual([]);
    expect(withUnsaved(coin, undefined)).toEqual(broken);
  });
});
