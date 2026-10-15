/**
 * The guard for `Dialect.messageVocabulary`: a message that a dialect file's
 * author reaches must spell the words a dialect can change ("attribute",
 * "attributes", a `<tag>`) through the `Voice`, never as a raw literal.
 *
 * It scans the string and template literals of the files that build those
 * messages (the IR entry's checks, the contract validators, the generic
 * lowering) and fails on
 *
 * - the noun `attribute`/`attributes` in a literal;
 * - a tag spelled by hand: a literal ending in `<` or `<@` before a `${…}`, or
 *   holding `<${`.
 *
 * A literal that is not a dialect-reachable message (MX's built-in tag text,
 * what a dialect's author reads at registration, an internal invariant, a
 * parser option name) is listed in `message-vocabulary-guard.allowlist.txt`
 * with the reason. The list is exact in both directions: a hit with no entry
 * fails, and an entry that matches no hit fails, so it cannot rot.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/** How a substitution reads in a joined literal. */
const HOLE = `$\{…}`;

/** The files whose literals are messages a dialect file's author can reach. */
const SCANNED = [
  "ir-entry/checks.ts",
  "ir-entry/declarations.ts",
  "custom-tags.ts",
  "wildcard-children.ts",
  "wildcard-resolve.ts",
  "lower.ts",
  "core.ts",
  "template-tag.ts",
  "uncalled-tag-file.ts",
  "parse-error-hints.ts",
  "stock-parser.ts",
  "mx-parse.ts",
  "tag-file.ts",
] as const;

interface Hit {
  file: string;
  fn: string;
  /** The literal as written, `${…}` for a substitution. */
  text: string;
  line: number;
  why: string;
}

interface Entry {
  file: string;
  fn: string;
  fragment: string;
  reason: string;
  line: number;
}

type AstNode = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AstNode).type === "string";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

/** The name a node introduces for the functions below it, if any. */
function nameIntroducedBy(node: AstNode): string | undefined {
  const id = node.id as { name?: string } | null | undefined;
  const key = node.key as { name?: string; value?: string } | undefined;
  if (node.type === "FunctionDeclaration" && id?.name) return id.name;
  if (node.type === "VariableDeclarator") {
    const init = node.init as AstNode | null;
    if (init && FUNCTION_TYPES.has(init.type) && id?.name) return id.name;
  }
  if (
    node.type === "ObjectMethod" ||
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod"
  ) {
    return key?.name ?? key?.value;
  }
  if (node.type === "ObjectProperty") {
    const value = node.value as AstNode | undefined;
    if (value && FUNCTION_TYPES.has(value.type)) return key?.name ?? key?.value;
  }
  return undefined;
}

function whyFlagged(parts: readonly string[], joined: string): string | null {
  for (const part of parts) {
    if (/\battributes?\b/i.test(part)) return "the noun `attribute`";
  }
  // A template literal `<${name}>` is the quasi ending in "<" (or "<@") then a
  // substitution; the joined text spells the substitution `${…}`.
  if (/<@?\$\{…\}/.test(joined)) return `a hand-spelled tag \`<${HOLE}>\``;
  if (parts.some((part) => part.includes("<${"))) {
    return "a hand-spelled dynamic tag `<${`";
  }
  return null;
}

function scan(file: string): Hit[] {
  const source = readFileSync(join(SRC, file), "utf8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
    errorRecovery: false,
  });
  const hits: Hit[] = [];
  const visit = (node: AstNode, names: readonly string[]): void => {
    const introduced = nameIntroducedBy(node);
    const scope = introduced ? [...names, introduced] : names;
    const fn = scope[scope.length - 1] ?? "<top>";
    const line = (node.loc as { start: { line: number } } | undefined)?.start
      .line;
    if (node.type === "StringLiteral") {
      const value = node.value as string;
      const why = whyFlagged([value], value);
      if (why) hits.push({ file, fn, text: value, line: line ?? 0, why });
    } else if (node.type === "TemplateLiteral") {
      const quasis = (node.quasis as AstNode[]).map(
        (quasi) =>
          (quasi.value as { cooked: string | null; raw: string }).cooked ??
          (quasi.value as { raw: string }).raw,
      );
      const joined = quasis.join(HOLE);
      const why = whyFlagged(quasis, joined);
      if (why) hits.push({ file, fn, text: joined, line: line ?? 0, why });
    }
    for (const [key, child] of Object.entries(node)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments" ||
        key === "innerComments"
      ) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) visit(item, scope);
      } else if (isNode(child)) {
        visit(child, scope);
      }
    }
  };
  visit(ast.program as unknown as AstNode, []);
  return hits;
}

function readAllowList(): Entry[] {
  const text = readFileSync(
    join(SRC, "message-vocabulary-guard.allowlist.txt"),
    "utf8",
  );
  const entries: Entry[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [location, reason] = line.split(/\s--\s(.*)$/s);
    const fields = (location ?? "").split(" :: ");
    if (fields.length !== 3 || !reason?.trim()) {
      throw new Error(
        `allowlist line ${index + 1}: write \`file :: function :: fragment -- reason\`, got: ${raw}`,
      );
    }
    entries.push({
      file: fields[0] as string,
      fn: fields[1] as string,
      fragment: fields[2] as string,
      reason: reason.trim(),
      line: index + 1,
    });
  });
  return entries;
}

const allow = readAllowList();
const hits = SCANNED.flatMap((file) => scan(file));
const covers = (entry: Entry, hit: Hit) =>
  entry.file === hit.file &&
  entry.fn === hit.fn &&
  hit.text.includes(entry.fragment);

describe("message vocabulary guard", () => {
  it("scans the files that build dialect-reachable messages", () => {
    for (const file of SCANNED) {
      expect(() => readFileSync(join(SRC, file), "utf8")).not.toThrow();
    }
    // The scan finds literals at all (a broken walk would pass vacuously).
    expect(hits.length).toBeGreaterThan(0);
  });

  it("finds no message spelling a dialect's words by hand outside the allow-list", () => {
    const unlisted = hits.filter(
      (hit) => !allow.some((entry) => covers(entry, hit)),
    );
    expect(
      unlisted.map(
        (hit) =>
          `${hit.file}:${hit.line} in ${hit.fn} (${hit.why}): ${hit.text}`,
      ),
      "route these through the Voice (`voiceOfCtx(ctx)`, the `Voice` parameter), or list them in message-vocabulary-guard.allowlist.txt with the reason",
    ).toEqual([]);
  });

  it("has no allow-list entry that matches nothing", () => {
    const stale = allow.filter(
      (entry) => !hits.some((hit) => covers(entry, hit)),
    );
    expect(
      stale.map(
        (entry) =>
          `line ${entry.line}: ${entry.file} :: ${entry.fn} :: ${entry.fragment}`,
      ),
      "delete these entries: the literal they allowed is gone or now goes through the Voice",
    ).toEqual([]);
  });

  it("gives every allow-list entry a reason", () => {
    for (const entry of allow) expect(entry.reason.length).toBeGreaterThan(8);
  });
});
