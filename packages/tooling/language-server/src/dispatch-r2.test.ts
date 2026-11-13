import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";
import { isMxDocument } from "./server.ts";

const dirs: string[] = [];
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-ls-dispatch-r2-")));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "dispatch-r2", mx: { host: "solid" } }),
  );
  return dir;
}
afterEach(() => {
  clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const languageIds = ["ngmx", "astromx"] as const;
const filenames = ["page.mx", "X.SOLID.MX", "x.Solid.mx", "a.b.mx"] as const;
describe("round 2 silent-kind language-id matrix", () => {
  for (const languageId of languageIds) {
    for (const filename of filenames) {
      it(`${languageId} does not silence ${filename}`, () => {
        const uri = join(project(), filename);
        const source = "<let/count=0/>\n";
        const policy = { target: "html", strict: true };
        const baseline = diagnoseDocument(source, uri, policy);
        expect(baseline).toHaveLength(1);
        expect(
          diagnoseDocument(source, uri, policy, undefined, languageId),
        ).toEqual(baseline);
      });
      it(`${languageId} does not change server recognition for ${filename}`, () => {
        const uri = `file:///app/${filename}`;
        expect(isMxDocument(uri, languageId)).toBe(isMxDocument(uri, ""));
      });
    }
    it(`${languageId} alone does not make an untitled or TypeScript buffer an MX document`, () => {
      expect(isMxDocument("untitled:App", languageId)).toBe(false);
      expect(isMxDocument("file:///app/page.ts", languageId)).toBe(false);
    });
  }
});

describe("server recognition ignores the suffix's case", () => {
  it.each(["file:///app/Card.MX", "file:///app/Counter.Solid.MX"])(
    "%s is an MX document",
    (uri) => {
      expect(isMxDocument(uri, "")).toBe(true);
    },
  );
});
