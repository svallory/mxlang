/**
 * `tagDirs: []` closes MX's generic `tags/` to a dialect's files: an absent
 * `tagDirs` means `["tags"]`, an empty one means no directory at all. The
 * manifest field's other errors are pinned in `dialect-discovery.test.ts`; the
 * dialect-owned directories in `dialect-tag-dirs.test.ts`.
 *
 * The test dialect `kit` (claiming `.kit.mx`) is a fixture, not any real one.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";
import {
  CORE_TAG_DISCOVERY,
  callerTagDiscovery,
  type ScanResult,
  scanCustomTags,
} from "./scan.ts";
import { clearScanCache, scanCached } from "./scan-cache.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();

let dir: string;
beforeEach(() => {
  dir = realpathSync(
    mkdtempSync(join(process.env.TMPDIR ?? homedir(), "mx-tag-dirs-empty-")),
  );
  clearScanCache();
});
afterEach(() => {
  clearScanCache();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text = "<div/>\n"): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** A project whose `kit` dialect declares `fields` over its identity. */
function kitProject(fields: Record<string, unknown> = {}) {
  return dialectProject(dir, {
    packageName: "kit-dialect",
    manifest: { id: "kit", name: "Kit", extensions: [".kit.mx"], ...fields },
    module: "export default { table: {} };",
  });
}

/**
 * `tags/` defines `<card>` as an MX template and `<badge>` and `<chip>` as
 * contract sidecars. A dialect file has no target, so only the sidecars are
 * callable from one: it cannot call a template tag.
 */
function writeTagsDir() {
  write("tags/card.mx", "<div/>\n");
  write("tags/badge.tag.ts", "export default {};\n");
  write("tags/chip.tag.ts", "export default {};\n");
}

const scan = (page: string): ScanResult =>
  scanCustomTags(join(dir, page), { targets });

const names = (result: ScanResult) => [...result.tags.keys()].sort();

/** Lowers `source` as `page` under `unknownTags: "reject"`. */
function lower(source: string, page: string) {
  const file = join(dir, page);
  const { customTags } = scanCached(file, { targets });
  return lowerSource(source, file, { customTags, unknownTags: "reject" });
}

const brief = (result: ReturnType<typeof lower>) =>
  result.diagnostics.map(({ message, line, column, code }) => ({
    message,
    line,
    column,
    code,
  }));

/** The exact text `unknownTags: "reject"` gives a call nothing defines. */
const unknown = (name: string, line: number, column: number) => ({
  message: `\`<${name}>\` is not a known tag in the \`kit\` dialect`,
  line,
  column,
  code: "MX_UNKNOWN_TAG",
});

describe('an absent `tagDirs` still means `["tags"]` (control)', () => {
  it("the dialect's files discover the `tags/` definitions", () => {
    writeTagsDir();
    kitProject();
    expect(callerTagDiscovery(join(dir, "page.kit.mx"))).toMatchObject({
      id: "kit",
      tagDirs: ["tags"],
      kind: "templates",
    });
    expect(names(scan("page.kit.mx"))).toEqual(["badge", "card", "chip"]);
  });

  it('(c) `<badge/>` and `<chip/>` are known under `unknownTags: "reject"`', () => {
    writeTagsDir();
    kitProject();
    expect(brief(lower("<badge/>\n<chip/>\n", "page.kit.mx"))).toEqual([]);
  });
});

describe("`tagDirs: []` closes `tags/` to the dialect's files", () => {
  it("the discovery lists no directory and still claims the dialect's extensions", () => {
    writeTagsDir();
    kitProject({ tagDirs: [] });
    expect(callerTagDiscovery(join(dir, "page.kit.mx"))).toMatchObject({
      id: "kit",
      tagDirs: [],
      extensions: [".kit.mx"],
      kind: "tag-files",
    });
  });

  it("a scan from a dialect file finds nothing in `tags/` and lists no directory", () => {
    writeTagsDir();
    kitProject({ tagDirs: [] });
    const result = scan("page.kit.mx");
    expect(names(result)).toEqual([]);
    expect(result.directories).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('(a) lowerSource: a `tags/` tag is unknown under `unknownTags: "reject"`', () => {
    writeTagsDir();
    kitProject({ tagDirs: [] });
    expect(brief(lower("<chip/>\n<badge/>\n", "page.kit.mx"))).toEqual([
      unknown("chip", 1, 0),
      unknown("badge", 2, 0),
    ]);
  });

  it("a `tags/` directory added later is still not read (no cache fallback)", () => {
    kitProject({ tagDirs: [] });
    const file = join(dir, "page.kit.mx");
    expect(Object.keys(scanCached(file, { targets }).customTags)).toEqual([]);
    writeTagsDir();
    expect(Object.keys(scanCached(file, { targets }).customTags)).toEqual([]);
    clearScanCache();
    expect(Object.keys(scanCached(file, { targets }).customTags)).toEqual([]);
  });

  it("editing the manifest from `[]` to absent re-scans and opens `tags/`", () => {
    writeTagsDir();
    const { packageFile } = kitProject({ tagDirs: [] });
    const file = join(dir, "page.kit.mx");
    expect(Object.keys(scanCached(file, { targets }).customTags)).toEqual([]);
    const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
    delete manifest.mx.dialect.tagDirs;
    writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
    // Bump the mtime past the stamp's resolution.
    const later = new Date(Date.now() + 5000);
    utimesSync(packageFile, later, later);
    expect(
      Object.keys(scanCached(file, { targets }).customTags).sort(),
    ).toEqual(["badge", "card", "chip"]);
  });

  it("a dialect's own tag file in `tags/` is still skipped from an MX file, with a warning that says the dialect reads no directory", () => {
    kitProject({ tagDirs: [], tagExtensions: [".component.kit.mx"] });
    write("tags/button.kit.mx");
    write("tags/card.mx");
    const result = scan("page.mx");
    expect(names(result)).toEqual(["card"]);
    expect(
      result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        file: relative(dir, diagnostic.file),
      })),
    ).toEqual([
      {
        file: "tags/button.kit.mx",
        message:
          "`tags/button.kit.mx` is a Kit file in `tags/`; Kit discovers no tag directories.",
        line: 1,
        column: 0,
        severity: "warning",
        code: "MX_MISPLACED_TAG_FILE",
      },
    ]);
  });

  it("(e) an `.mx` file in the same project still gets `tags/`", () => {
    writeTagsDir();
    kitProject({ tagDirs: [] });
    expect(callerTagDiscovery(join(dir, "page.mx"))).toBe(CORE_TAG_DISCOVERY);
    expect(names(scan("page.mx"))).toEqual(["badge", "card", "chip"]);
    expect(brief(lower("<badge/>\n<chip/>\n", "page.mx"))).toEqual([]);
  });

  it("`mx.tags` still reaches the dialect's files: `tagDirs` and `mxConfigTags` are separate", () => {
    write("defs/pill.tag.ts", "export default {};\n");
    dialectProject(dir, {
      packageName: "kit-dialect",
      manifest: {
        id: "kit",
        name: "Kit",
        extensions: [".kit.mx"],
        tagDirs: [],
      },
      module: "export default { table: {} };",
      mx: { tags: "./defs" },
    });
    expect(names(scan("page.kit.mx"))).toEqual(["pill"]);
  });
});

describe("`tagDirs: []` leaves `tagExtensions` and the `tagFile` hook alone", () => {
  const hooked = (fields: Record<string, unknown>) =>
    dialectProject(dir, {
      packageName: "kit-dialect",
      manifest: { id: "kit", name: "Kit", extensions: [".kit.mx"], ...fields },
      module: `export default {
        table: {},
        tagFile() {
          globalThis.__kitEmptyRuns = (globalThis.__kitEmptyRuns ?? 0) + 1;
          return { contract: {} };
        },
      };`,
    });
  const runs = () =>
    (globalThis as unknown as { __kitEmptyRuns?: number }).__kitEmptyRuns ?? 0;
  beforeEach(() => {
    (globalThis as unknown as { __kitEmptyRuns?: number }).__kitEmptyRuns = 0;
  });

  it('control: with `tagDirs: ["components"]` the hook reads the tag file at the call', () => {
    write("components/money.kit.mx");
    hooked({ tagDirs: ["components"] });
    expect(brief(lower("<money/>\n", "page.kit.mx"))).toEqual([]);
    expect(runs()).toBe(1);
  });

  it("with `tagDirs: []` no tag file is found, so the hook never runs", () => {
    write("components/money.kit.mx");
    write("tags/money.kit.mx");
    hooked({ tagDirs: [] });
    expect(brief(lower("<money/>\n", "page.kit.mx"))).toEqual([
      unknown("money", 1, 0),
    ]);
    expect(runs()).toBe(0);
  });

  it("`tagExtensions` still routes a file to the dialect", () => {
    hooked({ tagDirs: [], tagExtensions: [".component.kit.mx"] });
    expect(
      callerTagDiscovery(join(dir, "money.component.kit.mx")),
    ).toMatchObject({
      id: "kit",
      tagDirs: [],
      extensions: [".kit.mx", ".component.kit.mx"],
    });
  });
});

describe("the `tagDirs` field", () => {
  const FIELD =
    '`mx.dialect.tagDirs` must be an array of the directory names the dialect\'s files discover tags in (`["components"]`), or `[]` for none';

  /** The manifest error a dialect file's compile reports (package.json line 11, column 6). */
  function manifestError(fields: Record<string, unknown>) {
    kitProject(fields);
    return brief(lower("<!-- ok -->\n", "page.kit.mx"));
  }

  it("(d) a string is still an error at the field, in the new words", () => {
    expect(manifestError({ tagDirs: "tags" })).toEqual([
      {
        message: FIELD,
        line: 11,
        column: 6,
        code: "MX_INVALID_DIALECT_MANIFEST",
      },
    ]);
  });

  it.each([
    ["an object", { tagDirs: {} }],
    ["a number", { tagDirs: 1 }],
  ])("%s is the same error", (_name, fields) => {
    expect(manifestError(fields)).toEqual([
      {
        message: FIELD,
        line: 11,
        column: 6,
        code: "MX_INVALID_DIALECT_MANIFEST",
      },
    ]);
  });

  it("an array with a bad entry is still an error", () => {
    expect(manifestError({ tagDirs: [7] })).toEqual([
      {
        message: "`mx.dialect.tagDirs`: 7 is not a directory name",
        line: 11,
        column: 6,
        code: "MX_INVALID_DIALECT_MANIFEST",
      },
    ]);
  });

  it("a repeated entry is still an error", () => {
    expect(manifestError({ tagDirs: ["a", "a"] })).toEqual([
      {
        message: "`mx.dialect.tagDirs` lists `a` twice",
        line: 11,
        column: 6,
        code: "MX_INVALID_DIALECT_MANIFEST",
      },
    ]);
  });

  it("`[]` is a valid manifest: the file compiles clean", () => {
    expect(manifestError({ tagDirs: [] })).toEqual([]);
  });
});
