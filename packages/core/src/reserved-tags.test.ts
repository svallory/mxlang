/**
 * Reserved tag names (dialect tag discovery, slice 3): a definition that
 * names a reserved tag is dropped with `MX_RESERVED_TAG`, on all four
 * sources (a discovered tag file, an `mx.tags` entry, an `mx.contracts`
 * entry, passed `customTags`), and its calls resolve as if it were absent.
 *
 * Core's structural names (`RESERVED_NAMES`) are reserved for every caller; a
 * dialect's `reservedTags` for its own files only. The test dialect `kit`
 * (claiming `.kit.mx`, scanning `components/`, reserving `entity`) is a
 * fixture, not any real dialect.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rejectShadowedRegistration } from "./builtin-tags.ts";
import { compileSource } from "./compile.ts";
import { isTranslateError, TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import {
  RESERVED_NAMES as EXPORTED_RESERVED_NAMES,
  lowerSource as exportedLowerSource,
} from "./index.ts";
import {
  type LowerSourceOptions,
  type LowerSourceResult,
  lowerFile,
  lowerSource,
} from "./ir-entry/index.ts";
import {
  CORE_TAG_DISCOVERY,
  reservedRefusal,
  type ScanDiagnostic,
  type ScanResult,
  scanCustomTags,
} from "./scan.ts";
import { clearScanCache, scanCached } from "./scan-cache.ts";
import { RESERVED_NAMES } from "./tag-names.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup, testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-reserved-tags-")));
  clearScanCache();
});
afterEach(() => {
  clearScanCache();
  rmSync(dir, { recursive: true, force: true });
});

const readFile = (file: string): string => readFileSync(file, "utf8");

function write(path: string, text = "<div/>\n"): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const KIT = {
  id: "kit",
  name: "Kit",
  extensions: [".kit.mx"],
  tagDirs: ["components"],
  reservedTags: ["entity"],
};

/** A project using the `kit` test dialect, with `mx` as its own config. */
function kitProject(mx?: unknown, fields: Record<string, unknown> = {}) {
  return dialectProject(dir, {
    packageName: "kit-dialect",
    manifest: { ...KIT, ...fields },
    module: "export default { table: {} };",
    ...(mx === undefined ? {} : { mx }),
  });
}

const scan = (file: string): ScanResult =>
  scanCustomTags(join(dir, file), { targets });

/** A diagnostic with its file made relative to the project. */
const shown = (diagnostic: ScanDiagnostic) => ({
  ...diagnostic,
  file: relative(dir, diagnostic.file),
});

/** The 1-based line and 0-based column of `needle`'s first occurrence in `text`. */
function positionOf(text: string, needle: string) {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`no ${needle} in the text`);
  const before = text.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - (before.lastIndexOf("\n") + 1),
  };
}

const DEFINITION: CustomTag = {
  attributes: { zzz: { type: "string", required: true } },
};

const RESERVED_CODE = "MX_RESERVED_TAG";

/** One source of each core name: a call that lowers in a data file. */
const CALLS: Record<(typeof RESERVED_NAMES)[number], string> = {
  if: "<if=true><p/></if>\n",
  else: "<else/>\n",
  "else-if": "<else-if=true><p/></else-if>\n",
  for: "<for|x| of=[1]><p/></for>\n",
  const: "<const/x=1/>\n",
  define: "<define/x=1/>\n",
  return: "<return=1/>\n",
  import: 'import x from "y"\n<p/>\n',
  export: "export const a = 1\n<p/>\n",
  static: "static const a = 1\n<p/>\n",
  try: "<try><p/></try>\n",
};

/** The diagnostics of a result, ignoring the `MX_RESERVED_TAG` ones. */
const others = (result: LowerSourceResult) =>
  result.diagnostics.filter((diagnostic) => diagnostic.code !== RESERVED_CODE);

describe("the core list", () => {
  it("is the one list: the package exports it, and core's entry carries it", () => {
    expect(EXPORTED_RESERVED_NAMES).toBe(RESERVED_NAMES);
    expect(CORE_TAG_DISCOVERY.reservedTags).toBe(RESERVED_NAMES);
    expect([...RESERVED_NAMES]).toEqual([
      "if",
      "else",
      "else-if",
      "for",
      "const",
      "define",
      "return",
      "import",
      "export",
      "static",
      "try",
    ]);
    expect(exportedLowerSource).toBe(lowerSource);
  });

  it("is the same check for core and a dialect: core's names win, then the dialect's", () => {
    const kit = { name: "Kit", reservedTags: ["entity", "try"] };
    expect(reservedRefusal("entity", kit, "a tag file")).toBe(
      "`<entity>` cannot be defined by a tag file: Kit reserves it",
    );
    // Core owns `try`, so its own message, not the dialect's.
    expect(reservedRefusal("try", kit, "a tag file")).toContain(
      "cannot name a data tag",
    );
    expect(reservedRefusal("button", kit, "a tag file")).toBeUndefined();
    expect(reservedRefusal("entity", CORE_TAG_DISCOVERY, "a tag file")).toBe(
      undefined,
    );
  });

  it.each(["class", "client", "server"])(
    "`%s` is not reserved: a tag file defines it",
    (name) => {
      write(`tags/${name}.tag.ts`, "export default { attributes: {} };\n");
      const result = scan("page.mx");
      expect(result.diagnostics).toEqual([]);
      expect(Object.keys(result.customTags)).toEqual([name]);
    },
  );

  it.each(["class", "client", "server"])(
    "`%s` is not reserved: `customTags` define it, and the call gets its contract",
    (name) => {
      const result = lowerSource(`<${name}/>\n`, "t.mx", {
        tagRules: "none",
        customTags: { [name]: DEFINITION },
      });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          message: `\`<${name}>\`: missing required attribute \`zzz\``,
        }),
      ]);
    },
  );
});

describe("a discovered tag file", () => {
  it.each([
    ["a template", "tags/for.mx"],
    ["a sidecar", "tags/for.tag.ts"],
  ])(
    "MX `tags/`: %s named after a core name is an error at the file's 1:0",
    (_, file) => {
      write(file, file.endsWith(".ts") ? "export default {};\n" : undefined);
      write("tags/fine.mx");
      write("package.json", '{"name":"app"}\n');
      const result = scan("page.mx");
      expect(result.diagnostics.map(shown)).toEqual([
        {
          file,
          message: expect.stringContaining("`<for>` cannot name a data tag"),
          line: 1,
          column: 0,
          severity: "error",
          code: RESERVED_CODE,
        },
      ]);
      expect(Object.keys(result.customTags)).toEqual(["fine"]);
      expect([...result.tags.keys()]).toEqual(["fine"]);
    },
  );

  it.each(RESERVED_NAMES)("MX `tags/%s.mx` is refused", (name) => {
    write(`tags/${name}.mx`);
    write("package.json", '{"name":"app"}\n');
    const result = scan("page.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      expect.objectContaining({
        file: `tags/${name}.mx`,
        code: RESERVED_CODE,
        severity: "error",
        line: 1,
        column: 0,
      }),
    ]);
    expect(Object.keys(result.customTags)).toEqual([]);
  });

  it("a dialect's `tagDirs`: its own reserved name is refused, naming the dialect", () => {
    kitProject();
    write("components/entity.kit.mx");
    write("components/button.kit.mx");
    const result = scan("page.kit.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      {
        file: "components/entity.kit.mx",
        message: "`<entity>` cannot be defined by a tag file: Kit reserves it",
        line: 1,
        column: 0,
        severity: "error",
        code: RESERVED_CODE,
      },
    ]);
    expect(Object.keys(result.customTags)).toEqual(["button"]);
  });

  it("a dialect's `tagDirs`: a sidecar named after its reserved name is refused too", () => {
    kitProject();
    write("components/entity.tag.ts", "export default {};\n");
    const result = scan("page.kit.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      expect.objectContaining({
        file: "components/entity.tag.ts",
        code: RESERVED_CODE,
        line: 1,
        column: 0,
      }),
    ]);
    expect([...result.tags.keys()]).toEqual([]);
  });

  it("a dialect's `tagDirs`: a core name is refused with core's message, not the dialect's", () => {
    kitProject();
    write("components/for.kit.mx");
    write("components/try.kit.mx");
    const result = scan("page.kit.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      expect.objectContaining({
        file: "components/for.kit.mx",
        message: expect.stringContaining("`<for>` cannot name a data tag"),
        code: RESERVED_CODE,
      }),
      expect.objectContaining({
        file: "components/try.kit.mx",
        message: expect.stringContaining("`<try>` cannot name a data tag"),
        code: RESERVED_CODE,
      }),
    ]);
  });

  it("a dialect without `tagDirs` scans `tags/` as MX does and reserves its own names there", () => {
    dialectProject(dir, {
      packageName: "plain-dialect",
      manifest: {
        id: "plain",
        name: "Plain",
        extensions: [".plain.mx"],
        reservedTags: ["entity"],
      },
    });
    write("tags/entity.mx");
    write("tags/box.mx");
    const result = scan("page.plain.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      {
        file: "tags/entity.mx",
        message:
          "`<entity>` cannot be defined by a tag file: Plain reserves it",
        line: 1,
        column: 0,
        severity: "error",
        code: RESERVED_CODE,
      },
    ]);
    expect(Object.keys(result.customTags)).toEqual(["box"]);
  });

  it("a dialect's reserved name binds only that dialect's own files: an MX file defines it", () => {
    kitProject();
    write("tags/entity.mx");
    const result = scan("page.mx");
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.customTags)).toEqual(["entity"]);
  });

  it("through scanCached, and again from the cache", () => {
    write("tags/for.mx");
    write("package.json", '{"name":"app"}\n');
    const first = scanCached(join(dir, "page.mx"), { targets });
    const second = scanCached(join(dir, "page.mx"), { targets });
    expect(second).toBe(first);
    expect(first.diagnostics.map((d) => d.code)).toEqual([RESERVED_CODE]);
  });

  it("a `for` file is dropped, so `<for>` is core's loop", () => {
    write("tags/for.mx");
    write("package.json", '{"name":"app"}\n');
    const result = scan("page.mx");
    const lowered = lowerSource("<for|x| of=[1]><p/></for>\n", "page.mx", {
      customTags: result.customTags,
    });
    expect(lowered.diagnostics).toEqual([]);
    expect(lowered.ir?.body.map((node) => node.kind)).toEqual(["For"]);
  });

  it("an `entity` file is dropped, so `<entity>` is an unknown tag under `unknownTags: reject`", () => {
    kitProject();
    write("components/entity.kit.mx");
    const result = scan("page.kit.mx");
    const lowered = lowerSource("<entity/>\n", join(dir, "page.kit.mx"), {
      customTags: result.customTags,
      unknownTags: "reject",
    });
    expect(lowered.diagnostics).toEqual([
      expect.objectContaining({
        code: "MX_UNKNOWN_TAG",
        line: 1,
        column: 0,
      }),
    ]);
  });

  it("an `entity` file is dropped, so `<entity>` is the dialect's own vocabulary", () => {
    kitProject();
    write("components/entity.kit.mx");
    const result = scan("page.kit.mx");
    const vocabulary: Record<string, CustomTag> = {
      entity: { attributes: { name: { type: "string" } } },
    };
    const lowered = lowerSource(
      '<entity name="x"/>\n',
      join(dir, "page.kit.mx"),
      {
        dialect: { id: "kit", name: "Kit", table: {} },
        // The front end's merge: the scan's tags under the dialect's own.
        customTags: { ...result.customTags, ...vocabulary },
        unknownTags: "reject",
      },
    );
    expect(lowered.diagnostics).toEqual([]);
    expect(lowered.ir?.body).toHaveLength(1);
  });
});

describe("an `mx.tags` entry", () => {
  /** The position of the `{` that opens the object holding `needle`. */
  const objectOpening = (text: string, needle: string) => {
    const offset = text.lastIndexOf("{", text.indexOf(needle));
    const before = text.slice(0, offset);
    return {
      line: before.split("\n").length,
      column: offset - (before.lastIndexOf("\n") + 1),
    };
  };

  const packageText = () => readFile(join(dir, "package.json"));
  const refusal = (
    file: string,
    at: { line: number; column: number },
    tagFile = "for",
  ) => ({
    file,
    message: expect.stringMatching(
      new RegExp(
        "^.<for>. cannot name a data tag: .* \\(.*shared/" +
          tagFile +
          "\\.mx\\)$",
      ),
    ),
    ...at,
    severity: "error",
    code: RESERVED_CODE,
  });

  it("is reported at its entry in `package.json`, naming the file", () => {
    write("shared/for.mx");
    write("shared/fine.mx");
    kitProject({ tags: ["shared"] });
    const result = scan("page.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      refusal("package.json", positionOf(packageText(), '"shared"')),
    ]);
    expect(Object.keys(result.customTags)).toEqual(["fine"]);
  });

  it("is reported at the second entry, not at the `tags` key", () => {
    write("other/ok.mx");
    write("shared/for.mx");
    kitProject({ tags: ["other", "shared"] });
    const result = scan("page.mx");
    const at = positionOf(packageText(), '"shared"');
    expect(at.line).toBeGreaterThan(positionOf(packageText(), '"tags"').line);
    expect(result.diagnostics.map(shown)).toEqual([
      refusal("package.json", at),
    ]);
    expect(Object.keys(result.customTags)).toEqual(["ok"]);
  });

  it("is reported at an object entry's opening brace", () => {
    write("other/ok.mx");
    write("shared/or.mx");
    kitProject({
      tags: ["other", { dir: "shared", prefix: "f" }],
    });
    const result = scan("page.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      refusal("package.json", objectOpening(packageText(), '"dir"'), "or"),
    ]);
  });

  it("is reported at the `tags` key when `mx.tags` is one string", () => {
    write("shared/for.mx");
    kitProject({ tags: "shared" });
    const result = scan("page.mx");
    const text = packageText();
    expect(result.diagnostics.map(shown)).toEqual([
      refusal("package.json", positionOf(text, '"tags"')),
    ]);
  });

  it("is reported at its entry in an `mx.config.json`", () => {
    write("shared/if.tag.ts", "export default {};\n");
    write("other/ok.mx");
    write("package.json", '{"name":"app"}\n');
    const config = write(
      "mx.config.json",
      '{\n  "extensions": {},\n  "tags": [\n    "other",\n    "shared"\n  ]\n}\n',
    );
    const result = scan("page.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      expect.objectContaining({
        file: "mx.config.json",
        line: 5,
        column: 4,
        severity: "error",
        code: RESERVED_CODE,
      }),
    ]);
    expect(result.diagnostics[0]?.file).toBe(config);
  });

  it("is reported at 1:0 of a JS config", () => {
    write("shared/for.mx");
    write("package.json", '{"name":"app"}\n');
    write("mx.config.cjs", 'module.exports = { tags: ["shared"] };\n');
    const result = scan("page.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      expect.objectContaining({
        file: "mx.config.cjs",
        line: 1,
        column: 0,
        severity: "error",
        code: RESERVED_CODE,
      }),
    ]);
  });

  it("applies a `prefix`: the prefixed name is what is reserved", () => {
    write("shared/or.mx");
    write("shared/else.mx");
    write(
      "package.json",
      '{"name":"app","mx":{"tags":[{"dir":"shared","prefix":"f"}]}}\n',
    );
    const result = scan("page.mx");
    // `f` + `or` is `for`; `f` + `else` is `felse`, a fine name.
    expect(result.diagnostics.map((d) => d.code)).toEqual([RESERVED_CODE]);
    expect(Object.keys(result.customTags)).toEqual(["felse"]);
  });

  it("under a dialect: its own reserved name is refused, a dialect file in the directory", () => {
    write("shared/entity.kit.mx");
    write("shared/button.kit.mx");
    kitProject({ tags: ["shared"] });
    const result = scan("page.kit.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      {
        file: "package.json",
        message: expect.stringMatching(
          /^`<entity>` cannot be defined by a tag file: Kit reserves it \(.*shared\/entity\.kit\.mx\)$/,
        ),
        ...positionOf(readFile(join(dir, "package.json")), '"shared"'),
        severity: "error",
        code: RESERVED_CODE,
      },
    ]);
    expect(Object.keys(result.customTags)).toEqual(["button"]);
  });

  it("under a dialect: another caller's file is not bound by the dialect's names", () => {
    write("shared/entity.mx");
    kitProject({ tags: ["shared"] });
    const result = scan("page.mx");
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.customTags)).toEqual(["entity"]);
  });
});

describe("an `mx.contracts` entry", () => {
  function contractsProject(
    source: string,
    mx: unknown = { contracts: "./contracts.ts" },
    fields?: Record<string, unknown>,
  ) {
    write("contracts.ts", source);
    return kitProject(mx, fields);
  }

  it("is reported at its key in the contracts module's literal", () => {
    contractsProject(
      "export default {\n  box: { attributes: {} },\n  for: 1,\n  try: { attributes: {} },\n};\n",
    );
    const result = scan("page.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      expect.objectContaining({
        file: "contracts.ts",
        line: 3,
        column: 2,
        severity: "error",
        code: RESERVED_CODE,
        message: expect.stringContaining("`<for>` cannot name a data tag"),
      }),
      expect.objectContaining({
        file: "contracts.ts",
        line: 4,
        column: 2,
        code: RESERVED_CODE,
      }),
    ]);
    expect(Object.keys(result.customTags)).toEqual(["box"]);
  });

  it("finds a quoted key, a `satisfies` literal and a bound identifier", () => {
    contractsProject(
      'const contracts = { "else-if": { attributes: {} }, box: { attributes: {} } };\nexport default contracts satisfies object;\n',
    );
    // The bound literal is found through the identifier, through `satisfies` too.
    expect(scan("page.mx").diagnostics.map(shown)).toEqual([
      expect.objectContaining({ line: 1, column: 20, code: RESERVED_CODE }),
    ]);
    write(
      "contracts.ts",
      'const contracts = { "else-if": { attributes: {} }, box: { attributes: {} } };\nexport default contracts;\n',
    );
    clearScanCache();
    expect(scan("page.mx").diagnostics.map(shown)).toEqual([
      expect.objectContaining({ line: 1, column: 20, code: RESERVED_CODE }),
    ]);
    write(
      "contracts.ts",
      'export default {\n  "else-if": { attributes: {} },\n} satisfies Record<string, object>;\n',
    );
    clearScanCache();
    expect(scan("page.mx").diagnostics.map(shown)).toEqual([
      expect.objectContaining({ line: 2, column: 2, code: RESERVED_CODE }),
    ]);
  });

  it("ends at the key: a bare key and a quoted one, quotes included", () => {
    contractsProject(
      'export default {\n  for: { attributes: {} },\n  "else-if": { attributes: {} },\n};\n',
    );
    expect(
      scan("page.mx").diagnostics.map((d) => [d.code, d.line, d.column, d.end]),
    ).toEqual([
      [RESERVED_CODE, 2, 2, { line: 2, column: 5 }],
      [RESERVED_CODE, 3, 2, { line: 3, column: 11 }],
    ]);
  });

  it("states no end where it cannot name the key (the module's 1:0)", () => {
    contractsProject(
      "const base = { for: { attributes: {} } };\nexport default { ...base };\n",
    );
    const [diagnostic] = scan("page.mx").diagnostics;
    expect([diagnostic?.code, diagnostic?.line, diagnostic?.column]).toEqual([
      RESERVED_CODE,
      1,
      0,
    ]);
    expect(diagnostic).not.toHaveProperty("end");
  });

  it("is reported at the module's 1:0 when the exported object is not a literal", () => {
    contractsProject(
      "const build = () => ({ for: { attributes: {} }, box: { attributes: {} } });\nexport default build();\n",
    );
    const result = scan("page.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      expect.objectContaining({
        file: "contracts.ts",
        line: 1,
        column: 0,
        severity: "error",
        code: RESERVED_CODE,
      }),
    ]);
    expect(Object.keys(result.customTags)).toEqual(["box"]);
  });

  it("is reported at 1:0 when the key comes from a spread", () => {
    contractsProject(
      "const base = { for: { attributes: {} } };\nexport default { ...base, box: { attributes: {} } };\n",
    );
    expect(scan("page.mx").diagnostics.map(shown)).toEqual([
      expect.objectContaining({ line: 1, column: 0, code: RESERVED_CODE }),
    ]);
  });

  it("under a dialect: its own reserved name is refused, naming `mx.contracts`", () => {
    contractsProject(
      "export default {\n  entity: { attributes: {} },\n  box: { attributes: {} },\n};\n",
    );
    const result = scan("page.kit.mx");
    expect(result.diagnostics.map(shown)).toEqual([
      {
        file: "contracts.ts",
        message:
          "`<entity>` cannot be defined by `mx.contracts`: Kit reserves it",
        line: 2,
        column: 2,
        // `entity` is 6 characters: the range covers the key.
        end: { line: 2, column: 8 },
        severity: "error",
        code: RESERVED_CODE,
      },
    ]);
    expect(Object.keys(result.customTags)).toEqual(["box"]);
  });

  it("under a dialect: an MX file may define the dialect's reserved name", () => {
    contractsProject("export default { entity: { attributes: {} } };\n");
    const result = scan("page.mx");
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.customTags)).toEqual(["entity"]);
  });
});

describe("passed `customTags`", () => {
  const call = (name: string) => CALLS[name as keyof typeof CALLS];

  /** What the call lowers to with no definition at all. */
  const baseline = (name: string, options: LowerSourceOptions = {}) =>
    lowerSource(call(name), "t.mx", { tagRules: "none", ...options });

  it.each(RESERVED_NAMES)(
    "`%s`: an MX_RESERVED_TAG error, and the call lowers as if the definition were absent",
    (name) => {
      const result = lowerSource(call(name), "t.mx", {
        tagRules: "none",
        customTags: { [name]: DEFINITION },
      });
      const base = baseline(name);
      const reserved = result.diagnostics.filter(
        (diagnostic) => diagnostic.code === RESERVED_CODE,
      );
      expect(reserved.length).toBeGreaterThan(0);
      for (const diagnostic of reserved) {
        expect(diagnostic.severity).toBe("error");
        expect(diagnostic.message).toContain(`\`<${name}>\` cannot name`);
      }
      // No partial IR beside an error, as for every error.
      expect(result.ir).toBeUndefined();
      // Everything else is what the call gives with no definition: the
      // definition's own contract (`zzz` required) is not applied.
      // (A name core errors on by itself, `else` or `try`, has that error
      // merged into the coded one: same text, same place, one diagnostic.)
      const merged = (d: (typeof base.diagnostics)[number]) =>
        reserved.some(
          (r) =>
            r.message === d.message &&
            r.line === d.line &&
            r.column === d.column,
        );
      expect(others(result)).toEqual(
        base.diagnostics.filter((d) => !merged(d)),
      );
    },
  );

  it.each(["if", "for", "const", "else-if"])(
    "`%s` was silently ignored before; the definition is now refused at each call site",
    (name) => {
      const source = `<p/>\n${call(name)}${call(name)}`;
      const result = lowerSource(source, "t.mx", {
        tagRules: "none",
        customTags: { [name]: DEFINITION },
      });
      const reserved = result.diagnostics.filter(
        (diagnostic) => diagnostic.code === RESERVED_CODE,
      );
      const first = source.indexOf(`<${name}`);
      const second = source.indexOf(`<${name}`, first + 1);
      expect(reserved.map((d) => [d.line, d.column, d.offset])).toEqual([
        [2, 0, first],
        [3, 0, second],
      ]);
    },
  );

  it("`if` still lowers to an IfChain: the same source without the definition", () => {
    const source = "<if=true><p/></if>\n";
    expect(
      lowerSource(source, "t.mx", { tagRules: "none" }).ir?.body.map(
        (node) => node.kind,
      ),
    ).toEqual(["IfChain"]);
    const refused = lowerSource(source, "t.mx", {
      tagRules: "none",
      // A definition that would reject this `<if>` outright if it were honored.
      customTags: { if: { parents: ["nowhere"], children: {} } },
    });
    expect(refused.diagnostics).toEqual([
      expect.objectContaining({
        code: RESERVED_CODE,
        severity: "error",
        line: 1,
        column: 0,
        offset: 0,
        message: expect.stringContaining("`<if>` cannot name a data tag"),
      }),
    ]);
  });

  it("`structural: reject` still rejects the `<if>`, beside the refusal", () => {
    const result = lowerSource("<if=true><p/></if>\n", "t.mx", {
      tagRules: "none",
      structural: "reject",
      customTags: { if: DEFINITION },
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      RESERVED_CODE,
      "MX_STRUCTURAL_CONSTRUCT",
    ]);
    expect(result.diagnostics[1]?.message).toContain("Data files are static");
  });

  it("a name never called is reported at the source's 1:0", () => {
    const result = lowerSource("<p/>\n<q/>\n", "t.mx", {
      tagRules: "none",
      customTags: { for: DEFINITION, import: DEFINITION },
    });
    expect(
      result.diagnostics.map((d) => [d.code, d.line, d.column, d.offset]),
    ).toEqual([
      [RESERVED_CODE, 1, 0, 0],
      [RESERVED_CODE, 1, 0, 0],
    ]);
  });

  it("a source that does not parse reports the refusal at 1:0 beside the parse error", () => {
    const result = lowerSource("<p>\n", "t.mx", {
      tagRules: "none",
      customTags: { for: DEFINITION },
    });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code ?? "parse")).toContain(
      RESERVED_CODE,
    );
    const refusal = result.diagnostics.find((d) => d.code === RESERVED_CODE);
    expect([refusal?.line, refusal?.column, refusal?.offset]).toEqual([
      1, 0, 0,
    ]);
  });

  it("refusals and other errors are merged by position", () => {
    const result = lowerSource("<for|x| of=[1]/>\n<mystery/>\n", "t.mx", {
      tagRules: "none",
      unknownTags: "reject",
      customTags: { for: DEFINITION },
    });
    expect(result.diagnostics.map((d) => [d.line, d.code])).toEqual([
      [1, RESERVED_CODE],
      [2, "MX_UNKNOWN_TAG"],
    ]);
  });

  it("with the other definitions kept: only the reserved one is dropped", () => {
    const result = lowerSource("<box/>\n<for|x| of=[1]><p/></for>\n", "t.mx", {
      tagRules: "none",
      unknownTags: "reject",
      customTags: { box: { attributes: {} }, for: DEFINITION },
    });
    // `<p>` is unknown; `<box>` is known; `<for>` is core's loop.
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      [RESERVED_CODE, 2],
      ["MX_UNKNOWN_TAG", 2],
    ]);
  });

  it("is delivered through `diagnostics`, never as a throw", () => {
    for (const name of RESERVED_NAMES) {
      expect(() =>
        lowerSource(call(name), "t.mx", {
          customTags: { [name]: { parseOptions: { openTagOnly: true } } },
        }),
      ).not.toThrow();
    }
  });

  describe("a dialect's reserved names", () => {
    it("are refused when the file routes to the dialect and the call passes no `dialect`", () => {
      kitProject();
      const result = lowerSource(
        "<entity/>\n<entity/>\n",
        join(dir, "a.kit.mx"),
        {
          customTags: { entity: DEFINITION },
        },
      );
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: RESERVED_CODE,
          severity: "error",
          message:
            "`<entity>` cannot be defined by `customTags`: Kit reserves it",
          line: 1,
          column: 0,
          offset: 0,
        }),
        expect.objectContaining({
          code: RESERVED_CODE,
          line: 2,
          column: 0,
          offset: 10,
        }),
      ]);
    });

    it("are the dialect's own when `customTags` come with `dialect: X`: not flagged", () => {
      kitProject();
      const result = lowerSource("<entity/>\n", join(dir, "a.kit.mx"), {
        dialect: { id: "kit", name: "Kit", table: {} },
        customTags: { entity: { attributes: {} } },
        unknownTags: "reject",
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.ir?.body).toHaveLength(1);
    });

    it("are not flagged under an MX file", () => {
      kitProject();
      const result = lowerSource("<entity/>\n", join(dir, "a.mx"), {
        customTags: { entity: { attributes: {} } },
        unknownTags: "reject",
      });
      expect(result.diagnostics).toEqual([]);
    });

    it("core names are still flagged under `dialect: X` (the dialect cannot unreserve them)", () => {
      kitProject();
      const result = lowerSource(
        "<for|x| of=[1]><p/></for>\n",
        join(dir, "a.kit.mx"),
        {
          dialect: { id: "kit", name: "Kit", table: {} },
          customTags: { for: DEFINITION, entity: { attributes: {} } },
        },
      );
      expect(result.diagnostics.map((d) => [d.code, d.line, d.column])).toEqual(
        [[RESERVED_CODE, 1, 0]],
      );
    });

    it("a refused call gets its MX_RESERVED_TAG and no MX_UNKNOWN_TAG: one diagnostic per occurrence", () => {
      kitProject();
      const source = "<entity/>\n<entity/>\n";
      const result = lowerSource(source, join(dir, "a.kit.mx"), {
        unknownTags: "reject",
        customTags: { entity: DEFINITION },
      });
      expect(result.diagnostics.map((d) => [d.code, d.line, d.column])).toEqual(
        [
          [RESERVED_CODE, 1, 0],
          [RESERVED_CODE, 2, 0],
        ],
      );
    });

    it("the same, when the compile itself fails and the unknown scan runs instead", () => {
      kitProject();
      const result = lowerSource(
        "<entity/>\n<else/>\n<mystery/>\n",
        join(dir, "a.kit.mx"),
        { unknownTags: "reject", customTags: { entity: DEFINITION } },
      );
      const named = (code: string) =>
        result.diagnostics
          .filter((d) => d.code === code)
          .map((d) => [d.message.split("`")[1], d.line]);
      expect(named(RESERVED_CODE)).toEqual([["<entity>", 1]]);
      // Only the tag that is really unknown, beside the refused one.
      expect(named("MX_UNKNOWN_TAG")).toEqual([["<mystery>", 3]]);
    });

    it("another unknown tag in the source is still reported", () => {
      kitProject();
      const result = lowerSource(
        "<entity/>\n<mystery/>\n",
        join(dir, "a.kit.mx"),
        { unknownTags: "reject", customTags: { entity: DEFINITION } },
      );
      expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
        [RESERVED_CODE, 1],
        ["MX_UNKNOWN_TAG", 2],
      ]);
    });

    describe("a refused call inside a closed parent gets MX_RESERVED_TAG alone", () => {
      const closed: CustomTag = { children: { item: {} } };
      const shown = (result: LowerSourceResult) =>
        result.diagnostics.map((d) => [d.code ?? "core", d.line, d.column]);

      // `unknownTags` unset takes the early failure path; `reject` takes the
      // unknown-tag scan; both must drop the not-allowed error.
      it.each([
        ["the failure path (unknownTags allow)", undefined],
        ["the unknown-tag scan (unknownTags reject)", "reject" as const],
      ])("%s", (_label, unknownTags) => {
        kitProject();
        const result = lowerSource(
          "<box><entity/></box>\n",
          join(dir, "a.kit.mx"),
          {
            ...(unknownTags ? { unknownTags } : {}),
            customTags: { box: closed, entity: DEFINITION },
          },
        );
        expect(result.ir).toBeUndefined();
        expect(shown(result)).toEqual([[RESERVED_CODE, 1, 5]]);
      });

      it("a sibling that is only not allowed keeps its MX_TAG_NOT_ALLOWED", () => {
        kitProject();
        const result = lowerSource(
          "<box><other/><entity/></box>\n",
          join(dir, "a.kit.mx"),
          { customTags: { box: closed, entity: DEFINITION } },
        );
        expect(shown(result)).toEqual([
          ["MX_TAG_NOT_ALLOWED", 1, 5],
          [RESERVED_CODE, 1, 13],
        ]);
      });

      it("the same name at a second call site that is allowed elsewhere still gets its refusal", () => {
        kitProject();
        const result = lowerSource(
          "<entity/>\n<box><entity/></box>\n",
          join(dir, "a.kit.mx"),
          {
            unknownTags: "reject",
            customTags: { box: closed, entity: DEFINITION },
          },
        );
        expect(shown(result)).toEqual([
          [RESERVED_CODE, 1, 0],
          [RESERVED_CODE, 2, 5],
        ]);
      });

      it("a core name inside a closed parent: the same, on the same occurrence", () => {
        const result = lowerSource("<box><for|x| of=[1]/></box>\n", "t.mx", {
          tagRules: "none",
          customTags: { box: closed, for: DEFINITION },
        });
        expect(shown(result)).toEqual([[RESERVED_CODE, 1, 5]]);
      });
    });

    it.each(RESERVED_NAMES)(
      "core name `%s`: no call resolves unknown by itself, so the refusal never doubles",
      (name) => {
        // The probe behind the claim: with no definition at all, `unknownTags:
        // reject` never reports the core name itself as unknown. Every core
        // name is a body construct or a core-owned tag.
        const base = lowerSource(CALLS[name], "t.mx", {
          tagRules: "none",
          unknownTags: "reject",
        });
        expect(
          base.diagnostics.filter(
            (d) =>
              d.code === "MX_UNKNOWN_TAG" &&
              d.message.includes(`\`<${name}>\``),
          ),
        ).toEqual([]);
        const refused = lowerSource(CALLS[name], "t.mx", {
          tagRules: "none",
          unknownTags: "reject",
          customTags: { [name]: DEFINITION },
        });
        expect(
          refused.diagnostics.filter(
            (d) =>
              d.code === "MX_UNKNOWN_TAG" &&
              d.message.includes(`\`<${name}>\``),
          ),
        ).toEqual([]);
      },
    );
  });
});

describe("`try`: a diagnostic from lowerSource, a throw from the template compilers", () => {
  const shadow: CustomTag = { parseOptions: { openTagOnly: true } };
  const MESSAGE =
    "`<try>` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name";

  it("lowerSource: a positioned MX_RESERVED_TAG diagnostic at the call, no throw", () => {
    const result = lowerSource("<p/>\n<try><p/></try>\n", "t.mx", {
      tagRules: "none",
      customTags: { try: shadow },
    });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.filter((d) => d.code === RESERVED_CODE)).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 2,
        column: 0,
        offset: 5,
        message: expect.stringContaining("`<try>` cannot name a data tag"),
      }),
    ]);
  });

  it("lowerFile is lowerSource over a file: the same diagnostic, no throw", () => {
    const file = write("t.mx", "<try><p/></try>\n");
    const result = lowerFile(file, {
      tagRules: "none",
      customTags: { try: shadow },
    });
    expect(result.diagnostics.map((d) => [d.code ?? "core", d.line])).toEqual([
      [RESERVED_CODE, 1],
    ]);
  });

  it("the template compiler (`compileSource`) keeps its throw", () => {
    const policy: Policy = {
      tags: {},
      isElement: () => true,
      isComponent: () => false,
      isDelegatedTag: (name) => name === "try",
      resolveDelegatedTag: (name) => ({ name }),
    };
    let caught: unknown;
    try {
      compileSource(
        "<try><p>x</p></try>\n",
        "/tmp/mx-core-test/try.mx",
        policy,
        {
          customTags: { try: shadow },
          targets: lookup,
          tagDiscoveryDirs: [],
          emitIr: () => "",
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TranslateError);
    expect(isTranslateError(caught) && caught.message).toBe(MESSAGE);
    expect(isTranslateError(caught) && [caught.line, caught.column]).toEqual([
      1, 0,
    ]);
  });

  it("the registration check (`compile` and the fragment path) keeps its throw", () => {
    expect(() => rejectShadowedRegistration({ try: shadow })).toThrowError(
      MESSAGE,
    );
  });
});
