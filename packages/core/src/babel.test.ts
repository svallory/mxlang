/**
 * `coreBabel()` (PR 6 slice S1) replaced `@marko/compiler`'s
 * bundled Babel. The generator is part of the byte contract (`printExpression`
 * reaches emitted code through `ctx.generate`), so this file proves the stock
 * generator prints every payload of the repo's `.mx` corpus exactly as
 * Marko's patched 7.29.7 one did, before and after `stripMxTypes`.
 *
 * The comparison side (`markoBabel()`) is a devDependency of core only until
 * slice S5 deletes `marko-frontend.ts`; the differential goes with it.
 */
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { coreBabel, withReasonFirst } from "./babel.ts";
import { compileSource } from "./compile.ts";
import type { Policy } from "./declarations.ts";
import { markoBabel } from "./marko-frontend.ts";
import { parseMx, stripMxTypes } from "./mx-parse.ts";
import { defaultSyntax } from "./syntax-table.ts";
import { lookup } from "./test-targets.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Comment nodes: the generator prints them only attached to a node. */
const COMMENT = new Set(["CommentBlock", "CommentLine"]);

/**
 * Whether `error` is a missing file or directory. Other test files write and
 * delete `.mx` fixtures under `packages/` while this one runs
 * (angular-checker's `virtual-tags-*` dirs), so a directory or file seen a
 * moment ago can be gone; only that is skipped, and any other error throws.
 */
function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/** Every `.mx` file under `dir`, outside `node_modules`, `dist` and dot dirs. */
function mxFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return out;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) mxFiles(path, out);
    else if (entry.name.endsWith(".mx")) out.push(path);
  }
  return out;
}

/**
 * The Babel nodes an MX document carries (not `Mx*` nodes): every payload and
 * every node nested in one, so each subtree is printed on its own too.
 */
function payloads(document: unknown): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, inMx: boolean): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inMx);
      return;
    }
    const type = (value as { type?: unknown }).type;
    const babel = typeof type === "string" && !type.startsWith("Mx");
    if (babel && !COMMENT.has(type)) found.push(value);
    const mx = inMx && !babel;
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || key === "extra" || key === "errors") continue;
      visit(child, mx);
    }
  };
  visit(document, true);
  return found;
}

/** `printExpression`'s call on each generator; a throw prints as its message. */
function print(
  generator: (node: never, options: object) => { code: string },
  node: unknown,
): string {
  try {
    return generator(node as never, { concise: true }).code;
  } catch (error) {
    return `throws: ${(error as Error).message}`;
  }
}

const files = mxFiles(join(ROOT, "packages"))
  .concat(mxFiles(join(ROOT, "examples")))
  .concat(mxFiles(join(ROOT, "apps")));

describe("coreBabel's generator prints as Marko's did", () => {
  it("finds a corpus", () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it.each([
    ["as parsed", false],
    ["after stripMxTypes", true],
  ])("every payload of every corpus file, %s", (_, strip) => {
    let compared = 0;
    const differences: string[] = [];
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      let document: unknown;
      try {
        document = parseMx(source, {
          syntax: defaultSyntax(),
          lookup: undefined,
        });
        if (strip) stripMxTypes(document);
      } catch {
        continue;
      }
      for (const node of payloads(document)) {
        compared++;
        const ours = print(coreBabel().generator, node);
        const marko = print(markoBabel().generator, node);
        if (ours !== marko) {
          differences.push(
            `${relative(ROOT, file)}: ${JSON.stringify(marko)} -> ${JSON.stringify(ours)}`,
          );
        }
      }
    }
    expect(compared).toBeGreaterThan(2000);
    expect(differences).toEqual([]);
  });
});

describe("coreBabel's code frame frames as Marko's did", () => {
  it.each([
    ["a point", { start: { line: 2, column: 3 }, end: { line: 2, column: 3 } }],
    ["a range", { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }],
  ])("%s, with a message", (_, loc) => {
    const options = {
      highlightCode: true,
      message: "Unexpected token",
      linesAbove: 2,
      linesBelow: 3,
      startLine: 1,
    };
    const code = "<div>\n  ${a b}\n</div>";
    expect(coreBabel().codeFrameColumns(code, loc, options)).toBe(
      markoBabel().codeFrameColumns(code, loc, options),
    );
  });
});

describe("withReasonFirst puts a parse error's reason on the first line", () => {
  const open: Policy = {
    tags: {},
    isElement: () => true,
    isComponent: () => false,
  };

  function thrown(source: string): Error {
    try {
      compileSource(`${source}\n`, "/f/t.mx", open, {
        targets: lookup,
        emitIr: () => "",
      });
    } catch (error) {
      return error as Error;
    }
    throw new Error(`${source} compiled`);
  }

  it.each([
    ["<div x=a +/>", "EOL reached while parsing regular expression"],
    ["<div>${}</div>", "Invalid placeholder, the expression cannot be missing"],
    ["<let/x=/>", "Missing value for attribute"],
    ["<div x=/>", "Missing value for attribute"],
    ["<div>${a b}</div>", "Expected a single expression"],
    ["<div x=(/>", "EOL reached while parsing regular expression"],
    ["<div x=a b=>", "Missing value for attribute"],
    ["<const/x=1 +/>", "EOL reached while parsing regular expression"],
    ["<div>${1 +}</div>", "Unexpected token"],
    ["<div x=[1,/>", "EOL reached while parsing regular expression"],
    ["<div ...>", "Missing value for attribute"],
    ["<div x=a.>", "Unexpected token"],
    ["<if=>x</if>", "Missing value for attribute"],
    ["<div>${(}</div>", "Mismatched group"],
  ])("%s", (source, reason) => {
    const error = thrown(source);
    // Today's shape: an empty first line, then the position.
    expect(error.message.split("\n")[0]).toBe("");
    const fixed = withReasonFirst(error);
    const first = fixed.message.split("\n")[0] as string;
    expect(first.trim()).not.toBe("");
    expect(first).toContain(reason);
    expect(first).not.toMatch(/\.mx:\d+:\d+/);
    // The code frame and its position follow, and the original is untouched.
    expect(fixed.message).toContain(error.message.trim());
    expect(error.message.split("\n")[0]).toBe("");
    expect(fixed.name).toBe(error.name);
    expect(Object.getPrototypeOf(fixed)).toBe(Object.getPrototypeOf(error));
  });

  it("leaves a message that already starts with text as it is", () => {
    const error = new Error("plain reason");
    expect(withReasonFirst(error)).toBe(error);
  });
});
