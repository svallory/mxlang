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
 *   holding `<${`;
 * - a built-in tag written as MX's `<name>` (`<if>`, `<const/x=…/>`, `<try>`):
 *   a message names a built-in the way the file's dialect spells it
 *   (`voice.tag(name)`), and shows an MX-syntax example only when that
 *   spelling is MX's own (`writesMxSyntax`).
 *
 * A literal that is not a dialect-reachable message (what a dialect's author
 * reads at registration, an internal invariant, a parser option name, an
 * example shown only for MX's own spelling) is listed in `message-vocabulary-guard.allowlist.txt`
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
  "builtin-tags.ts",
  "render-let-write.ts",
  "tag-names.ts",
  "attribute-value.ts",
] as const;

/**
 * The tags MX defines (a dialect may spell each differently): a literal that
 * writes one as `<name` followed by a delimiter is a hit.
 */
const BUILTIN_TAGS = [
  "if",
  "else",
  "else-if",
  "for",
  "while",
  "const",
  "let",
  "define",
  "return",
  "effect",
  "script",
  "style",
  "try",
  "await",
  "lifecycle",
  "id",
  "log",
  "debug",
  "show",
  "html-comment",
  "html-script",
  "html-style",
  "attrs",
] as const;

/** `<if>`, `<const/x=1/>`, `<for|item| of=…>`, `<else if=…>`, `<try`. */
const MX_BUILTIN_TAG = new RegExp(
  `<(?:${BUILTIN_TAGS.join("|")})(?![\\w-])`,
);

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
  for (const part of parts) {
    const found = MX_BUILTIN_TAG.exec(part);
    if (found) return `a built-in tag written as MX's \`${found[0]}>\``;
  }
  return null;
}

/** The literals of `source` (the text of `file`) that spell a dialect's words. */
function scanSource(file: string, source: string): Hit[] {
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

function scan(file: string): Hit[] {
  return scanSource(file, readFileSync(join(SRC, file), "utf8"));
}

function readAllowList(text: string): Entry[] {
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

/**
 * An entry allows the span its fragment names, not the literal around it. The
 * fragment is removed from the hit's text and what is left is checked again,
 * so a literal that holds an allowed example and also a raw noun is still a
 * hit. A fragment starting with `==` allows only a literal that is exactly the
 * text after it (a contract key, an internal label).
 */
const WHOLE = "==";

function covering(entry: Entry, hit: Hit): boolean {
  if (entry.file !== hit.file || entry.fn !== hit.fn) return false;
  return entry.fragment.startsWith(WHOLE)
    ? hit.text === entry.fragment.slice(WHOLE.length)
    : hit.text.includes(entry.fragment);
}

/** What is still wrong in `hit` once the allowed spans are taken out, or null. */
function remainder(hit: Hit, entries: readonly Entry[]): string | null {
  let text = hit.text;
  for (const entry of entries) {
    if (!covering(entry, hit)) continue;
    text = entry.fragment.startsWith(WHOLE)
      ? ""
      : text.split(entry.fragment).join("");
  }
  return whyFlagged([text], text);
}

/** The hits no entry (or not all of the hit's spans) allows. */
function unlisted(found: readonly Hit[], entries: readonly Entry[]): Hit[] {
  return found.filter((hit) => remainder(hit, entries) !== null);
}

/** The entries no hit uses. */
function stale(found: readonly Hit[], entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => !found.some((hit) => covering(entry, hit)));
}

const allow = readAllowList(
  readFileSync(join(SRC, "message-vocabulary-guard.allowlist.txt"), "utf8"),
);
const hits = SCANNED.flatMap((file) => scan(file));

describe("message vocabulary guard", () => {
  it("scans the files that build dialect-reachable messages", () => {
    for (const file of SCANNED) {
      expect(() => readFileSync(join(SRC, file), "utf8")).not.toThrow();
    }
    // The scan finds literals at all (a broken walk would pass vacuously).
    expect(hits.length).toBeGreaterThan(0);
  });

  it("finds no message spelling a dialect's words by hand outside the allow-list", () => {
    expect(
      unlisted(hits, allow).map(
        (hit) =>
          `${hit.file}:${hit.line} in ${hit.fn} (${hit.why}): ${hit.text}`,
      ),
      "route these through the Voice (`voiceOfCtx(ctx)`, the `Voice` parameter), or list them in message-vocabulary-guard.allowlist.txt with the reason",
    ).toEqual([]);
  });

  it("has no allow-list entry that matches nothing", () => {
    expect(
      stale(hits, allow).map(
        (entry) =>
          `line ${entry.line}: ${entry.file} :: ${entry.fn} :: ${entry.fragment}`,
      ),
      "delete these entries: the literal they allowed is gone or now goes through the Voice",
    ).toEqual([]);
  });

  it("gives every allow-list entry a reason", () => {
    for (const entry of allow) expect(entry.reason.length).toBeGreaterThan(8);
  });

  describe("catches a migrated site that is reverted to raw text", () => {
    /**
     * Each case takes the real file, swaps one voiced message back to the text
     * it had before the vocabulary, and expects the guard to flag a hit the
     * allow-list does not cover. The swap is checked to apply, so a refactor
     * that moves the message fails here instead of passing vacuously.
     */
    const revert = (
      file: string,
      from: string,
      to: string,
      count: number,
    ): Hit[] => {
      const source = readFileSync(join(SRC, file), "utf8");
      expect(source.split(from).length - 1, `${from} in ${file}`).toBe(count);
      return scanSource(file, source.split(from).join(to));
    };

    it("flags `accepts no attributes` in custom-tags.ts", () => {
      const reverted = revert(
        "custom-tags.ts",
        "`accepts no ${voice.attributes}`",
        '"accepts no attributes"',
        2,
      );
      const fresh = unlisted(reverted, allow);
      expect(fresh.length).toBeGreaterThanOrEqual(2);
      expect(fresh.every((hit) => hit.text === "accepts no attributes")).toBe(
        true,
      );
    });

    it("flags a hand-spelled tag-variable message in ir-entry/checks.ts", () => {
      const reverted = revert(
        "ir-entry/checks.ts",
        "${activeVoice.tag(tag.name, tag.trigger)}",
        "\\`<${tag.name}>\\`",
        1,
      );
      expect(unlisted(reverted, allow).length).toBeGreaterThanOrEqual(1);
    });

    it("flags a hand-spelled tag beside an allowed example in lower.ts", () => {
      const reverted = revert(
        "lower.ts",
        "${tagText(ctx, name, node)} is bound in this file",
        "\\`<${name}>\\` is bound in this file",
        1,
      );
      expect(unlisted(reverted, allow).length).toBeGreaterThanOrEqual(1);
    });

    it("flags a built-in tag written as MX's in lower.ts", () => {
      const reverted = revert(
        "lower.ts",
        '`${tagText(ctx, "const", node)} without a value`',
        "\"`<const>` without a value\"",
        1,
      );
      const fresh = unlisted(reverted, allow);
      expect(fresh.map((hit) => hit.text)).toEqual([
        "`<const>` without a value",
      ]);
    });

    it("flags a built-in tag written as MX's in a message another file builds", () => {
      const reverted = revert(
        "ir-entry/declarations.ts",
        '${voice.tag("return")} needs the evaluated mode',
        "\\`<return>\\` needs the evaluated mode",
        1,
      );
      expect(unlisted(reverted, allow).length).toBeGreaterThanOrEqual(1);
    });

    it("tells a built-in from a custom tag of a similar name", () => {
      const found = scanSource(
        "a.ts",
        "function f() { return ['`<for>`', '`<form>`', '`<if-else>`', '`<lifecycle/>`', '`<const/x=1/>`', '`<@catch>`', '`<entity>`']; }",
      );
      expect(found.map((hit) => hit.text)).toEqual([
        "`<for>`",
        "`<lifecycle/>`",
        "`<const/x=1/>`",
      ]);
    });

    it("lets an allowed example stand when nothing else in its literal is raw", () => {
      const entries = readAllowList(
        "a.ts :: f :: <${…}=x> -- example: shown in MX syntax\n",
      );
      const only = scanSource(
        "a.ts",
        "function f() { return `use <${y}=x>`; }",
      );
      expect(only.length).toBe(1);
      expect(unlisted(only, entries)).toEqual([]);
      const mixed = scanSource(
        "a.ts",
        "function f() { return `use <${y}=x> and an attribute`; }",
      );
      expect(unlisted(mixed, entries).length).toBe(1);
    });

    it("lets a whole-literal key stand only as exactly that literal", () => {
      const entries = readAllowList(
        "a.ts :: f :: ==attributes -- key: a contract key\n",
      );
      expect(
        unlisted(
          scanSource("a.ts", 'function f() { return "attributes"; }'),
          entries,
        ),
      ).toEqual([]);
      expect(
        unlisted(
          scanSource(
            "a.ts",
            'function f() { return "accepts no attributes"; }',
          ),
          entries,
        ).length,
      ).toBe(1);
    });
  });
});
