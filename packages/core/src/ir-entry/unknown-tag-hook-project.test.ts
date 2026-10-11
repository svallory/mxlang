/**
 * `Dialect.explainUnknownTag` beside the two ways a name is known without a
 * usable contract: a call of a name core refused a definition for
 * (`MX_RESERVED_TAG`) and a call of a dialect tag file whose contract did not
 * derive ("definition has errors"). Neither is an unknown tag, so the hook
 * is never called for them, on either path core finds unknown tags on.
 *
 * The test dialect `kit` (claiming `.kit.mx`, reserving `entity`, scanning
 * `concepts/`) is a fixture, not any real dialect. Its hook records every tag
 * it is called for on `globalThis.__kitExplained`.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { clearScanCache, scanCached } from "../scan-cache.ts";
import { clearTagFileCache } from "../tag-file.ts";
import { dialectProject } from "../test-dialect-project.ts";
import { testTargetLookup } from "../test-targets.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

const targets = testTargetLookup();
const EXPLAINED = "FIXTURE_EXPLAINED";

const explained = (): string[] =>
  (globalThis as unknown as { __kitExplained: string[] }).__kitExplained;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-unknown-tag-project-")));
  clearScanCache();
  clearTagFileCache();
  (globalThis as unknown as { __kitExplained: string[] }).__kitExplained = [];
});
afterEach(() => {
  clearScanCache();
  clearTagFileCache();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): string {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const MODULE = `
export default {
  table: {},
  explainUnknownTag(tag) {
    globalThis.__kitExplained.push(tag.name);
    return { code: "${EXPLAINED}", at: tag.nameSpan, message: "explained " + tag.name };
  },
  tagFile(file) {
    if (file.source.includes("BREAK")) throw new Error("boom");
    return { contract: {}, diagnostics: [] };
  },
};
`;

function kitProject() {
  dialectProject(dir, {
    packageName: "kit-dialect",
    manifest: {
      id: "kit",
      name: "Kit",
      extensions: [".kit.mx"],
      tagDirs: ["concepts"],
      reservedTags: ["entity"],
    },
    module: MODULE,
  });
}

/** A definition that fails the file elsewhere: `<needs/>` misses `name`. */
const NEEDS: Record<string, CustomTag> = {
  needs: { attributes: { name: { type: "string", required: true } } },
};

type Mode = "allow" | "reject";

/** `fail`: add a contract error elsewhere, so lowering fails (the scan path). */
function lower(
  source: string,
  mode: Mode,
  fail: boolean,
  customTags: Record<string, CustomTag> = {},
) {
  const file = join(dir, "page.kit.mx");
  const scanned = scanCached(file, { targets }).customTags;
  const options: LowerSourceOptions = {
    customTags: { ...scanned, ...customTags, ...(fail ? NEEDS : {}) },
    unknownTags: mode,
  };
  return lowerSource(fail ? `${source}<needs/>\n` : source, file, options);
}

const codes = (result: ReturnType<typeof lower>) =>
  result.diagnostics.map((diagnostic) => diagnostic.code);

const MODES: Array<[Mode, boolean]> = [
  ["allow", false],
  ["allow", true],
  ["reject", false],
  ["reject", true],
];
describe("a call of a refused name", () => {
  it.each(MODES)(
    "never reaches the hook and gets only MX_RESERVED_TAG: %s %s",
    (mode, fail) => {
      kitProject();
      const result = lower("<entity/>\n<ghost:x/>\n", mode, fail, {
        // `kit` reserves `entity`: this definition is refused.
        entity: { attributes: {} },
      });
      expect(explained()).toEqual(["ghost:x"]);
      const found = result.diagnostics.filter(
        (diagnostic) => diagnostic.line === 1,
      );
      expect(found.map((diagnostic) => diagnostic.code)).toEqual([
        "MX_RESERVED_TAG",
      ]);
      expect(codes(result)).toContain(EXPLAINED);
      expect(codes(result)).not.toContain("MX_UNKNOWN_TAG");
    },
  );

  it.each(MODES)(
    "is not explained even with an ancestor that is unknown: %s %s",
    (mode, fail) => {
      kitProject();
      const result = lower("<ghost:x><entity/></ghost:x>\n", mode, fail, {
        entity: { attributes: {} },
      });
      expect(explained()).not.toContain("entity");
      expect(
        result.diagnostics.filter(
          (diagnostic) =>
            diagnostic.code === EXPLAINED &&
            diagnostic.message.includes("entity"),
        ),
      ).toEqual([]);
    },
  );
});

describe("a call of a dialect tag file whose contract did not derive", () => {
  it.each(MODES)(
    "is a known name: its own error, no hook call, no MX_UNKNOWN_TAG: %s %s",
    (mode, fail) => {
      kitProject();
      write("concepts/broken.kit.mx", "<!-- BREAK -->\n");
      const result = lower("<broken/>\n<ghost:x/>\n", mode, fail);
      expect(explained()).toEqual(["ghost:x"]);
      const first = result.diagnostics.find(
        (diagnostic) => diagnostic.line === 1,
      );
      expect(first?.message).toContain("`<broken>`'s definition has errors");
      expect(
        result.diagnostics.filter(
          (diagnostic) =>
            diagnostic.line === 1 && diagnostic.code === EXPLAINED,
        ),
      ).toEqual([]);
      expect(codes(result)).not.toContain("MX_UNKNOWN_TAG");
      expect(codes(result)).toContain(EXPLAINED);
    },
  );
});
