import {
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPackageJsonCache,
  positionOfOffset,
  readPackageJsonCached,
  setPackageJsonStatForTests,
} from "./package-json.ts";

describe("positionOfOffset", () => {
  it.each([
    ["start", "abc", 0, { line: 1, column: 0 }],
    ["same line", "abc", 2, { line: 1, column: 2 }],
    ["after a newline", "a\nbc", 3, { line: 2, column: 1 }],
    ["on a line start", "a\nb", 2, { line: 2, column: 0 }],
    ["third line", '{\n  "a": 1,\n}\n', 12, { line: 3, column: 0 }],
    ["past the end clamps", "ab", 99, { line: 1, column: 2 }],
    ["negative clamps", "ab", -4, { line: 1, column: 0 }],
    ["empty text", "", 0, { line: 1, column: 0 }],
  ])("%s", (_name, text, offset, expected) => {
    expect(positionOfOffset(text, offset)).toEqual(expected);
  });
});

describe("readPackageJsonCached", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    clearPackageJsonCache();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-pkgjson-")));
    file = join(dir, "package.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Rewrites the file and moves its mtime so the cache sees a new revision. */
  let tick = 0;
  function rewrite(text: string): void {
    writeFileSync(file, text);
    const at = new Date(Date.now() + 10_000 * ++tick);
    utimesSync(file, at, at);
  }

  it("returns undefined for a file that does not exist", () => {
    expect(readPackageJsonCached(file)).toBeUndefined();
  });

  it("parses a good file and reuses the parse while the mtime is unchanged", () => {
    writeFileSync(file, '{"name":"a"}');

    const first = readPackageJsonCached(file);
    const second = readPackageJsonCached(file);

    expect(first?.manifest).toEqual({ name: "a" });
    expect(first?.error).toBeUndefined();
    expect(second).toBe(first);
  });

  it("re-reads when the mtime moves", () => {
    writeFileSync(file, '{"name":"a"}');
    readPackageJsonCached(file);

    rewrite('{"name":"b"}');

    expect(readPackageJsonCached(file)?.manifest).toEqual({ name: "b" });
  });

  it("sees an edit that pins the mtime and keeps the size (touch -r, utimes, same-tick rewrite)", () => {
    const pinned = new Date("2020-01-01T00:00:00Z");
    writeFileSync(file, '{"a":1}');
    utimesSync(file, pinned, pinned);
    expect(readPackageJsonCached(file)?.manifest).toEqual({ a: 1 });

    writeFileSync(file, '{"a":2}');
    utimesSync(file, pinned, pinned);

    expect(readPackageJsonCached(file)?.manifest).toEqual({ a: 2 });
  });

  describe("on a filesystem whose timestamps are too coarse to tell two writes apart", () => {
    // Linux < 6.13 stamps ctime per jiffy (4 ms at HZ=250): a same-size rewrite
    // in the same tick leaves mtime, ctime, size and ino identical. Freeze the
    // stat the cache keys on to simulate that on any OS.
    afterEach(() => setPackageJsonStatForTests());

    function freezeStat(path: string): void {
      const frozen = statSync(path);
      setPackageJsonStatForTests(() => frozen);
    }

    it("sees a same-size rewrite whose stat is identical", () => {
      writeFileSync(file, '{"a":1}');
      expect(readPackageJsonCached(file)?.manifest).toEqual({ a: 1 });
      freezeStat(file);
      readPackageJsonCached(file);

      writeFileSync(file, '{"a":2}');

      expect(readPackageJsonCached(file)?.manifest).toEqual({ a: 2 });
    });

    it("sees a same-size rewrite to a broken file", () => {
      writeFileSync(file, '{"a":1}');
      freezeStat(file);
      readPackageJsonCached(file);

      writeFileSync(file, "{ bad!");

      expect(readPackageJsonCached(file)?.error).toBeDefined();
    });

    it("still returns the cached entry itself when the stat and the text are unchanged", () => {
      writeFileSync(file, '{"a":1}');
      freezeStat(file);
      const first = readPackageJsonCached(file);

      expect(readPackageJsonCached(file)).toBe(first);
    });

    it("re-reads a broken file whose stat and text are unchanged only as the same entry", () => {
      writeFileSync(file, "{ bad");
      freezeStat(file);
      const first = readPackageJsonCached(file);

      expect(first?.error).toBeDefined();
      expect(readPackageJsonCached(file)).toBe(first);
    });

    it("treats a file that became unreadable under an unchanged stat as changed", () => {
      writeFileSync(file, '{"a":1}');
      freezeStat(file);
      readPackageJsonCached(file);

      unlinkSync(file);

      expect(readPackageJsonCached(file)?.error).toBeDefined();
    });
  });

  it("sees a pinned-mtime rewrite to a broken file", () => {
    const pinned = new Date("2020-01-01T00:00:00Z");
    writeFileSync(file, '{"a":1}');
    utimesSync(file, pinned, pinned);
    readPackageJsonCached(file);

    writeFileSync(file, "{ bad");
    utimesSync(file, pinned, pinned);

    expect(readPackageJsonCached(file)?.error).toBeDefined();
  });

  it("sees an atomic replace (new inode) that keeps mtime and size", () => {
    const pinned = new Date("2020-01-01T00:00:00Z");
    writeFileSync(file, '{"a":1}');
    utimesSync(file, pinned, pinned);
    readPackageJsonCached(file);

    const temp = join(dir, "package.json.tmp");
    writeFileSync(temp, '{"a":3}');
    utimesSync(temp, pinned, pinned);
    renameSync(temp, file);

    expect(readPackageJsonCached(file)?.manifest).toEqual({ a: 3 });
  });

  it("keeps the previous good manifest when a revision is broken, and reports the error", () => {
    writeFileSync(file, '{"name":"a"}');
    readPackageJsonCached(file);

    rewrite("{ broken");
    const broken = readPackageJsonCached(file);

    expect(broken?.manifest).toEqual({ name: "a" });
    expect(broken?.error?.message).toBeTruthy();
    expect(broken?.text).toBe("{ broken");
  });

  it("keeps the last good manifest across two broken revisions in a row", () => {
    writeFileSync(file, '{"name":"a"}');
    readPackageJsonCached(file);
    rewrite("{ one");
    readPackageJsonCached(file);

    rewrite("{ two");

    expect(readPackageJsonCached(file)?.manifest).toEqual({ name: "a" });
  });

  it("has no manifest for a path that never parsed", () => {
    writeFileSync(file, "{");

    const read = readPackageJsonCached(file);

    expect(read?.manifest).toBeUndefined();
    expect(read?.error).toBeDefined();
  });

  it("recovers when the broken file is fixed", () => {
    writeFileSync(file, "{");
    readPackageJsonCached(file);

    rewrite('{"name":"fixed"}');
    const read = readPackageJsonCached(file);

    expect(read?.error).toBeUndefined();
    expect(read?.manifest).toEqual({ name: "fixed" });
  });

  it("forgets a file that was deleted", () => {
    writeFileSync(file, '{"name":"a"}');
    readPackageJsonCached(file);

    unlinkSync(file);

    expect(readPackageJsonCached(file)).toBeUndefined();
  });

  it("reports an unreadable path (a directory) as an error, like scan always did", () => {
    // `statSync` succeeds on a directory, `readFileSync` throws EISDIR.
    const read = readPackageJsonCached(dir);

    expect(read?.error?.message).toMatch(/EISDIR|directory/i);
    expect(read?.text).toBe("");
  });

  it("does not require the error to carry a position (Bun's messages have none)", () => {
    writeFileSync(file, "{");

    const error = readPackageJsonCached(file)?.error;

    expect(error?.line).toBeGreaterThanOrEqual(1);
    expect(error?.column).toBeGreaterThanOrEqual(0);
  });
});
