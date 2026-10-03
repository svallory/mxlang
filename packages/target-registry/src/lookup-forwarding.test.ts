import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@mxlang/core";
import { afterEach, describe, expect, it } from "vitest";
import { builtinLookup, builtinTargets } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  core.clearScanCache();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function callee(packageName: string): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "mx-target-lookup-forwarding-")),
  );
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), '{"name":"lookup-forwarding"}');
  writeFileSync(
    join(dir, "Card.mx"),
    `import type { AttrTag } from "${packageName}"\nexport interface Input { header: AttrTag }\n<div/>\n`,
  );
  return join(dir, "page.mx");
}

// Hostless targets without legacy host values are staged out of tooling.
// An unwired descriptor has no compile entry to forward options through.
const wired = builtinTargets.filter(
  (target) => target.load && (target.host || target.legacyHostValues),
);
describe("descriptor lookup forwarding", () => {
  for (const descriptor of wired) {
    it(`${descriptor.name} uses the caller's full lookup for a cross-target AttrTag import`, () => {
      const filename = callee(
        descriptor.packageName === "@mxlang/react"
          ? "@mxlang/solid"
          : "@mxlang/react",
      );
      // This variable is intentionally structurally assignable before the
      // optional contract field lands too, so the initial failure is runtime.
      const options = {
        targets: builtinLookup(),
        strict: descriptor.strict === "always",
      };
      const compiler = descriptor.load?.(core);
      if (!compiler) throw new Error("missing compiler");
      expect(() =>
        compiler.compileModule(
          'import Card from "./Card.mx"\n<Card/>\n',
          filename,
          options,
        ),
      ).toThrow(/missing required attribute tag `<@header>`/);
    });

    it(`${descriptor.name} still defaults to its own lookup without a caller lookup`, () => {
      const filename = callee(descriptor.packageName);
      const compiler = descriptor.load?.(core);
      if (!compiler) throw new Error("missing compiler");
      expect(() =>
        compiler.compileModule(
          'import Card from "./Card.mx"\n<Card/>\n',
          filename,
          {},
        ),
      ).toThrow(/missing required attribute tag `<@header>`/);
    });
  }
});
