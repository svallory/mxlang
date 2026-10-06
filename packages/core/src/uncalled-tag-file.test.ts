import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findUncalledTagFile,
  markoFileTagMessage,
  uncalledTagFileMessage,
} from "./uncalled-tag-file.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mx-uncalled-"));
  writeFileSync(join(root, "package.json"), '{"name":"t"}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text = "<b/>\n"): string {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("findUncalledTagFile", () => {
  it("finds tags/x.marko as the flat shape", () => {
    const file = put("tags/x.marko");
    expect(findUncalledTagFile(join(root, "page.mx"), "x")).toEqual({
      file,
      shape: "flat",
    });
  });

  it.each([
    "index.marko",
    "index.mx",
    "index.tag.ts",
    "x.marko",
    "x.mx",
    "x.tag.ts",
  ])("finds tags/x/%s as the index shape", (index) => {
    const file = put(`tags/x/${index}`);
    expect(findUncalledTagFile(join(root, "page.mx"), "x")).toEqual({
      file,
      shape: "index",
    });
  });

  it("walks up from a nested page to the package's tags/", () => {
    const file = put("tags/x.marko");
    expect(findUncalledTagFile(join(root, "a/b/page.mx"), "x")?.file).toBe(
      file,
    );
  });

  it("prefers the nearer tags/ directory", () => {
    put("tags/x.marko");
    const near = put("a/tags/x/index.marko");
    expect(findUncalledTagFile(join(root, "a/page.mx"), "x")?.file).toBe(near);
  });

  it("stops at the nearest package.json", () => {
    put("tags/x.marko");
    mkdirSync(join(root, "inner"));
    writeFileSync(join(root, "inner/package.json"), "{}");
    expect(findUncalledTagFile(join(root, "inner/page.mx"), "x")).toBe(
      undefined,
    );
  });

  it("ignores a flat .mx file, a directory with no index file, and an unrelated name", () => {
    put("tags/x.mx");
    put("tags/d/readme.md");
    expect(findUncalledTagFile(join(root, "page.mx"), "x")).toBe(undefined);
    expect(findUncalledTagFile(join(root, "page.mx"), "d")).toBe(undefined);
    expect(findUncalledTagFile(join(root, "page.mx"), "y")).toBe(undefined);
  });

  it("ignores a file named like the tag where a directory would be, and names that are not tag names", () => {
    put("tags/x", "not a directory with an index");
    expect(findUncalledTagFile(join(root, "page.mx"), "x")).toBe(undefined);
    expect(findUncalledTagFile(join(root, "page.mx"), "../x")).toBe(undefined);
    expect(findUncalledTagFile(join(root, "page.mx"), "")).toBe(undefined);
  });
});

describe("messages", () => {
  it("the .marko message names the file, relative to the caller, and the .mx to write", () => {
    const message = markoFileTagMessage(
      join(root, "page.mx"),
      "x",
      join(root, "tags/x/index.marko"),
    );
    expect(message).toBe(
      "`<x>` resolves to `tags/x/index.marko`, a `.marko` file, and MX does not compile `.marko` files. Convert it to `.mx` (`tags/x/index.mx`).",
    );
  });

  it("the directory message names the file and the flat shape MX calls", () => {
    const found = {
      file: join(root, "tags/x/index.mx"),
      shape: "index" as const,
    };
    const message = uncalledTagFileMessage(join(root, "page.mx"), "x", found);
    expect(message).toContain("`<x>` matches `tags/x/index.mx`");
    expect(message).toContain("MX calls flat `tags/<name>.mx` files only");
  });
});
