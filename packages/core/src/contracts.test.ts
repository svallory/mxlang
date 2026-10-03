import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import { customTagTaglib } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { Ir } from "./ir.ts";
import {
  clearManifestCache,
  discoverProjectTags,
  hostRestrictionDiagnostics,
  scanCustomTags,
} from "./scan.ts";
import {
  clearScanCache,
  liveTagMapCount,
  scanCached,
  scanCacheStampsForTests,
} from "./scan-cache.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const dirs: string[] = [];
function project(
  source = "export default { box: { attributes: {} } };",
  contracts: unknown = "./contracts.ts",
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-contracts-")));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { contracts } }, null, 2),
  );
  writeFileSync(join(dir, "contracts.ts"), source);
  return dir;
}
function scan(dir: string, host?: string | null) {
  return scanCustomTags(join(dir, "page.mx"), { targets, host });
}
function error(dir: string): TranslateError {
  try {
    scan(dir);
  } catch (cause) {
    expect(cause).toBeInstanceOf(TranslateError);
    return cause as TranslateError;
  }
  throw new Error("expected a thrown scan error");
}
const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => true,
};
function compile(dir: string, source: string): Ir {
  let ir: Ir | undefined;
  compileSource(source, join(dir, "page.mx"), declarations, {
    targets,
    customTags: scan(dir).customTags,
    tagDiscoveryDirs: [],
    emitIr(value) {
      ir = value;
      return "";
    },
  });
  if (!ir) throw new Error("no IR");
  return ir;
}
afterEach(() => {
  clearScanCache();
  clearManifestCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("mx.contracts (decision 142)", () => {
  it.each([
    "./contracts.ts",
    { module: "./contracts.ts" },
    ["./contracts.ts"],
    [{ module: "./contracts.ts" }],
  ])("accepts entry form %j", (entry) => {
    const dir = project(undefined, entry);
    expect(Object.keys(scan(dir).customTags)).toEqual(["box"]);
    expect(
      discoverProjectTags(dir, { targets }).customTags.box?.attributes,
    ).toEqual({});
    expect(scan(dir).files).toContainEqual({
      path: join(dir, "contracts.ts"),
      mtimeMs: statSync(join(dir, "contracts.ts")).mtimeMs,
    });
  });
  it("evaluates once on a cache miss, not once per calling file", () => {
    const dir = project(
      "globalThis.mxContractLoads = (globalThis.mxContractLoads ?? 0) + 1; export default { box: { attributes: {} } };",
    );
    const globals = globalThis as unknown as { mxContractLoads?: number };
    globals.mxContractLoads = 0;
    const first = scanCached(join(dir, "a.mx"), { targets });
    expect(scanCached(join(dir, "b.mx"), { targets })).toBe(first);
    expect(globals.mxContractLoads).toBe(1);
    delete globals.mxContractLoads;
  });
  it("accepts an absolute module path", () => {
    const dir = project();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { contracts: join(dir, "contracts.ts") } }),
    );
    expect(scan(dir).tags.get("box")?.module).toBe(join(dir, "contracts.ts"));
  });
  it("resolves a bare export from the consuming nested package's node_modules", () => {
    const root = project("export default { wrong: {} };");
    const dir = join(root, "member");
    const pkg = join(dir, "node_modules", "dialect");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      '{"mx":{"contracts":"dialect/contracts"}}',
    );
    writeFileSync(
      join(pkg, "package.json"),
      '{"name":"dialect","exports":{"./contracts":"./index.mjs"}}',
    );
    writeFileSync(
      join(pkg, "index.mjs"),
      "export default { nested: { attributes: {} } };",
    );
    expect(Object.keys(scan(dir).customTags)).toEqual(["nested"]);
  });
  it.each([
    42,
    null,
    {},
    { module: 1 },
    { module: "./contracts.ts", hosts: "html" },
    { module: "./contracts.ts", hosts: [1] },
    { module: "./contracts.ts", prefix: "x-" },
  ])("positions bad config %j at the contracts key", (entry) => {
    const dir = project(undefined, entry);
    const caught = error(dir);
    expect(caught.file).toBe(join(dir, "package.json"));
    expect([caught.line, caught.column]).toEqual([3, 4]);
    expect(caught.message).toContain("mx.contracts");
  });
  it("locates the actual mx key, not a nested decoy, including escaped spelling", () => {
    const dir = project();
    writeFileSync(
      join(dir, "package.json"),
      '{\n "other": {"contracts": 1},\n "mx": {"other": {"contracts": 2},\n   "contr\\u0061cts": false}\n}',
    );
    const caught = error(dir);
    expect([caught.line, caught.column]).toEqual([4, 3]);
  });
  it.each(["./missing.ts", "missing-dialect/contracts"])(
    "positions unresolved %s at package.json",
    (entry) => {
      const dir = project(undefined, entry);
      const caught = error(dir);
      expect(caught.file).toBe(join(dir, "package.json"));
      expect([caught.line, caught.column]).toEqual([3, 4]);
      expect(caught.message).toContain(entry);
      expect(caught.message).toContain(dir);
    },
  );
  it.each([
    ["throw new Error('broken contract');", "failed to load"],
    ["export const box = {};", "export default"],
    ["export default [];", "export default"],
    ["export default new Date();", "plain ContractMap"],
    [
      "export default { get box() { throw new Error('bad declaration getter'); } };",
      "bad declaration getter",
    ],
    [
      "export default { box: { get attributes() { throw 'bad contract'; } } };",
      "bad contract",
    ],
    ["export default { box: [] };", "CustomTag object"],
    ["export default { box: () => ({}) };", "CustomTag object"],
    ["export default () => ({});", "export default"],
    ["export default { box: 1 };", "CustomTag object"],
    ["export default { 'bad name': {} };", "usable tag name"],
    [
      "export default { box: { attributes: { x: { requried: true } } } };",
      "Unknown key",
    ],
    [
      "export default { box: { children: {}, parseOptions: { text: true } } };",
      "cannot be combined",
    ],
    [
      "export default { box: { children: {}, parseOptions: { openTagOnly: true } } };",
      "cannot be combined",
    ],
    [
      "export default { box: { attributes: { x: { items: 'string' } } } };",
      "requires",
    ],
    ["export default { box: { parseOptions: { text: 1 } } };", "boolean"],
    [
      "export default { box: { parseOptions: { bogus: true } } };",
      "not a parse option",
    ],
    ["export default { box: { transform() {} } };", "transform"],
    [
      "export default { box: Object.defineProperty({ attributes: {} }, 'transform', { value: () => [] }) };",
      "transform",
    ],
    [
      "export default { box: Object.defineProperty({ attributes: {} }, 'finalize', { value: () => [] }) };",
      "finalize",
    ],
    [
      "export default { box: Object.defineProperty({ attributes: {} }, 'template', { value: {} }) };",
      "template",
    ],
    ["export default { box: { finalize() {} } };", "finalize"],
    ["export default { box: { template: {} } };", "template"],
    ["export default { box: { analyze: true } };", "function"],
    ["export default { box: { attrbutes: {} } };", "attrbutes"],
  ])("rejects module %s", (source, message) => {
    const dir = project(source);
    const caught = error(dir);
    expect(caught.file).toBe(join(dir, "contracts.ts"));
    expect([caught.line, caught.column]).toEqual([1, 0]);
    expect(caught.message).toContain(message);
  });
  it("skips the core-owned try key with a warning, even if its value is invalid", () => {
    const dir = project("export default { try: 1, box: { attributes: {} } };");
    const result = scan(dir);
    expect(Object.keys(result.customTags)).toEqual(["box"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        file: join(dir, "contracts.ts"),
        line: 1,
        column: 0,
        message: expect.stringContaining("core-owned"),
      }),
    ]);
  });
  it("uses tags/ then mx.tags then modules in array order, replacing whole entries and reporting both warnings", () => {
    const dir = project(
      "export default { local: { parents: ['#root'] }, configured: { parents: ['#root'] }, shared: { attributes: { first: {} } } };",
    );
    mkdirSync(join(dir, "tags"));
    mkdirSync(join(dir, "extra"));
    writeFileSync(
      join(dir, "tags", "local.tag.ts"),
      "export default { attributes: { own: {} } };",
    );
    writeFileSync(
      join(dir, "extra", "local.tag.ts"),
      "export default { attributes: { extra: {} } };",
    );
    writeFileSync(
      join(dir, "extra", "configured.tag.ts"),
      "export default { attributes: {} };",
    );
    writeFileSync(
      join(dir, "second.ts"),
      "export default { shared: { parents: [] }, last: { attributes: {} } };",
    );
    writeFileSync(
      join(dir, "package.json"),
      '{"mx":{"tags":["./extra"],"contracts":["./contracts.ts","./second.ts"]}}',
    );
    for (const result of [scan(dir), discoverProjectTags(dir, { targets })]) {
      expect(result.customTags.local?.attributes).toEqual({ own: {} });
      expect(result.customTags.local?.parents).toBeUndefined();
      expect(result.customTags.configured?.parents).toBeUndefined();
      expect(result.customTags.shared?.attributes).toEqual({ first: {} });
      expect(result.customTags.shared?.parents).toBeUndefined();
      expect(result.diagnostics).toHaveLength(3);
      expect(result.diagnostics[0]).toMatchObject({
        file: join(dir, "tags", "local.tag.ts"),
        line: 1,
        column: 0,
        message: expect.stringContaining("shadowed"),
      });
      expect(result.diagnostics[1]?.file).toBe(
        join(dir, "extra", "configured.tag.ts"),
      );
      expect(result.diagnostics[2]).toMatchObject({
        file: join(dir, "second.ts"),
        line: 1,
        column: 0,
        message: expect.stringContaining("defined twice"),
      });
      expect(result.diagnostics[2]?.message).toContain(
        join(dir, "contracts.ts"),
      );
      expect(result.diagnostics[2]?.message).toContain(join(dir, "second.ts"));
    }
  });
  it("warns at a winning template, without merging the shadowed contract", () => {
    const dir = project();
    mkdirSync(join(dir, "tags"));
    writeFileSync(join(dir, "tags", "box.mx"), "<div/>");
    const result = scan(dir);
    expect(result.customTags.box?.attributes).toBeUndefined();
    expect(result.diagnostics[0]?.file).toBe(join(dir, "tags", "box.mx"));
  });
  it("still validates a shadowed module so an invalid contract cannot silently pass", () => {
    const dir = project(
      "export default { box: { attributes: { x: { requried: true } } } };",
    );
    mkdirSync(join(dir, "tags"));
    writeFileSync(join(dir, "tags", "box.mx"), "<div/>");
    expect(error(dir).message).toContain("Unknown key");
  });
  it("preserves the merged-map cross-source registration check", () => {
    const dir = project(
      "export default { box: { children: { item: {} } }, item: { parents: ['box'] } };",
    );
    mkdirSync(join(dir, "tags"));
    writeFileSync(
      join(dir, "tags", "item.tag.ts"),
      "export default { parents: ['#root'] };",
    );
    expect(() => compile(dir, "<box><item/></box>")).toThrow(
      "declares `parents` without",
    );
  });
  it("filters hosts including null and records restrictions for lookup-owned warnings", () => {
    const dir = project(undefined, {
      module: "./contracts.ts",
      hosts: ["html", "typo"],
    });
    expect(Object.keys(scan(dir, "html").customTags)).toEqual(["box"]);
    expect(Object.keys(scan(dir, "solid").customTags)).toEqual([]);
    expect(Object.keys(scan(dir, null).customTags)).toEqual([]);
    expect(Object.keys(scan(dir).customTags)).toEqual(["box"]);
    expect(
      hostRestrictionDiagnostics(scan(dir).hostRestrictions, targets)[0]
        ?.message,
    ).toContain("mx.contracts");
  });
  it("stops at a member manifest; dependency manifests are not discovered", () => {
    const root = project();
    const member = join(root, "member");
    mkdirSync(member);
    writeFileSync(join(member, "package.json"), "{}");
    expect(Object.keys(scan(member).customTags)).toEqual([]);
    expect(
      Object.keys(discoverProjectTags(member, { targets }).customTags),
    ).toEqual([]);
  });
  it("runs analyze on a contract-only delegated call and propagates positioned call errors", () => {
    const dir = project(
      "export default { box: { attributes: {}, analyze(calls, ctx) { ctx.fail('module analyze ran', calls[0].loc); } } };",
    );
    try {
      compile(dir, "\n<box/>");
      throw new Error("analyze did not run");
    } catch (cause) {
      expect(cause).toBeInstanceOf(TranslateError);
      expect(cause).toMatchObject({
        message: expect.stringContaining("module analyze ran"),
        line: 2,
        column: 0,
      });
    }
  });
  it("passes evaluated parseOptions to Marko for a text body", () => {
    const dir = project(
      "const text = true; export default { box: { parseOptions: { text } } };",
    );
    const ir = compile(dir, "<box><not-a-tag/></box>");
    expect(ir.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        children: [
          expect.objectContaining({ kind: "Text", value: "<not-a-tag/>" }),
        ],
      },
    });
  });
  it.each([false, true])(
    "rescans on a module edit (pinned mtime=%s) without retaining source text",
    (pinned) => {
      const dir = project();
      const file = join(dir, "page.mx");
      const module = join(dir, "contracts.ts");
      const first = scanCached(file, { targets });
      const stamp = statSync(module);
      const taglib = customTagTaglib(first.customTags)?.[0];
      writeFileSync(
        module,
        "export default { box: { attributes: { x: {} } } };",
      );
      utimesSync(
        module,
        stamp.atime,
        pinned ? stamp.mtime : new Date(Date.now() + 10000),
      );
      // Vitest has a second module registry: eviction of require.cache does not
      // re-evaluate here. Assert rescan/new map, not the edited hooks or options.
      const next = scanCached(file, { targets });
      expect(next).not.toBe(first);
      expect(next.customTags).not.toBe(first.customTags);
      expect(customTagTaglib(next.customTags)?.[0]).toBe(taglib);
      expect(scanCached(file, { targets })).toBe(next);
      expect(liveTagMapCount()).toBe(1);
      for (const evidence of scanCacheStampsForTests()) {
        expect(Object.keys(evidence).sort()).toEqual(["hash", "mtimeMs"]);
        expect(evidence).toHaveProperty(
          "hash",
          expect.stringMatching(/^[a-f0-9]{64}$/),
        );
      }
    },
  );
  it("changes parser identity when a different module supplies the same name", () => {
    const dir = project();
    const first = scanCached(join(dir, "a.mx"), { targets });
    writeFileSync(
      join(dir, "other.ts"),
      "export default { box: { parseOptions: { text: true } } };",
    );
    writeFileSync(
      join(dir, "package.json"),
      '{"mx":{"contracts":"./other.ts"}}',
    );
    const second = scanCached(join(dir, "a.mx"), { targets });
    expect(second.customTags).not.toBe(first.customTags);
    expect(customTagTaglib(second.customTags)?.[0]).not.toBe(
      customTagTaglib(first.customTags)?.[0],
    );
    expect(second.tags.get("box")?.module).toBe(join(dir, "other.ts"));
  });
  it.skipIf(Boolean(process.versions.bun)).each([".ts", ".mjs", ".cjs"])(
    "pins Node reload behavior for %s and picks up edits after a tool restart",
    (extension) => {
      const moduleName = `contracts${extension}`;
      const dir = project(undefined, `./${moduleName}`);
      const exportPrefix =
        extension === ".cjs"
          ? "module.exports = { default: "
          : "export default ";
      const exportSuffix = extension === ".cjs" ? " };" : ";";
      writeFileSync(
        join(dir, moduleName),
        `${exportPrefix}{ box: { attributes: {} } }${exportSuffix}`,
      );
      const edited = `${exportPrefix}{ box: { parseOptions: { text: true } } }${exportSuffix}`;
      const scanUrl = new URL("./scan-cache.ts", import.meta.url).href;
      const lookupUrl = new URL("./test-targets.ts", import.meta.url).href;
      const imports = `import { scanCached } from ${JSON.stringify(scanUrl)};
      import { testTargetLookup } from ${JSON.stringify(lookupUrl)};
      import { writeFileSync, statSync, utimesSync } from 'node:fs';
      import { join } from 'node:path';
      const dir = process.argv[1];
      const file = join(dir, 'page.mx');
      const module = join(dir, ${JSON.stringify(moduleName)});
      const targets = testTargetLookup();`;
      const firstProcess = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `${imports}
      const before = scanCached(file, { targets });
      const stamp = statSync(module);
      writeFileSync(module, ${JSON.stringify(edited)});
      utimesSync(module, stamp.atime, stamp.mtime);
      const after = scanCached(file, { targets });
      console.log(JSON.stringify({ freshMap: before.customTags !== after.customTags, text: after.customTags.box.parseOptions?.text ?? false }));`,
          dir,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      expect(firstProcess.error).toBeUndefined();
      expect(firstProcess.status, firstProcess.stderr).toBe(0);
      expect(JSON.parse(firstProcess.stdout.trim())).toEqual({
        freshMap: true,
        text: extension === ".cjs",
      });
      const restarted = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `${imports}
      console.log(JSON.stringify({ text: scanCached(file, { targets }).customTags.box.parseOptions?.text }));`,
          dir,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      expect(restarted.error).toBeUndefined();
      expect(restarted.status, restarted.stderr).toBe(0);
      expect(JSON.parse(restarted.stdout.trim())).toEqual({ text: true });
    },
  );
  describe("Round 2 review regressions", () => {
    it.each(["unit", "other", null, undefined])(
      "resolves duplicate module names only among entries applicable to host %s",
      (host) => {
        const dir = project(
          "export default { both: { attributes: { hosted: {} } }, hosted: { attributes: {} } };",
        );
        writeFileSync(
          join(dir, "free.ts"),
          "export default { both: { attributes: { free: {} } }, free: { attributes: {} } };",
        );
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            mx: {
              contracts: [
                { module: "./contracts.ts", hosts: ["unit"] },
                "./free.ts",
              ],
            },
          }),
        );
        const eligible = host === "unit" || host === undefined;
        for (const result of [
          scan(dir, host),
          discoverProjectTags(dir, { targets, host }),
          scanCached(join(dir, "page.mx"), { targets, host }),
        ]) {
          expect(result.customTags.both?.attributes).toEqual(
            eligible ? { hosted: {} } : { free: {} },
          );
          expect(Object.keys(result.customTags)).toEqual(
            eligible ? ["both", "hosted", "free"] : ["both", "free"],
          );
          expect(result.diagnostics).toEqual(
            eligible
              ? [
                  expect.objectContaining({
                    file: join(dir, "free.ts"),
                    message: expect.stringContaining("defined twice"),
                    line: 1,
                    column: 0,
                  }),
                ]
              : [],
          );
          // Ineligible entries still contribute restriction and file evidence.
          expect(result.hostRestrictions).toHaveLength(1);
          expect(result.files.map(({ path }) => path)).toContain(
            join(dir, "contracts.ts"),
          );
        }
      },
    );
    it.each(["unit", "other", null])(
      "does not warn about an ineligible later duplicate for host %s",
      (host) => {
        const dir = project(
          "export default { both: { attributes: { free: {} } } };",
        );
        writeFileSync(
          join(dir, "hosted.ts"),
          "export default { both: { attributes: { hosted: {} } } };",
        );
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            mx: {
              contracts: [
                "./contracts.ts",
                { module: "./hosted.ts", hosts: ["unit"] },
              ],
            },
          }),
        );
        for (const result of [
          scan(dir, host),
          discoverProjectTags(dir, { targets, host }),
        ]) {
          expect(result.customTags.both?.attributes).toEqual({ free: {} });
          expect(result.diagnostics).toHaveLength(host === "unit" ? 1 : 0);
        }
      },
    );
    it.each(["unit", "other", null])(
      "lets only eligible mx.tags entries shadow module contracts for host %s",
      (host) => {
        const dir = project();
        mkdirSync(join(dir, "extra"));
        writeFileSync(
          join(dir, "extra", "box.tag.ts"),
          "export default { attributes: { hosted: {} } };",
        );
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            mx: {
              tags: [{ dir: "./extra", hosts: ["unit"] }],
              contracts: "./contracts.ts",
            },
          }),
        );
        for (const result of [
          scan(dir, host),
          discoverProjectTags(dir, { targets, host }),
        ]) {
          expect(result.customTags.box?.attributes).toEqual(
            host === "unit" ? { hosted: {} } : {},
          );
          expect(result.diagnostics).toHaveLength(host === "unit" ? 1 : 0);
        }
      },
    );
    it.each(["unit", "other", null])(
      "warns about a local-file shadow only for eligible modules for host %s",
      (host) => {
        const dir = project(undefined, {
          module: "./contracts.ts",
          hosts: ["unit"],
        });
        mkdirSync(join(dir, "tags"));
        writeFileSync(join(dir, "tags", "box.mx"), "<div/>");
        for (const result of [
          scan(dir, host),
          discoverProjectTags(dir, { targets, host }),
        ]) {
          expect(result.tags.get("box")?.template).toBe(
            join(dir, "tags", "box.mx"),
          );
          expect(result.diagnostics).toHaveLength(host === "unit" ? 1 : 0);
        }
      },
    );
    it.each(["unit", "other", null])(
      "still validates ineligible modules for host %s",
      (host) => {
        const dir = project(
          "export default { box: { attributes: { x: { requried: true } } } };",
          { module: "./contracts.ts", hosts: ["unit"] },
        );
        expect(() => scan(dir, host)).toThrow('Unknown key "requried"');
      },
    );
    it.each(["require", "default", "import"])(
      "resolves bare package export condition %s through the synchronous loader",
      (condition) => {
        const dir = project(undefined, "dialect");
        const pkg = join(dir, "node_modules", "dialect");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
          join(pkg, "package.json"),
          JSON.stringify({
            name: "dialect",
            exports: { [condition]: "./contracts.mjs" },
          }),
        );
        writeFileSync(
          join(pkg, "contracts.mjs"),
          "export default { box: { attributes: {} } };",
        );
        if (condition === "import") {
          expect(error(dir)).toMatchObject({
            file: join(dir, "package.json"),
            line: 3,
            column: 4,
            message: expect.stringContaining("could not resolve `dialect`"),
          });
        } else {
          expect(scan(dir).customTags.box?.attributes).toEqual({});
        }
      },
    );
    it("names both settings and the missing contracts in a first broken manifest warning", () => {
      const dir = project();
      writeFileSync(
        join(dir, "package.json"),
        '{"mx":{"contracts":"./contracts.ts",',
      );
      for (const result of [scan(dir), discoverProjectTags(dir, { targets })]) {
        expect(Object.keys(result.customTags)).toEqual([]);
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            file: join(dir, "package.json"),
            line: 1,
            column: 0,
            message: expect.stringContaining(
              "no `mx.tags` or `mx.contracts` are loaded until the manifest parses",
            ),
          }),
        ]);
      }
    });
    it("names both settings while retaining the last good contracts on a broken manifest", () => {
      const dir = project();
      expect(Object.keys(scan(dir).customTags)).toEqual(["box"]);
      writeFileSync(join(dir, "package.json"), '{"mx":{"contracts":');
      for (const result of [scan(dir), discoverProjectTags(dir, { targets })]) {
        expect(Object.keys(result.customTags)).toEqual(["box"]);
        expect(result.diagnostics[0]).toMatchObject({
          file: join(dir, "package.json"),
          line: 1,
          column: 0,
          message: expect.stringContaining(
            "the previous valid `mx.tags` and `mx.contracts` stay in force",
          ),
        });
      }
    });
    it("does not tokenize a manifest for contractsPosition when contracts is absent", () => {
      const dir = project();
      const manifest = '{"name":"plain","mx":{"tags":[]}}';
      writeFileSync(join(dir, "package.json"), manifest);
      const tokenize = vi.spyOn(String.prototype, "matchAll");
      try {
        scan(dir);
        discoverProjectTags(dir, { targets });
        expect(tokenize.mock.contexts.map(String)).not.toContain(manifest);
      } finally {
        tokenize.mockRestore();
      }
    });
  });
  it("keeps one stable map across unchanged scans from multiple directories", () => {
    const dir = project();
    mkdirSync(join(dir, "src"));
    const first = scanCached(join(dir, "a.mx"), { targets });
    expect(scanCached(join(dir, "b.mx"), { targets }).customTags).toBe(
      first.customTags,
    );
    expect(scanCached(join(dir, "src", "c.mx"), { targets }).customTags).toBe(
      first.customTags,
    );
    expect(liveTagMapCount()).toBe(1);
  });
});
