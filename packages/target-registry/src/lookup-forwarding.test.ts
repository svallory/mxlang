import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetLookup } from "@mxlang/core";
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

/**
 * The caller's lookup, recording which of its members the compile reads.
 * Core no longer reads a callee's `Input` for attribute tags, so no compile
 * output differs by lookup any more; the recording is what shows the caller's
 * lookup, not the descriptor's own, reached the compile.
 */
function recordingLookup(): { lookup: TargetLookup; read: Set<string> } {
  const read = new Set<string>();
  const real = builtinLookup();
  const lookup = new Proxy(real, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        read.add(String(key));
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { lookup, read };
}

// Hostless targets without legacy host values are staged out of tooling.
// An unwired descriptor has no compile entry to forward options through.
const wired = builtinTargets.filter(
  (target) => target.load && (target.host || target.legacyHostValues),
);
describe("descriptor lookup forwarding", () => {
  for (const descriptor of wired) {
    it(`${descriptor.name} compiles with the caller's lookup`, () => {
      const filename = callee(
        descriptor.packageName === "@mxlang/host-react"
          ? "@mxlang/host-solid"
          : "@mxlang/host-react",
      );
      const { lookup, read } = recordingLookup();
      const compiler = descriptor.load?.(core);
      if (!compiler) throw new Error("missing compiler");
      compiler.compileModule(
        'import Card from "./Card.mx"\n<Card><@header>x</@header></Card>\n',
        filename,
        { targets: lookup, strict: descriptor.strict === "always" },
      );
      expect(read.size).toBeGreaterThan(0);
    });

    it(`${descriptor.name} still compiles with its own lookup without a caller lookup`, () => {
      const filename = callee(descriptor.packageName);
      const compiler = descriptor.load?.(core);
      if (!compiler) throw new Error("missing compiler");
      const { code } = compiler.compileModule(
        'import Card from "./Card.mx"\n<Card><@header>x</@header></Card>\n',
        filename,
        {},
      );
      expect(code).toContain("__mxAttrTag(");
    });
  }
});
