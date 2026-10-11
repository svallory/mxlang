/**
 * Dialect tag directories (dialect tag discovery, slice 1): a dialect's
 * `tagDirs`, `tagExtensions` and `sidecars` decide what a file of that
 * dialect discovers, per calling file. Core is dialect zero: `tags/`, `.mx`
 * templates, sidecars on. The manifest fields' own errors are pinned in
 * `dialect-discovery.test.ts`; the scan cache's stamps and invalidation in
 * `scan-cache-stamps.test.ts`.
 *
 * The test dialect `kit` (claiming `.kit.mx`, scanning `components/`) is a
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
import { contractDefaultTagDiagnostics } from "./contract-default-tag.ts";
import { isTranslateError } from "./core.ts";
import { type CustomTag, deferContract } from "./custom-tags.ts";
import { lowerSource } from "./ir-entry/index.ts";
import {
  CORE_TAG_DISCOVERY,
  callerTagDiscovery,
  discoverProjectTags,
  type ScanResult,
  scanCustomTags,
} from "./scan.ts";
import { clearScanCache, scanCached } from "./scan-cache.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-dialect-tag-dirs-")));
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

const KIT = {
  id: "kit",
  name: "Kit",
  extensions: [".kit.mx"],
  tagDirs: ["components"],
};

/** A project using the `kit` test dialect, with `fields` over its manifest. */
function kitProject(fields: Record<string, unknown> = {}, mx?: unknown) {
  return dialectProject(dir, {
    packageName: "kit-dialect",
    manifest: { ...KIT, ...fields },
    module: "export default { table: {} };",
    ...(mx === undefined ? {} : { mx }),
  });
}

const scan = (file: string): ScanResult =>
  scanCustomTags(join(dir, file), { targets });

const names = (result: ScanResult) => [...result.tags.keys()].sort();

const diagnosticsOf = (result: ScanResult) =>
  result.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    file: relative(dir, diagnostic.file),
  }));

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("core is dialect zero", () => {
  it("an MX file discovers `tags/` with `.mx` templates and sidecars", () => {
    kitProject();
    expect(callerTagDiscovery(join(dir, "page.mx"))).toBe(CORE_TAG_DISCOVERY);
    expect(CORE_TAG_DISCOVERY).toMatchObject({
      tagDirs: ["tags"],
      extensions: [".mx"],
      sidecars: true,
      kind: "templates",
    });
  });

  it("a dialect file discovers its own `tagDirs`", () => {
    kitProject({ tagExtensions: [".component.kit.mx"] });
    expect(callerTagDiscovery(join(dir, "page.kit.mx"))).toMatchObject({
      id: "kit",
      tagDirs: ["components"],
      extensions: [".kit.mx", ".component.kit.mx"],
      sidecars: true,
      kind: "tag-files",
    });
  });

  it("a file whose routing fails scans as MX: the compile reports the routing error", () => {
    dialectProject(dir, {
      packageName: "a-dialect",
      manifest: { id: "a", name: "A", extensions: [".tst"], tagDirs: ["c"] },
    });
    dialectProject(dir, {
      packageName: "b-dialect",
      manifest: { id: "b", name: "B", extensions: [".tst"] },
    });
    expect(callerTagDiscovery(join(dir, "page.tst"))).toBe(CORE_TAG_DISCOVERY);
  });
});

// One fixture per row of the design's §2.3 precedence table (`.kit.mx`
// standing in for the table's `.mesh.mx`).
describe("names and claims (design §2.3)", () => {
  it("`components/button.kit.mx` from a dialect file is `<button>`, read through the dialect", () => {
    kitProject();
    const file = write("components/button.kit.mx");
    const result = scan("page.kit.mx");
    expect(names(result)).toEqual(["button"]);
    expect(result.tags.get("button")).toMatchObject({
      tagFile: file,
      dialect: "kit",
    });
    expect(result.tags.get("button")?.template).toBeUndefined();
    // The routed dialect's module is stamped too, so an edit to it rescans.
    expect(result.files.map((entry) => entry.path)).toEqual([
      join(dir, "node_modules/kit-dialect/index.mjs"),
      file,
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("`components/button.kit.mx` from an MX file is not scanned", () => {
    kitProject();
    write("components/button.kit.mx");
    const result = scan("page.mx");
    expect(names(result)).toEqual([]);
    expect(result.directories).not.toContain(join(dir, "components"));
  });

  it("`tags/button.kit.mx` from an MX file is skipped as the dialect's, with a misplaced-file warning", () => {
    kitProject();
    write("tags/button.kit.mx");
    write("tags/card.mx");
    const result = scan("page.mx");
    expect(names(result)).toEqual(["card"]);
    expect(diagnosticsOf(result)).toEqual([
      {
        file: "tags/button.kit.mx",
        message:
          "`tags/button.kit.mx` is a Kit file in `tags/`; Kit discovers tags in `components/`.",
        line: 1,
        column: 0,
        severity: "warning",
        code: "MX_MISPLACED_TAG_FILE",
      },
    ]);
  });

  it("`components/money.component.kit.mx` with `tagExtensions` is `<money>`", () => {
    kitProject({ tagExtensions: [".component.kit.mx"] });
    write("components/money.component.kit.mx");
    const result = scan("page.kit.mx");
    expect(names(result)).toEqual(["money"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("the same file without `tagExtensions` is `<money.component>`, with a warning naming the fix", () => {
    kitProject();
    write("components/money.component.kit.mx");
    const result = scan("page.kit.mx");
    expect(names(result)).toEqual(["money.component"]);
    expect(diagnosticsOf(result)).toEqual([
      {
        file: "components/money.component.kit.mx",
        message:
          "`components/money.component.kit.mx` is named `<money.component>`, which a call cannot write as one tag name; declare `.component.kit.mx` in `tagExtensions` to name it `<money>`",
        line: 1,
        column: 0,
        severity: "warning",
        code: "MX_DOTTED_TAG_FILE_NAME",
      },
    ]);
  });

  it("`components/x.tag.ts` with `sidecars: false` is ignored, with a warning", () => {
    kitProject({ sidecars: false });
    write("components/x.tag.ts", "export default {};\n");
    write("components/y.kit.mx");
    const result = scan("page.kit.mx");
    expect(names(result)).toEqual(["y"]);
    expect(diagnosticsOf(result)).toEqual([
      {
        file: "components/x.tag.ts",
        message:
          "`components/x.tag.ts` is ignored: Kit tag directories do not read `.tag.ts` sidecars (`sidecars: false`)",
        line: 1,
        column: 0,
        severity: "warning",
        code: "MX_SIDECAR_IGNORED",
      },
    ]);
  });

  it("`components/x.tag.ts` with sidecars on is `<x>`'s sidecar: static `parseOptions` from it, the contract from the tag file", () => {
    kitProject();
    const sidecar = write(
      "components/x.tag.ts",
      "export default { parseOptions: { text: true } };\n",
    );
    const tagFile = write("components/x.kit.mx");
    const result = scan("page.kit.mx");
    expect(result.tags.get("x")).toMatchObject({
      sidecar,
      tagFile,
      dialect: "kit",
      parseOptions: { text: true },
    });
    const x = result.customTags.x;
    expect(x?.parseOptions).toEqual({ text: true });
    // Hookless: the contract cannot be read, whatever the sidecar declares.
    expect(thrown(() => x?.attributes)).toMatchObject({
      diagnosticCode: "MX_TAG_FILE_ERROR",
    });
  });

  it("a sidecar alone in a dialect tag directory is a contract-only tag, as in `tags/`", () => {
    kitProject();
    write(
      "components/solo.tag.ts",
      "export default { attributes: { a: {} } };\n",
    );
    const result = scan("page.kit.mx");
    expect(result.tags.get("solo")?.tagFile).toBeUndefined();
    expect(result.customTags.solo?.attributes).toEqual({ a: {} });
  });

  it("`tags/x.tag.ts` from an MX file is today's contract-only sidecar", () => {
    kitProject();
    const sidecar = write(
      "tags/x.tag.ts",
      "export default { attributes: { a: {} } };\n",
    );
    const result = scan("page.mx");
    expect(result.tags.get("x")).toMatchObject({ sidecar });
    expect(result.customTags.x?.attributes).toEqual({ a: {} });
  });

  it("`tags/card.mx` and `components/card.kit.mx` do not collide: each caller sees its own", () => {
    kitProject();
    const template = write("tags/card.mx");
    const tagFile = write("components/card.kit.mx");
    expect(scan("page.mx").tags.get("card")).toMatchObject({ template });
    expect(scan("page.mx").tags.get("card")?.tagFile).toBeUndefined();
    expect(scan("page.kit.mx").tags.get("card")).toMatchObject({ tagFile });
    expect(scan("page.kit.mx").tags.get("card")?.template).toBeUndefined();
  });

  it("`q.b.a.mx` routes to the dialect claiming the longer suffix, and is its tag only in its own `tagDirs`", () => {
    dialectProject(dir, {
      packageName: "a-dialect",
      manifest: { id: "a", name: "A", extensions: [".a.mx"], tagDirs: ["c"] },
    });
    dialectProject(dir, {
      packageName: "b-dialect",
      manifest: {
        id: "b",
        name: "B",
        extensions: [".b.a.mx"],
        tagDirs: ["c", "bs"],
      },
    });
    write("c/q.b.a.mx");
    write("c/r.a.mx");
    write("bs/s.b.a.mx");
    write("bs/t.a.mx");
    expect(names(scan("page.b.a.mx"))).toEqual(["q", "s"]);
    expect(names(scan("page.a.mx"))).toEqual(["r"]);
    // A's file in B's directory: A does not scan `bs/`, so nothing reads it.
    expect(scan("page.a.mx").diagnostics).toEqual([]);
  });
});

describe("dialect tag directories", () => {
  it("never index `.mx` templates, nor files of the dialect's own other extensions outside its claim", () => {
    kitProject();
    write("components/plain.mx");
    write("components/notes.md", "notes\n");
    write("components/real.kit.mx");
    expect(names(scan("page.kit.mx"))).toEqual(["real"]);
  });

  it("a bad name is a positioned error and the file is skipped, never a throw", () => {
    kitProject();
    write("components/-bad.kit.mx");
    write("components/good.kit.mx");
    const result = scan("page.kit.mx");
    expect(names(result)).toEqual(["good"]);
    expect(diagnosticsOf(result)).toEqual([
      {
        file: "components/-bad.kit.mx",
        message:
          "`components/-bad.kit.mx` is skipped: `-bad` is not a usable tag name; a tag file's name must start with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots",
        line: 1,
        column: 0,
        severity: "error",
        code: "MX_INVALID_TAG_FILE_NAME",
      },
    ]);
  });

  it("MX `tags/` reports a bad name the way a dialect's directory does, and skips the file", () => {
    kitProject();
    write("tags/-bad.mx");
    write("tags/good.mx");
    const result = scan("page.mx");
    expect(names(result)).toEqual(["good"]);
    expect(diagnosticsOf(result)).toEqual([
      {
        file: "tags/-bad.mx",
        message:
          "`tags/-bad.mx` is skipped: `-bad` is not a usable tag name; a tag file's name must start with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots",
        line: 1,
        column: 0,
        severity: "error",
        code: "MX_INVALID_TAG_FILE_NAME",
      },
    ]);
  });

  it("a core-reserved tag name is an MX_RESERVED_TAG error and skipped", () => {
    kitProject();
    write("components/try.kit.mx");
    const result = scan("page.kit.mx");
    expect(names(result)).toEqual([]);
    expect(diagnosticsOf(result)).toEqual([
      expect.objectContaining({
        file: "components/try.kit.mx",
        severity: "error",
        code: "MX_RESERVED_TAG",
      }),
    ]);
  });

  it("a dotfile is never a tag", () => {
    kitProject();
    write("components/.hidden.kit.mx");
    expect(names(scan("page.kit.mx"))).toEqual([]);
    expect(scan("page.kit.mx").diagnostics).toEqual([]);
  });

  it("nearest wins, walking up to the package root, at every `tagDirs` entry", () => {
    kitProject({ tagDirs: ["components", "atoms"] });
    const near = write("app/components/button.kit.mx");
    write("components/button.kit.mx");
    write("atoms/chip.kit.mx");
    write("app/atoms/icon.kit.mx");
    const result = scan("app/page.kit.mx");
    expect(names(result)).toEqual(["button", "chip", "icon"]);
    expect(result.tags.get("button")?.tagFile).toBe(near);
    expect(result.directories).toEqual([
      join(dir, "app/components"),
      join(dir, "app/atoms"),
      join(dir, "components"),
      join(dir, "atoms"),
    ]);
  });

  it("two dialects sharing a directory each see only their own files", () => {
    kitProject();
    dialectProject(dir, {
      packageName: "box-dialect",
      manifest: {
        id: "box",
        name: "Box",
        extensions: [".box.mx"],
        tagDirs: ["components"],
      },
    });
    write("components/button.kit.mx");
    write("components/crate.box.mx");
    const kit = scan("page.kit.mx");
    const box = scan("page.box.mx");
    expect(names(kit)).toEqual(["button"]);
    expect(names(box)).toEqual(["crate"]);
    expect(kit.diagnostics).toEqual([]);
    expect(box.diagnostics).toEqual([]);
  });

  it("`mx.tags` and `mx.contracts` serve a dialect file as they serve an MX file", () => {
    kitProject(
      {},
      {
        tags: [{ dir: "shared", prefix: "ui-" }],
        contracts: "./contracts.mjs",
      },
    );
    write("contracts.mjs", "export default { stamp: { attributes: {} } };\n");
    write("shared/panel.tag.ts", "export default {};\n");
    write("shared/strip.kit.mx");
    write("shared/plain.mx");
    const kit = scan("page.kit.mx");
    // The dialect's kinds apply in an `mx.tags` directory too.
    expect(names(kit)).toEqual(["stamp", "ui-panel", "ui-strip"]);
    expect(kit.tags.get("ui-strip")?.tagFile).toBe(
      join(dir, "shared/strip.kit.mx"),
    );
    const mx = scan("page.mx");
    expect(names(mx)).toEqual(["stamp", "ui-panel", "ui-plain"]);
    expect(diagnosticsOf(mx)).toEqual([
      expect.objectContaining({
        file: "shared/strip.kit.mx",
        code: "MX_MISPLACED_TAG_FILE",
      }),
    ]);
  });

  it("project discovery skips a claimed file in `tags/` with the same warning", () => {
    kitProject();
    write("tags/button.kit.mx");
    write("tags/card.mx");
    const result = discoverProjectTags(dir, { targets });
    expect(names(result)).toEqual(["card"]);
    expect(diagnosticsOf(result).map((d) => d.code)).toEqual([
      "MX_MISPLACED_TAG_FILE",
    ]);
  });

  it("an unclaimed `x.y.mx` in `tags/` keeps the dotted-name diagnostic", () => {
    kitProject();
    write("tags/badge.box.mx");
    const result = scan("page.mx");
    expect(names(result)).toEqual([]);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("`badge.box.mx` cannot be called as a tag"),
    ]);
  });

  it("a dialect without `tagDirs` claims nothing in `tags/`: its files keep the dotted-name diagnostic", () => {
    dialectProject(dir, {
      manifest: { id: "plain", name: "Plain", extensions: [".plain.mx"] },
    });
    write("tags/badge.plain.mx");
    const result = scan("page.mx");
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("`badge.plain.mx` cannot be called as a tag"),
    ]);
  });

  it.each([
    ["an MX file", "page.mx"],
    ["a file of the dialect without `tagDirs`", "page.plain.mx"],
  ])(
    "beside a dialect with `tagDirs`, a dialect without them still claims nothing in `tags/` (from %s)",
    (_, page) => {
      kitProject();
      dialectProject(dir, {
        packageName: "plain-dialect",
        manifest: { id: "plain", name: "Plain", extensions: [".plain.mx"] },
      });
      write("tags/badge.plain.mx");
      write("tags/card.mx");
      const result = scan(page);
      expect(names(result)).toEqual(["card"]);
      expect(result.diagnostics.map((d) => [d.message, d.code])).toEqual([
        [
          expect.stringContaining("`badge.plain.mx` cannot be called as a tag"),
          undefined,
        ],
      ]);
    },
  );

  it("a dialect without `tagDirs` but `sidecars: false` scans `tags/` without sidecars, with the warning", () => {
    dialectProject(dir, {
      manifest: { sidecars: false },
    });
    write("tags/x.tag.ts", "export default {};\n");
    write("tags/card.mx");
    const result = scan("page.tst");
    expect(names(result)).toEqual(["card"]);
    expect(diagnosticsOf(result).map((d) => d.code)).toEqual([
      "MX_SIDECAR_IGNORED",
    ]);
    expect(names(scan("page.mx"))).toEqual(["card", "x"]);
  });
});

describe("a hookless dialect's tag files", () => {
  it("the scan reads no contract: discovery succeeds and the first read throws `MX_TAG_FILE_ERROR`", () => {
    kitProject();
    write("components/money.kit.mx");
    const result = scan("page.kit.mx");
    const money = result.customTags.money;
    expect(money).toBeDefined();
    for (const key of ["attributes", "children", "parents", "defaultTag"]) {
      const error = thrown(() => (money as Record<string, unknown>)[key]);
      expect(error).toMatchObject({
        message:
          "`<money>` is defined by components/money.kit.mx, but dialect `kit` has no tagFile hook to read it.",
        diagnosticCode: "MX_TAG_FILE_ERROR",
      });
    }
  });

  it("the cached scan reads no contract either", () => {
    kitProject();
    write("components/money.kit.mx");
    const file = join(dir, "page.kit.mx");
    const first = scanCached(file, { targets });
    expect(scanCached(file, { targets })).toBe(first);
    expect(thrown(() => first.customTags.money?.attributes)).toMatchObject({
      diagnosticCode: "MX_TAG_FILE_ERROR",
    });
  });
});

/**
 * A dialect without the new fields scans exactly as on `main` before this
 * change: the expected value was captured by running this same fixture
 * against `c8abc120` (`fixtures/scan/no-fields-dialect.snapshot.json`).
 */
describe("a dialect with none of the new fields", () => {
  it("scans exactly as before the fields existed", () => {
    dialectProject(dir, { mx: { tags: [{ dir: "shared", prefix: "ui-" }] } });
    write("tags/button.mx", "<div/>\n");
    write("tags/card.mx", "<div/>\n");
    write(
      "tags/card.tag.ts",
      "export default { parseOptions: { text: true } };\n",
    );
    write("tags/icon.tag.ts", "export default {};\n");
    write("tags/money.tst", "money\n");
    write("tags/money.component.tst", "money\n");
    write("tags/badge.tst.mx", "<div/>\n");
    write("tags/chip.page.mx", "<div/>\n");
    write("tags/README.md", "notes\n");
    write("tags/.hidden.mx", "<div/>\n");
    write("shared/panel.tag.ts", "export default {};\n");
    write("shared/strip.mx", "<div/>\n");
    write("sub/tags/button.mx", "<span/>\n");
    write("sub/tags/x.tag.ts", "export default {};\n");
    write("sub/page.tst", "<button/>\n");
    write("sub/page.mx", "<button/>\n");
    const rel = (path: string) => relative(dir, path).split("\\").join("/");
    const view = (result: ScanResult) => ({
      tags: [...result.tags.values()].map((tag) => ({
        ...tag,
        sourceDir: rel(tag.sourceDir as string),
        ...(tag.template ? { template: rel(tag.template) } : {}),
        ...(tag.sidecar ? { sidecar: rel(tag.sidecar) } : {}),
      })),
      customTags: Object.keys(result.customTags).sort(),
      directories: result.directories.map(rel),
      packageFiles: result.packageFiles.map(rel),
      configFiles: (result.configFiles ?? []).map(rel),
      files: result.files.map((file) => rel(file.path)),
      diagnostics: result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        file: rel(diagnostic.file),
      })),
      hostRestrictions: result.hostRestrictions,
    });
    const actual = JSON.parse(
      JSON.stringify({
        fromDialectFile: view(
          scanCustomTags(join(dir, "sub/page.tst"), { targets }),
        ),
        fromMxFile: view(scanCustomTags(join(dir, "sub/page.mx"), { targets })),
        project: view(discoverProjectTags(dir, { targets })),
      }),
    );
    const expected = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "fixtures/scan/no-fields-dialect.snapshot.json",
        ),
        "utf8",
      ),
    );
    expect(actual).toEqual(expected);
  });
});

/**
 * A hookless dialect's tag file registers by name and static `parseOptions`
 * only; its contract is read at the first call, where the error lands
 * (lead ruling (a)). Every other source keeps registering eagerly.
 */
describe("a deferred contract is read at the call", () => {
  const MESSAGE =
    "`<money>` is defined by components/money.kit.mx, but dialect `kit` has no tagFile hook to read it.";

  function lower(source: string, page = "page.kit.mx") {
    const file = join(dir, page);
    const { customTags } = scanCached(file, { targets });
    return lowerSource(source, file, { customTags });
  }

  const brief = (result: ReturnType<typeof lower>) =>
    result.diagnostics.map(({ message, line, column, code, file }) => ({
      message,
      line,
      column,
      ...(code === undefined ? {} : { code }),
      ...(file === undefined ? {} : { file: relative(dir, file) }),
    }));

  beforeEach(() => {
    kitProject();
    write("components/money.kit.mx");
  });

  it("a file that never calls the tag compiles clean", () => {
    const result = lower("<div>\n  <span/>\n</div>\n");
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toBeDefined();
  });

  it("a call gets `MX_TAG_FILE_ERROR` at the call, naming the tag file", () => {
    expect(brief(lower("<div>\n  <money/>\n</div>\n"))).toEqual([
      { message: MESSAGE, line: 2, column: 2, code: "MX_TAG_FILE_ERROR" },
    ]);
  });

  it("two calls each get it", () => {
    expect(brief(lower("<money/>\n<div>\n    <money/>\n</div>\n"))).toEqual([
      { message: MESSAGE, line: 1, column: 0, code: "MX_TAG_FILE_ERROR" },
      { message: MESSAGE, line: 3, column: 4, code: "MX_TAG_FILE_ERROR" },
    ]);
  });

  it("a parent whose `children` names the deferred tag gets it at the child call", () => {
    write(
      "components/purse.tag.ts",
      "export default { children: { money: {} } };\n",
    );
    expect(brief(lower("<purse>\n  <money/>\n</purse>\n"))).toEqual([
      { message: MESSAGE, line: 2, column: 2, code: "MX_TAG_FILE_ERROR" },
    ]);
  });

  it("a `parents` reference to the deferred tag gets it at the child call", () => {
    write("components/coin.tag.ts", 'export default { parents: ["money"] };\n');
    expect(brief(lower("<money>\n  <coin/>\n</money>\n"))).toEqual([
      { message: MESSAGE, line: 1, column: 0, code: "MX_TAG_FILE_ERROR" },
    ]);
  });

  it('`unknownTags: "reject"` reports the call once, beside an unknown tag', () => {
    const file = join(dir, "page.kit.mx");
    const { customTags } = scanCached(file, { targets });
    // `<nope>` inside `<money>`: the unknown-tag pass walks `<money>`'s
    // children scope, which reads its (unreadable) contract.
    const result = lowerSource("<money>\n  <nope/>\n</money>\n", file, {
      customTags,
      unknownTags: "reject",
    });
    expect(
      result.diagnostics.map(({ line, column, code }) => [line, column, code]),
    ).toEqual([
      [1, 0, "MX_TAG_FILE_ERROR"],
      [2, 2, "MX_UNKNOWN_TAG"],
    ]);
    expect(result.diagnostics[1]?.message).toContain("<nope>");
  });

  it("an MX file in the same project is untouched by it", () => {
    write("tags/card.tag.ts", "export default {};\n");
    expect(lower("<card/>\n", "page.mx").diagnostics).toEqual([]);
  });

  // Eager registration is pinned per source: a contract that fails a
  // registration check fails a file that never calls the tag, as before.
  const UNREACHABLE =
    '`<bad>`: `children["*"]` entry 1 references `contract: "nope"`, which is not a tag reachable from this compile';
  const BAD = '{ children: { "*": { contract: "nope" } } }';

  it.each([
    ["a sidecar", "components/bad.tag.ts", {}],
    [
      "an `mx.tags` sidecar",
      "shared/bad.tag.ts",
      { tags: [{ dir: "shared" }] },
    ],
  ])("%s still registers eagerly", (_, path, mx) => {
    kitProject({}, mx);
    write(path, `export default ${BAD};\n`);
    const result = lower("<div/>\n");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((d) => d.message)).toEqual([UNREACHABLE]);
  });

  it("an `mx.contracts` entry still registers eagerly", () => {
    kitProject({}, { contracts: "./contracts.mjs" });
    write("contracts.mjs", `export default { bad: ${BAD} };\n`);
    const result = lower("<div/>\n");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((d) => d.message)).toEqual([UNREACHABLE]);
  });
});

/**
 * The deferral mechanism itself, on entries whose contract *can* be read:
 * the per-tag registration checks run at the first call, not at
 * registration, and land at the call.
 */
describe("a deferred entry's registration checks run at its call", () => {
  const page = () => join(dir, "page.mx");
  const lowerWith = (source: string, customTags: Record<string, CustomTag>) =>
    lowerSource(source, page(), { customTags }).diagnostics.map(
      ({ message, line, column }) => ({ message, line, column }),
    );

  it.each([
    [
      "a wildcard reference to no tag",
      { children: { "*": { contract: "nope" } } },
      '`<bad>`: `children["*"]` entry 1 references `contract: "nope"`, which is not a tag reachable from this compile',
    ],
    [
      "an unreachable hook",
      { finalize() {} },
      "`<bad>`: a custom tag that defines only `finalize` has no call site and nothing to collect; add a `transform`, an `analyze` or a template file",
    ],
    [
      "an unknown key",
      { children: { x: { bogus: true } } },
      'Unknown key "bogus" in the "x" child declaration of tag "bad"; allowed: repeatable, required',
    ],
  ])("%s", (_, contract, message) => {
    const eager = lowerWith("<div/>\n", { bad: contract as CustomTag });
    const deferred = () => ({
      bad: deferContract({ ...contract } as CustomTag),
    });
    expect(lowerWith("<div/>\n", deferred())).toEqual([]);
    const called = lowerWith("<div>\n  <bad/>\n</div>\n", deferred());
    expect(called).toEqual([{ message, line: 2, column: 2 }]);
    // Registered eagerly, the same contract fails the file that never calls it.
    expect(eager.map((d) => d.message)).toEqual([called[0]?.message]);
  });
});

/**
 * Registration reads no deferred contract, not even through an eager tag's
 * cross-tag check (`children`, `parents`, `children["*"]`, attribute-tag
 * `children`). Those checks run when the deferred tag is called, at the call.
 */
describe("an eager tag's cross-tag checks against a deferred tag", () => {
  const page = () => join(dir, "page.mx");
  const lowerWith = (source: string, customTags: Record<string, CustomTag>) =>
    lowerSource(source, page(), { customTags }).diagnostics.map(
      ({ message, line, column }) => ({ message, line, column }),
    );

  /** A deferred `<item>` declaring `parents: ["somewhere"]`, counting every contract read. */
  function countedItem() {
    let reads = 0;
    const item: CustomTag = {};
    for (const key of [
      "attributes",
      "attributeTags",
      "children",
      "parents",
      "defaultTag",
    ]) {
      Object.defineProperty(item, key, {
        enumerable: true,
        configurable: true,
        get() {
          reads++;
          return key === "parents" ? ["somewhere"] : undefined;
        },
      });
    }
    return { item: deferContract(item), reads: () => reads };
  }

  it.each([
    [
      "an eager parent's `children` names it",
      { list: { children: { item: {} } } },
    ],
    ["an eager child's `parents` names it", { coin: { parents: ["item"] } }],
    [
      'an eager `children["*"]` names it as its contract',
      { list: { children: { "*": { contract: "item" } } } },
    ],
    [
      "an eager attribute tag declares `children` (the check reads every tag)",
      { box: { attributeTags: { slot: { children: { x: {} } } } } },
    ],
  ])(
    "%s: uncalled, nothing is read; called, the eager result lands at the call",
    (_, eager) => {
      const plain = countedItem();
      const call = "<div>\n  <item/>\n</div>\n";
      const tags = (item: CustomTag) => ({
        ...(eager as Record<string, CustomTag>),
        item,
      });

      const uncalled = countedItem();
      expect(lowerWith("<div/>\n", tags(uncalled.item))).toEqual([]);
      expect(uncalled.reads()).toBe(0);

      // Called, the file gets what it gets with `<item>` registered eagerly
      // (a registration error or the call's own `parents` error), at the call.
      const eagerly = lowerWith(call, tags({ parents: ["somewhere"] }));
      const called = lowerWith(call, tags(plain.item));
      expect(called.map((d) => d.message)).toEqual(
        eagerly.map((d) => d.message),
      );
      expect(called).toEqual([
        { message: expect.any(String), line: 2, column: 2 },
      ]);
      expect(plain.reads()).toBeGreaterThan(0);
    },
  );

  it("the cross-tag error reaches the call (a parent's `children` without the child's `parents`)", () => {
    const { item } = countedItem();
    expect(
      lowerWith("<div>\n  <item/>\n</div>\n", {
        list: { children: { item: {} } },
        item,
      }),
    ).toEqual([
      {
        message: expect.stringContaining(
          "`<list>`: child `<item>` declares `parents` without `<list>`",
        ),
        line: 2,
        column: 2,
      },
    ]);
  });

  // Two deferred contracts that read each other: each call's checks read the
  // other's raw contract, never its half-done checks, in either call order.
  const cycle = () => ({
    a: deferContract({ children: { b: {} }, parents: ["z"] }),
    b: deferContract({ children: { a: {} }, parents: ["a"] }),
    z: { children: { a: {} } } as CustomTag,
  });
  const B_ERROR = expect.stringContaining(
    "`<b>`: child `<a>` declares `parents` without `<b>`",
  );

  it("mutually referencing deferred contracts: the check eager mode enforces lands at the `<b>` call", () => {
    expect(
      lowerSource("<div/>\n", page(), {
        customTags: {
          a: { children: { b: {} }, parents: ["z"] },
          b: { children: { a: {} }, parents: ["a"] },
          z: { children: { a: {} } },
        },
      }).diagnostics.map((d) => d.message),
    ).toEqual([B_ERROR]);
    expect(lowerWith("<z>\n  <a>\n    <b/>\n  </a>\n</z>\n", cycle())).toEqual([
      { message: B_ERROR, line: 3, column: 4 },
    ]);
  });

  it("the same, with `<a>` called alone first in the same map", () => {
    const tags = cycle();
    expect(lowerWith("<z>\n  <a/>\n</z>\n", tags)).toEqual([]);
    expect(lowerWith("<z>\n  <a>\n    <b/>\n  </a>\n</z>\n", tags)).toEqual([
      { message: B_ERROR, line: 3, column: 4 },
    ]);
  });

  it("the same, with `<b>` called first", () => {
    const tags = cycle();
    expect(lowerWith("<b/>\n", tags)).toEqual([
      { message: B_ERROR, line: 1, column: 0 },
    ]);
    expect(lowerWith("<z>\n  <a/>\n</z>\n", tags)).toEqual([]);
  });

  it("the policy check of contract `defaultTag`s skips a deferred contract", () => {
    const { item, reads } = countedItem();
    expect(
      contractDefaultTagDiagnostics({
        tags: new Map([["item", { sidecar: "components/item.tag.ts" }]]),
        customTags: { item },
        scope: { customTags: { item } },
      }),
    ).toEqual([]);
    expect(reads()).toBe(0);
    // An eager contract with the same invalid value is reported.
    expect(
      contractDefaultTagDiagnostics({
        tags: new Map([["item", { sidecar: "components/item.tag.ts" }]]),
        customTags: { item: { defaultTag: "not a tag!" } },
        scope: { customTags: {} },
      }),
    ).toHaveLength(1);
  });
});
