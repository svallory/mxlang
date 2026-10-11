/**
 * An unknown tag-level key (`atributes` for `attributes`) on a tag's
 * definition is refused, whichever source wrote it: a `customTags` entry, a
 * `.tag.ts` sidecar (in `tags/` or in an `mx.tags` directory), an
 * `mx.contracts` module, a dialect's `contracts`. One check
 * (`rejectUnknownTagKeys`) holds every source to `CustomTag`'s keys plus the
 * keys the file's dialect claims; a sidecar's and a module's refusal land at
 * the key, a `customTags` object has no file to point at.
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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { isTranslateError, type TranslateError } from "./core.ts";
import { CUSTOM_TAG_KEYS, type CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { clearManifestCache, scanCustomTags } from "./scan.ts";
import { clearScanCache } from "./scan-cache.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();

/** The wording's tail for a source with no claimed keys. */
const ALLOWED =
  "parseOptions, attributes, attributeTags, children, parents, defaultTag, analyze, transform, finalize, template";

/** What an `mx.contracts` entry accepts: no `transform`, `finalize` or `template`. */
const MX_CONTRACTS_ALLOWED =
  "parseOptions, attributes, attributeTags, children, parents, defaultTag, analyze";

const unknownKey = (key: string, tag: string, allowed = ALLOWED) =>
  `Unknown key "${key}" in the declaration of tag "${tag}"; allowed: ${allowed}`;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tag-keys-")));
  clearScanCache();
  clearManifestCache();
});
afterEach(() => {
  clearScanCache();
  clearManifestCache();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** The UTF-16 offset of 1-based `line`, 0-based `column` in `text`. */
function offsetOf(text: string, line: number, column: number): number {
  const before = text.split("\n").slice(0, line - 1);
  return before.reduce((sum, row) => sum + row.length + 1, 0) + column;
}

/** What a thrown refusal says, with the offset its position denotes in its file. */
function refusal(run: () => unknown) {
  let caught: unknown;
  try {
    run();
  } catch (cause) {
    caught = cause;
  }
  if (!isTranslateError(caught)) throw new Error("expected a TranslateError");
  const error = caught as TranslateError;
  const text = error.file === undefined ? "" : readFileSync(error.file, "utf8");
  return {
    message: error.message,
    code: error.diagnosticCode,
    file: error.file,
    line: error.line,
    column: error.column,
    offset:
      error.file === undefined
        ? undefined
        : offsetOf(text, error.line, error.column),
    text,
  };
}

const declarations: HostDeclarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => true,
};

const scan = (from = "page.mx") => scanCustomTags(join(dir, from), { targets });

/** Every field a sidecar's contract holds, read the way a call reads it. */
const readAll = (tag: CustomTag | undefined) => {
  if (!tag) throw new Error("no such tag");
  return [tag.attributes, tag.attributeTags, tag.children, tag.parents];
};

describe("customTags", () => {
  const lowerWith = (customTags: Record<string, unknown>) =>
    lowerSource("<card/>\n", join(dir, "page.mx"), {
      customTags: customTags as Record<string, CustomTag>,
    });

  it("refuses the key with no position: there is no file to point at", () => {
    const error = refusal(() =>
      compileSource("<card/>\n", join(dir, "page.mx"), declarations, {
        customTags: { card: { atributes: {} } as unknown as CustomTag },
        targets,
        tagDiscoveryDirs: [],
        emitIr: () => "",
      }),
    );
    expect(error).toMatchObject({
      message: unknownKey("atributes", "card"),
      code: undefined,
      file: undefined,
      line: 0,
      column: 0,
    });
  });

  it("is a file-start diagnostic for a tool that lowers with it", () => {
    const [first] = lowerWith({ card: { atributes: {} } }).diagnostics;
    expect(first).toEqual({
      message: unknownKey("atributes", "card"),
      severity: "error",
      line: 1,
      column: 0,
      offset: 0,
    });
  });

  it("names the first of two unknown keys, in the order the entry writes them", () => {
    const result = lowerWith({
      card: { attributes: {}, atributes: {}, chilren: {} },
    });
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      unknownKey("atributes", "card"),
    ]);
  });

  it("passes every key a CustomTag has", () => {
    const result = lowerWith({
      card: {
        parseOptions: {},
        attributes: { a: { type: "string" } },
        attributeTags: {},
        children: { "#text": {} },
        parents: ["#root"],
        defaultTag: "div",
        analyze() {},
        transform: () => [],
        finalize: () => [],
      },
    });
    expect(result.diagnostics.map((d) => d.message)).toEqual([]);
  });

  it("holds the key list the dialect's contracts are held to", () => {
    expect(CUSTOM_TAG_KEYS.join(", ")).toBe(ALLOWED);
  });
});

describe("a sidecar", () => {
  const SOURCE = `export default {\n  attributes: { a: { type: "string" } },\n  atributes: { b: { type: "string" } },\n  chilren: {},\n};\n`;

  it("refuses an unknown key at the key, in the sidecar", () => {
    const file = write("tags/card.tag.ts", SOURCE);
    write("package.json", '{"name":"app"}');
    const caught = refusal(() => readAll(scan().customTags.card));
    expect(caught).toMatchObject({
      message: unknownKey("atributes", "card"),
      code: undefined,
      file,
      line: 3,
      column: 2,
      offset: 60,
    });
    expect(
      caught.text.slice(
        caught.offset,
        (caught.offset ?? 0) + "atributes".length,
      ),
    ).toBe("atributes");
  });

  it("reports the first unknown key when two are written, not both", () => {
    write("tags/card.tag.ts", SOURCE);
    write("package.json", '{"name":"app"}');
    const caught = refusal(() => readAll(scan().customTags.card));
    expect(caught.message).toBe(unknownKey("atributes", "card"));
    expect(caught.message).not.toContain("chilren");
  });

  it("finds a quoted key", () => {
    write("tags/card.tag.ts", `export default {\n  "atributes": {},\n};\n`);
    write("package.json", '{"name":"app"}');
    expect(refusal(() => readAll(scan().customTags.card))).toMatchObject({
      line: 2,
      column: 2,
    });
  });

  it("falls back to the sidecar's 1:0 when the key cannot be found without running the module", () => {
    const file = write(
      "tags/card.tag.ts",
      `const make = () => ({ atributes: {} });\nexport default make();\n`,
    );
    write("package.json", '{"name":"app"}');
    expect(refusal(() => readAll(scan().customTags.card))).toMatchObject({
      message: unknownKey("atributes", "card"),
      file,
      line: 1,
      column: 0,
    });
  });

  it("is refused in an `mx.tags` directory too", () => {
    write(
      "package.json",
      JSON.stringify({ name: "app", mx: { tags: "./extra" } }),
    );
    const file = write("extra/card.tag.ts", SOURCE);
    expect(refusal(() => readAll(scan().customTags.card))).toMatchObject({
      message: unknownKey("atributes", "card"),
      file,
      line: 3,
      column: 2,
    });
  });

  it("is refused when a page calls the tag, at the key in the sidecar", () => {
    const file = write("tags/card.tag.ts", SOURCE);
    write("package.json", '{"name":"app"}');
    const result = lowerSource("<card/>\n", join(dir, "page.mx"), {
      customTags: scan().customTags,
    });
    expect(
      result.diagnostics.map(({ message, file: at, line, column }) => ({
        message,
        file: at,
        line,
        column,
      })),
    ).toEqual([
      { message: unknownKey("atributes", "card"), file, line: 3, column: 2 },
    ]);
  });

  it("passes a sidecar that states only CustomTag keys", () => {
    write(
      "tags/card.tag.ts",
      `export default {\n  attributes: { a: { type: "string" } },\n  parents: ["#root"],\n  analyze() {},\n};\n`,
    );
    write("package.json", '{"name":"app"}');
    expect(readAll(scan().customTags.card)[0]).toEqual({
      a: { type: "string" },
    });
  });
});

describe("an `mx.contracts` module", () => {
  const project = (module: string) => {
    write(
      "package.json",
      JSON.stringify({ name: "app", mx: { contracts: "./contracts.ts" } }),
    );
    return write("contracts.ts", module);
  };

  it("refuses an unknown key at the key, in the module", () => {
    const file = project(
      `export default {\n  card: {\n    attributes: {},\n    atributes: {},\n  },\n};\n`,
    );
    const caught = refusal(() => scan());
    expect(caught).toMatchObject({
      message: unknownKey("atributes", "card", MX_CONTRACTS_ALLOWED),
      code: undefined,
      file,
      line: 4,
      column: 4,
      offset: 51,
    });
    expect(
      caught.text.slice(
        caught.offset,
        (caught.offset ?? 0) + "atributes".length,
      ),
    ).toBe("atributes");
  });

  it("reports the first unknown key when two are written, not both", () => {
    project(
      `export default {\n  card: {\n    chilren: {},\n    atributes: {},\n  },\n};\n`,
    );
    const caught = refusal(() => scan());
    expect(caught.message).toBe(
      unknownKey("chilren", "card", MX_CONTRACTS_ALLOWED),
    );
    expect([caught.line, caught.column]).toEqual([3, 4]);
  });

  it("places the key under its own entry, not another entry's equal key", () => {
    project(
      `export default {\n  first: { atributes: {} },\n  card: { attributes: {}, atributes: {} },\n};\n`,
    );
    // `first` is refused first, at its own key.
    expect(refusal(() => scan())).toMatchObject({
      message: unknownKey("atributes", "first", MX_CONTRACTS_ALLOWED),
      line: 2,
      column: 11,
    });
  });

  it("falls back to the module's 1:0 when the module is not a literal", () => {
    const file = project(
      `const card = { atributes: {} };\nexport default { ...{ card } };\n`,
    );
    expect(refusal(() => scan())).toMatchObject({
      message: unknownKey("atributes", "card", MX_CONTRACTS_ALLOWED),
      file,
      line: 1,
      column: 0,
    });
  });

  it("keeps its own refusal for a known key it does not take, now naming only that", () => {
    const file = project(`export default {\n  card: { transform() {} },\n};\n`);
    expect(refusal(() => scan())).toMatchObject({
      message:
        "`<card>`: `transform` is not allowed in `mx.contracts`; use a tag sidecar for hooks other than `analyze` and for templates",
      file,
      line: 1,
      column: 0,
    });
  });

  it("passes a module that states only the keys it takes", () => {
    project(
      `export default {\n  card: { attributes: { a: { type: "string" } }, parents: ["#root"], analyze() {} },\n};\n`,
    );
    expect(Object.keys(scan().customTags)).toEqual(["card"]);
  });
});

describe("a dialect's contracts", () => {
  const LEXI = {
    id: "lexi",
    name: "Lexi",
    extensions: [".lexi.mx"],
    module: "./index.cjs",
  };

  it("is refused at the entry's key with the dialect's code, in the shared wording, listing the keys a dialect contract takes", () => {
    const source = `module.exports = {\n  default: {\n    table: {},\n    contracts: {\n      card: { attributes: {}, atributes: {}, chilren: {} },\n    },\n  },\n};\n`;
    dialectProject(dir, {
      packageName: "lexi-dialect",
      manifest: LEXI,
      module: source,
    });
    write("page.lexi.mx", "<p/>\n");
    const [first] = lowerSource(
      "<p/>\n",
      join(dir, "page.lexi.mx"),
    ).diagnostics;
    expect(first).toMatchObject({
      code: "MX_INVALID_DIALECT_CONTRACT",
      message:
        '`contracts.card`: Unknown key "atributes" in the declaration of tag "card"; allowed: parseOptions, attributes, attributeTags, children, parents, defaultTag, analyze, transform, finalize',
    });
  });

  it("holds a sidecar and a claimed key to the claim: the claimed key passes, a near miss is refused with it listed", () => {
    dialectProject(dir, {
      packageName: "lexi-dialect",
      manifest: LEXI,
      module: `module.exports = { default: { table: {}, contractFields: { tag: ["mood"] } } };`,
    });
    write("tags/ok.tag.ts", `export default { mood: "calm" };\n`);
    expect(() => readAll(scan("page.lexi.mx").customTags.ok)).not.toThrow();
    write("tags/card.tag.ts", `export default {\n  moood: "calm",\n};\n`);
    expect(
      refusal(() => readAll(scan("page.lexi.mx").customTags.card)),
    ).toMatchObject({
      message: unknownKey("moood", "card", `${ALLOWED}, mood`),
      line: 2,
      column: 2,
    });
  });
});
