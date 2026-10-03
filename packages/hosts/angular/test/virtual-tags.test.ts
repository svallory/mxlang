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
import { afterEach, describe, expect, it } from "vitest";
import { buildHeader } from "../src/header.ts";
import { compileTagModule } from "../src/tag-module.ts";
import { createVirtualTagModuleReader } from "../src/virtual-tags.ts";

const directories: string[] = [];
afterEach(() => {
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
