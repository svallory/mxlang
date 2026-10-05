import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as core from "@mxlang/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHeader } from "../src/header.ts";
import { angularOwnTargets } from "../src/own-targets.ts";
import { compileTagModule } from "../src/tag-module.ts";
import { createVirtualTagModuleReader } from "../src/virtual-tags.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function project(config = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-virtual-tags-")));
  directories.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(config));
  const put = (name: string, source: string) => {
    const filename = join(dir, name);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, source);
    return filename;
  };
  return { dir, put };
}

const tagSource = `export interface Input { title: string }\n<span>\${input.title}</span>`;

describe("virtual Angular tag modules", () => {
  it("serves the exact build module through its source and generated sibling, without writing", () => {
    const { dir, put } = project();
    const tag = put("tags/user-card.mx", tagSource);
    const sibling = join(dir, "tags/user-card.ts");
    const read = createVirtualTagModuleReader(dir);
    const expected = compileTagModule(tagSource, tag);
    expect(read(tag)?.code).toBe(expected.code);
    expect(read(sibling)?.code).toBe(expected.code);
    expect(read(tag)?.mappings).toEqual(expected.mappings);
    expect(existsSync(sibling)).toBe(false);
    expect(read(put("page.mx", "<p>page</p>"))).toBeUndefined();
    expect(read(join(dir, "page.ts"))).toBeUndefined();
  });

  it("defaults nested-tag discovery to the same cached customTags as the build", () => {
    const { dir, put } = project();
    const source = "<leaf/>";
    const outer = put("tags/outer.mx", source);
    put("tags/leaf.mx", "<span/>");
    const scan = core.scanCached(outer, {
      host: "angular",
      targets: angularOwnTargets,
    });
    const expected = compileTagModule(source, outer, {
      customTags: scan.customTags,
    });
    expect(expected.code).toContain("imports: [Leaf]");
    const read = createVirtualTagModuleReader(dir);
    expect(read(outer)?.code).toBe(expected.code);
    expect(read(join(dir, "tags/outer.ts"))?.code).toBe(expected.code);
  });

  it("uses package contracts from the build's scan for code and positioned errors", () => {
    const { dir, put } = project({
      mx: { contracts: { module: "./contracts.cjs", hosts: ["angular"] } },
    });
    put(
      "contracts.cjs",
      "exports.default = { 'html-comment': { attributes: {} } };",
    );
    const source = "<html-comment/>";
    const tag = put("tags/card.mx", source);
    const scan = core.scanCached(tag, {
      host: "angular",
      targets: angularOwnTargets,
    });
    expect(scan.customTags["html-comment"]?.attributes).toEqual({});
    const read = createVirtualTagModuleReader(dir);
    expect(read(tag)?.code).toBe(
      compileTagModule(source, tag, { customTags: scan.customTags }).code,
    );
    const badSource = "\n<html-comment bogus=true/>";
    for (const compile of [
      () => compileTagModule(badSource, tag, { customTags: scan.customTags }),
      () => read(tag, badSource),
    ]) {
      let failure: unknown;
      try {
        compile();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(core.TranslateError);
      expect(failure).toMatchObject({
        message: expect.stringContaining("accepts no attributes"),
        line: 2,
        column: 14,
      });
    }
  });

  it("reuses scanCached across fresh readers without a project discovery walk", () => {
    const { dir, put } = project();
    const tag = put("tags/card.mx", tagSource);
    const scan = core.scanCached(tag, {
      host: "angular",
      targets: angularOwnTargets,
    });
    const walk = vi.spyOn(core, "discoverProjectTags");
    const cached = vi.spyOn(core, "scanCached");
    expect(createVirtualTagModuleReader(dir)(tag)?.className).toBe("Card");
    expect(createVirtualTagModuleReader(dir)(tag)?.className).toBe("Card");
    expect(walk).not.toHaveBeenCalled();
    expect(cached).toHaveBeenCalledWith(tag, {
      host: "angular",
      targets: angularOwnTargets,
    });
    expect(
      cached.mock.results.every(
        (result) => result.type === "return" && result.value === scan,
      ),
    ).toBe(true);
  });

  it("does not cross a nested package boundary, or serve a host-module tag", () => {
    const { dir, put } = project();
    const nested = put("nested/tags/card.mx", tagSource);
    put("nested/package.json", "{}");
    const hostModule = put("tags/hostvar.ng.mx", "export const value = 1;");
    const read = createVirtualTagModuleReader(dir);
    expect(read(nested)).toBeUndefined();
    expect(read(join(dir, "nested/tags/card.ts"))).toBeUndefined();
    expect(read(hostModule)).toBeUndefined();
  });

  it("uses the build's configured tag index, selector prefix and extension", () => {
    const { dir, put } = project({
      mx: {
        host: "angular",
        tags: [
          { dir: "components", hosts: ["angular"] },
          { dir: "excluded", hosts: ["html"] },
        ],
        angular: { tagSelectorPrefix: "demo-", tagExtension: ".component.ts" },
      },
    });
    const tag = put("components/card.mx", tagSource);
    const excluded = put("excluded/hidden.mx", "<p/>");
    const read = createVirtualTagModuleReader(dir);
    expect(read(tag)?.selector).toBe("demo-card");
    expect(read(join(dir, "components/card.component.ts"))?.className).toBe(
      "Card",
    );
    expect(read(join(dir, "components/card.ts"))).toBeUndefined();
    expect(read(excluded)).toBeUndefined();
  });

  it("honors unsaved source and refreshes a changed source in the same reader", () => {
    const { dir, put } = project();
    const tag = put("tags/card.mx", tagSource);
    let source = tagSource.replace("string", "number");
    const read = createVirtualTagModuleReader(dir, {
      readSource: (file) => (file === tag ? source : undefined),
    });
    expect(read(tag)?.code).toContain("title!: number");
    source = tagSource;
    expect(read(tag)?.code).toContain("title!: string");
    expect(readFileSync(tag, "utf8")).toBe(tagSource);
  });

  it("refreshes stale generated siblings but never shadows a hand-written TS module", () => {
    const { dir, put } = project();
    put("tags/card.mx", tagSource);
    const sibling = put("tags/card.ts", "export const authored = true;\n");
    const read = createVirtualTagModuleReader(dir);
    expect(read(sibling)).toBeUndefined();
    writeFileSync(
      sibling,
      `${buildHeader("card.mx", "card.ts", [], "ts")}stale`,
    );
    expect(read(sibling)?.code).toContain("export class Card");
    expect(readFileSync(sibling, "utf8")).toContain("stale");
  });

  it("never turns a broken tag into an empty module", () => {
    const { dir, put } = project();
    const tag = put("tags/card.mx", "<if(");
    expect(() => createVirtualTagModuleReader(dir)(tag)).toThrow();
  });
});

describe("the virtual reader reads the package's validated defaultTag (decision 145)", () => {
  const withConfig = (value: unknown) => ({
    mx: { host: "angular", "angular-template": { defaultTag: value } },
  });
  const unnamed = "<.x>hi</>";

  it("applies mx.angular-template.defaultTag, as the build does", () => {
    const { dir, put } = project(withConfig("section"));
    const tag = put("tags/my-card.mx", unnamed);
    const read = createVirtualTagModuleReader(dir);
    expect(read(tag)?.code).toContain('<section class=\\"x\\">');
    const built = compileTagModule(unnamed, tag, { defaultTag: "section" });
    expect(read(tag)?.code).toBe(built.code);
  });

  it("without config the built-in answers", () => {
    const { dir, put } = project({ mx: { host: "angular" } });
    const tag = put("tags/my-card.mx", unnamed);
    expect(createVirtualTagModuleReader(dir)(tag)?.code).toContain(
      '<div class=\\"x\\">',
    );
  });

  it("an edited config recompiles: the cache does not outlive the value", () => {
    const { dir, put } = project(withConfig("section"));
    const tag = put("tags/my-card.mx", unnamed);
    const read = createVirtualTagModuleReader(dir);
    expect(read(tag)?.code).toContain("<section");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(withConfig("article")),
    );
    expect(read(tag)?.code).toContain("<article");
  });

  it("an invalid value is dropped (the built-in answers) and reported once, positioned in package.json", () => {
    const { dir, put } = project(withConfig("input"));
    const tag = put("tags/my-card.mx", unnamed);
    const warnings: core.MxWarning[] = [];
    const read = createVirtualTagModuleReader(dir, { warnings });
    expect(read(tag)?.code).toContain('<div class=\\"x\\">');
    read(tag);
    const own = warnings.filter((w) =>
      w.message.includes("invalid `defaultTag` value"),
    );
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ file: join(dir, "package.json"), line: 1 });
    expect(own[0]?.message).toContain("`<input>` is a void tag");
  });
});

describe("the contracts' defaultTag from the Angular paths that scan for themselves (review round 2)", () => {
  const withBadContract = (value: string) => {
    const made = project({
      mx: { host: "angular", contracts: "./contracts.ts" },
    });
    made.put(
      "contracts.ts",
      `export default { "my-list": { defaultTag: "${value}" } };\n`,
    );
    const tag = made.put("tags/my-card.mx", "<div>hi</div>");
    return { ...made, tag };
  };

  it("the virtual reader reports an invalid value once, at the contracts module, through its warning sink", () => {
    const { dir, tag } = withBadContract("nope");
    const warnings: core.MxWarning[] = [];
    const read = createVirtualTagModuleReader(dir, { warnings });
    read(tag);
    read(tag);
    const own = warnings.filter((w) =>
      w.message.includes("invalid `defaultTag` value"),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.file).toBe(join(dir, "contracts.ts"));
    expect(own[0]?.message).toContain("`<nope>` is not a tag reachable");
  });

  it("a valid value reports nothing", () => {
    const { dir, tag } = withBadContract("section");
    const warnings: core.MxWarning[] = [];
    createVirtualTagModuleReader(dir, { warnings })(tag);
    expect(warnings.filter((w) => w.message.includes("defaultTag"))).toEqual(
      [],
    );
  });
});
