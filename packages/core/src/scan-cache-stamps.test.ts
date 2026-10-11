/**
 * The scan cache's freshness evidence (dialect tag discovery, slice 1): a
 * stamp per file of `(mtimeMs, ctimeMs, size, ino)`, a content hash only
 * for a racy file, the caller's dialect in the key, and every project
 * dialect's `package.json` as evidence. Directory listings keep today's
 * add/remove rule, pinned here for dialect `tagDirs`.
 *
 * The test dialects (`kit`, `box`) are fixtures, not any real dialect.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  clearScanCache,
  scanCached,
  scanCacheEvidenceForTests,
  setRacyWindowForTests,
  stampForTests,
} from "./scan-cache.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { testTargetLookup } from "./test-targets.ts";

const targets = testTargetLookup();
const PAST = new Date("2020-01-01T00:00:00Z");

let dir: string;
let window: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-scan-stamps-")));
  clearScanCache();
  window = setRacyWindowForTests(2000);
});
afterEach(() => {
  setRacyWindowForTests(window);
  clearScanCache();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text = "<div/>\n"): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Lets the clock move past every timestamp written so far. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function kitProject(fields: Record<string, unknown> = {}) {
  return dialectProject(dir, {
    packageName: "kit-dialect",
    manifest: {
      id: "kit",
      name: "Kit",
      extensions: [".kit.mx"],
      tagDirs: ["components"],
      ...fields,
    },
  });
}

const tagsFrom = (file: string) =>
  [...scanCached(join(dir, file), { targets }).tags.keys()].sort();

const evidenceOf = (path: string) =>
  scanCacheEvidenceForTests()
    .filter(([file]) => file === path)
    .map(([, stamp]) => stamp);

describe("a stamp", () => {
  it("hashes a file changed within the racy window, and only such a file", () => {
    const file = write("a.mx");
    const changed = statSync(file).ctimeMs;
    expect(stampForTests.of(file, changed + 1000)).toHaveProperty(
      "hash",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(stampForTests.of(file, changed + 3000)).not.toHaveProperty("hash");
  });

  it("a timestamp in the future is racy", () => {
    const file = write("a.mx");
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);
    expect(stampForTests.of(file, Date.now())).toHaveProperty("hash");
  });

  it.each(["mtimeMs", "ctimeMs", "size", "ino"] as const)(
    "a different `%s` is stale",
    (field) => {
      const file = write("a.mx");
      const later = statSync(file).ctimeMs + 10_000;
      const stamp = stampForTests.of(file, later);
      expect(stampForTests.isFresh(file, stamp, later)).toBe(true);
      const moved = { ...stamp, [field]: (stamp as never)[field] + 1 };
      expect(stampForTests.isFresh(file, moved, later)).toBe(false);
    },
  );

  it("a racy stamp whose content differs is stale even when the stat matches", () => {
    const file = write("a.mx");
    const now = statSync(file).ctimeMs;
    const stamp = stampForTests.of(file, now);
    expect(stampForTests.isFresh(file, stamp, now)).toBe(true);
    const edited = { ...stamp, hash: "0".repeat(64) };
    expect(stampForTests.isFresh(file, edited, now)).toBe(false);
  });

  it("drops its hash once verified outside the racy window", () => {
    const file = write("a.mx");
    const now = statSync(file).ctimeMs;
    const stamp = stampForTests.of(file, now);
    expect(stamp).toHaveProperty("hash");
    expect(stampForTests.isFresh(file, stamp, now)).toBe(true);
    expect(stamp).toHaveProperty("hash");
    expect(stampForTests.isFresh(file, stamp, now + 3000)).toBe(true);
    expect(stamp).not.toHaveProperty("hash");
  });

  it("a missing file is stamped missing, and its creation is stale", () => {
    const file = join(dir, "later.mx");
    const stamp = stampForTests.of(file, Date.now());
    expect(stamp).toEqual({ missing: true });
    expect(stampForTests.isFresh(file, stamp, Date.now())).toBe(true);
    write("later.mx");
    expect(stampForTests.isFresh(file, stamp, Date.now())).toBe(false);
  });

  it("a poisoned stamp is never fresh", () => {
    const file = join(dir, "gone.mx");
    expect(
      stampForTests.isFresh(
        file,
        { missing: true, poisoned: true },
        Date.now(),
      ),
    ).toBe(false);
  });
});

describe("invalidation", () => {
  it("a same-size edit with the mtime restored is seen, by ctime, with no hash kept", async () => {
    setRacyWindowForTests(0);
    kitProject();
    const file = write("components/money.kit.mx", "<b>aaaa</b>\n");
    utimesSync(file, PAST, PAST);
    await settle();
    const first = scanCached(join(dir, "page.kit.mx"), { targets });
    // Settled, so the stamp is stat-only: no content hash to fall back on.
    expect(evidenceOf(file)).toEqual([
      {
        mtimeMs: PAST.getTime(),
        ctimeMs: expect.any(Number),
        size: 12,
        ino: expect.any(Number),
      },
    ]);
    await settle();
    writeFileSync(file, "<b>bbbb</b>\n");
    utimesSync(file, PAST, PAST);
    expect(statSync(file).mtimeMs).toBe(PAST.getTime());
    // Identity, not `not.toBe`: vitest's failure hint would deep-compare the
    // results, reading the hookless tag's throwing contract getters.
    expect(scanCached(join(dir, "page.kit.mx"), { targets }) === first).toBe(
      false,
    );
  });

  it("an atomic rename over a tag file is seen", async () => {
    setRacyWindowForTests(0);
    kitProject();
    const file = write("components/money.kit.mx", "<b>aaaa</b>\n");
    utimesSync(file, PAST, PAST);
    await settle();
    const first = scanCached(join(dir, "page.kit.mx"), { targets });
    const temp = write("components/.money.kit.mx.tmp", "<b>bbbb</b>\n");
    utimesSync(temp, PAST, PAST);
    renameSync(temp, file);
    expect(statSync(file).mtimeMs).toBe(PAST.getTime());
    expect(statSync(file).size).toBe(12);
    // Identity, not `not.toBe`: vitest's failure hint would deep-compare the
    // results, reading the hookless tag's throwing contract getters.
    expect(scanCached(join(dir, "page.kit.mx"), { targets }) === first).toBe(
      false,
    );
  });

  it("a tag file in a directory that did not exist is found", () => {
    kitProject();
    expect(tagsFrom("page.kit.mx")).toEqual([]);
    write("components/money.kit.mx");
    expect(tagsFrom("page.kit.mx")).toEqual(["money"]);
  });

  it("an edit to the dialect's manifest is seen", async () => {
    setRacyWindowForTests(0);
    const { packageFile } = kitProject();
    write("components/money.component.kit.mx");
    write("parts/coin.kit.mx");
    await settle();
    expect(tagsFrom("page.kit.mx")).toEqual(["money.component"]);
    // The dialect's `package.json` is evidence, stamped like any file.
    expect(evidenceOf(packageFile)).toHaveLength(1);
    kitProject({ tagExtensions: [".component.kit.mx"] });
    expect(tagsFrom("page.kit.mx")).toEqual(["money"]);
    kitProject({ tagDirs: ["parts"] });
    expect(tagsFrom("page.kit.mx")).toEqual(["coin"]);
  });

  it("a dialect added to the project re-routes a file the cache had scanned as MX", () => {
    write("tags/card.mx");
    write("components/money.kit.mx");
    write("package.json", '{ "name": "app" }\n');
    // No dialect yet: `page.kit.mx` is an MX file and scans `tags/`.
    expect(tagsFrom("page.kit.mx")).toEqual(["card"]);
    kitProject();
    expect(tagsFrom("page.kit.mx")).toEqual(["money"]);
  });

  it("the caller's dialect is in the key: one directory, three scans, each cached", () => {
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
    write("tags/card.mx");
    const kit = scanCached(join(dir, "page.kit.mx"), { targets });
    const box = scanCached(join(dir, "page.box.mx"), { targets });
    const mx = scanCached(join(dir, "page.mx"), { targets });
    expect([...kit.tags.keys()]).toEqual(["button"]);
    expect([...box.tags.keys()]).toEqual(["crate"]);
    expect([...mx.tags.keys()]).toEqual(["card"]);
    expect(scanCached(join(dir, "other.kit.mx"), { targets })).toBe(kit);
    expect(scanCached(join(dir, "other.box.mx"), { targets })).toBe(box);
    expect(scanCached(join(dir, "other.mx"), { targets })).toBe(mx);
  });

  it("a tag file another dialect's file in a shared directory changes is not this caller's evidence", () => {
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
    const crate = write("components/crate.box.mx");
    const kit = scanCached(join(dir, "page.kit.mx"), { targets });
    expect(evidenceOf(crate)).toEqual([]);
    writeFileSync(crate, "<span>edited</span>\n");
    expect(scanCached(join(dir, "page.kit.mx"), { targets })).toBe(kit);
  });
});

// Mesh's request: adding or removing a file in a tag directory invalidates
// the scan for the files below it. That is the listing rule; pinned for
// dialect `tagDirs`, at the caller's level and two levels above it, with
// the racy hash in play and with every file settled.
describe("a dialect tag directory's listing", () => {
  it.each([
    ["the default racy window", 2000],
    ["every file settled", 0],
  ])("an added or removed tag file is seen at once (%s)", async (_, racy) => {
    setRacyWindowForTests(racy);
    kitProject();
    write("components/button.kit.mx");
    write("a/b/components/chip.kit.mx");
    await settle();
    const near = "a/b/page.kit.mx";
    expect(tagsFrom(near)).toEqual(["button", "chip"]);
    expect(tagsFrom("page.kit.mx")).toEqual(["button"]);

    // Same level as the caller.
    write("a/b/components/badge.kit.mx");
    expect(tagsFrom(near)).toEqual(["badge", "button", "chip"]);
    unlinkSync(join(dir, "a/b/components/badge.kit.mx"));
    expect(tagsFrom(near)).toEqual(["button", "chip"]);

    // Two levels up from the caller.
    write("components/money.kit.mx");
    expect(tagsFrom(near)).toEqual(["button", "chip", "money"]);
    expect(tagsFrom("page.kit.mx")).toEqual(["button", "money"]);
    unlinkSync(join(dir, "components/money.kit.mx"));
    expect(tagsFrom(near)).toEqual(["button", "chip"]);
    expect(tagsFrom("page.kit.mx")).toEqual(["button"]);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(
      "kit-dialect",
    );
  });
});
