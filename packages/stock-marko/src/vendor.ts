/**
 * The vendored, unpatched htmljs-parser 5.18.0 (decision 157.3's stock
 * reference). `vendor/htmljs-parser-5.18.0.tgz` is the published npm
 * tarball, byte for byte: its sha512 equals the integrity `bun.lock`
 * records for `htmljs-parser@5.18.0`. Bun's `patchedDependencies` patches
 * every installed copy of that name/version — including an npm-alias
 * install (`htmljs-parser-stock`, measured 2026-10-06: the alias lands
 * patched) — so the stock bytes live here as a tarball and are extracted
 * to the OS temp dir on first use.
 *
 * Provenance: fetched from
 * `https://registry.npmjs.org/htmljs-parser/-/htmljs-parser-5.18.0.tgz`;
 * the upstream tag is `v5.18.0` of `marko-js/htmljs-parser` (local copy
 * `/Users/svallory/work/mx/data/forks/htmljs-parser`). The forward-patch
 * test in `vendor.test.ts` proves these bytes are the exact pre-image of
 * `patches/htmljs-parser@5.18.0.patch` against the installed, patched
 * `dist`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const STOCK_PARSER_VERSION = "5.18.0";
export const STOCK_TARBALL_PATH = fileURLToPath(
  new URL("../vendor/htmljs-parser-5.18.0.tgz", import.meta.url),
);
/** The integrity `bun.lock` records for `htmljs-parser@5.18.0`. */
export const STOCK_TARBALL_INTEGRITY =
  "sha512-ANKBAi2UyiQ7K/In2a3jZLt/WLAIKl8GFE3k5KIYEaroUdOBtt/gnclkJcSMI+kPChWdGOw3YHnbequVNy39Tg==";

/**
 * Identifiers the root patch adds to the published builds, derived from
 * `patches/htmljs-parser@5.18.0.patch` (`+` lines). Stock bytes contain
 * none of them; `vendor.test.ts` also asserts each is in the patch, so a
 * patch change that renames one rots loudly here.
 */
export const PATCH_MARKERS = [
  "lexAtom",
  "onAtom",
  "isUnicodeWordCode",
  "isUnicodeWhitespaceCode",
  "isUnicodeSpaceCode",
  "wordWidthBefore",
  "wordWidthAt",
  "attrValue",
  "defaultAtom",
  "isSingleAtomDefault",
  "isIdentStartCode",
  "isNameStartAt",
  "isBareColonEnd",
  "standInAtoms",
] as const;

export function sha512Base64(path: string): string {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

/** Minimal ustar reader: name (with prefix), size, type 0 files only. */
export function untar(tgzPath: string): Map<string, Buffer> {
  const data = gunzipSync(readFileSync(tgzPath));
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const sizeText = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const size = Number.parseInt(sizeText, 8);
    const type = String.fromCharCode(header[156] ?? 48);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (type === "0" || type === "\0") {
      files.set(fullName, data.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const EXTRACTED_FILES = [
  "dist/index.js",
  "dist/index.mjs",
  "dist/package.json",
  "LICENSE",
  "package.json",
] as const;

export interface StockParserFiles {
  dir: string;
  /** `dist/index.js` (CJS). */
  cjs: string;
  /** `dist/index.mjs` (ESM). */
  mjs: string;
  license: string;
}

let cached: StockParserFiles | undefined;

/**
 * Verifies the vendored tarball's integrity and extracts the files the
 * runtime needs into `tmpdir()/mx-stock-marko-<integrity>/`. Throws when
 * the tarball's sha512 differs from `STOCK_TARBALL_INTEGRITY`.
 */
export function ensureStockParserExtracted(): StockParserFiles {
  if (cached) return cached;
  const digest = sha512Base64(STOCK_TARBALL_PATH);
  if (`sha512-${digest}` !== STOCK_TARBALL_INTEGRITY) {
    throw new Error(
      `vendor/htmljs-parser-${STOCK_PARSER_VERSION}.tgz: sha512 is sha512-${digest}, expected ${STOCK_TARBALL_INTEGRITY} (the bun.lock integrity for htmljs-parser@${STOCK_PARSER_VERSION})`,
    );
  }
  const dir = join(
    tmpdir(),
    `mx-stock-marko-${STOCK_PARSER_VERSION}-${digest.slice(0, 16)}`,
  );
  const marker = join(dir, ".integrity");
  if (!(existsSync(marker) && readFileSync(marker, "utf8") === digest)) {
    const files = untar(STOCK_TARBALL_PATH);
    for (const name of EXTRACTED_FILES) {
      const content = files.get(`package/${name}`);
      if (!content) {
        throw new Error(`vendor tarball is missing package/${name}`);
      }
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(marker, digest);
  }
  cached = {
    dir,
    cjs: join(dir, "dist/index.js"),
    mjs: join(dir, "dist/index.mjs"),
    license: join(dir, "LICENSE"),
  };
  return cached;
}

/** The text of one extracted stock file, for marker and byte checks. */
export function readStockFile(name: (typeof EXTRACTED_FILES)[number]): string {
  const { dir } = ensureStockParserExtracted();
  return readFileSync(join(dir, name), "utf8");
}

/** Files present in the extraction dir (test support). */
export function listExtracted(): string[] {
  const { dir } = ensureStockParserExtracted();
  return readdirSync(dir, { recursive: true }) as string[];
}
