/**
 * `coreBabel()` (decision 197, PR 6 slice S1) replaced `@marko/compiler`'s
 * bundled Babel. The generator is part of the byte contract (`printExpression`
 * reaches emitted code through `ctx.generate`), so this file proves the stock
 * generator prints every payload of the repo's `.mx` corpus exactly as
 * Marko's patched 7.29.7 one did, before and after `stripMxTypes`.
 *
 * The comparison side (`markoBabel()`) is a devDependency of core only until
 * slice S5 deletes `marko-frontend.ts`; the differential goes with it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { coreBabel } from "./babel.ts";
import { markoBabel } from "./marko-frontend.ts";
import { parseMx, stripMxTypes } from "./mx-parse.ts";
import { defaultSyntax } from "./syntax-table.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Comment nodes: the generator prints them only attached to a node. */
const COMMENT = new Set(["CommentBlock", "CommentLine"]);

/** Every `.mx` file under `dir`, outside `node_modules`, `dist` and dot dirs. */
function mxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
      const source = readFileSync(file, "utf8");
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
