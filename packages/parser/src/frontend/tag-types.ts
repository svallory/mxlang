/**
 * The front end's `tagTypes` (decision 182 addenda 2 and 3), built before the
 * parse from the two per-target inputs, so the template parser decides tag
 * types from the table alone and no handler returns a decision.
 *
 * INTERIM until PR C (`lang-ext-syntax-table`), which builds the table in
 * core from the taglib and discovered `parseOptions`, where the set of tag
 * names is known. Here `tagShape` is a function with no domain, so the
 * source is pre-scanned: every run that can be a static tag name is asked
 * once. The scan covers every name context of the corpus and the tracked
 * `.mx` files; for a parser quirk it misses (error-path heads in fuzzed
 * input), `parse` restarts with the missed name added. A caller that has
 * the table passes `ParseOptions.tagTypes` and no scan runs.
 */
import type { MxBodyMode, MxStatementKeyword } from "@mxlang/babel/mx-ast";
import { TagType } from "../template/index.ts";
import type { TagType as TagTypeValue } from "../template/internal.ts";

/** Where a tag name can start: after these (or at the start of the input), never mid-name. */
function startsName(code: number): boolean {
  return (
    code <= 32 || // whitespace and line breaks: a concise line, an open tag after spaces
    code === 60 || // `<`
    code === 44 || // `,` (a concise head continued, `,div`)
    code === 47 || // `/` (the end of a `/* */` before a head)
    code === 91 || // `[` (an attribute group opened before the name)
    code === 93 || // `]` (an attribute group before a head)
    code === 125 || // `}` (after a `$ { … }` block on the same line)
    code === 0xfeff // the byte order mark
  );
}

/**
 * Where a tag name starting at `start` ends: `TAG_NAME`'s terminators, in
 * concise mode (`;`, `[`) or in HTML mode (`>`). `.`/`#` start a shorthand,
 * `${` a dynamic name.
 */
function nameEnd(source: string, start: number, concise: boolean): number {
  for (let at = start; at < source.length; at++) {
    const code = source.charCodeAt(at);
    if (
      code <= 32 ||
      code === 61 || // =
      code === 40 || // (
      code === 47 || // /
      code === 124 || // |
      code === 60 || // <
      code === 44 || // ,
      code === 46 || // .
      code === 35 || // #
      (code === 58 && source.charCodeAt(at + 1) === 61) || // :=
      (code === 36 && source.charCodeAt(at + 1) === 123) || // ${
      (concise ? code === 59 || code === 91 : code === 62) // ; [ or >
    ) {
      return at;
    }
  }
  return source.length;
}

/**
 * Every run of `source` that can be a static tag name, in both modes: a
 * superset of the names the parse meets (text words included, at the cost
 * of one `tagShape` call per distinct word). A run of `]` inside one name
 * (`a]b]c`, HTML mode) is the one shape that rescans.
 */
export function candidateNames(source: string): Set<string> {
  // An unnamed tag (`<.c/>`, `,div`) is typed by the empty name.
  const names = new Set<string>([""]);
  for (let start = 0; start < source.length; start++) {
    if (start > 0 && !startsName(source.charCodeAt(start - 1))) continue;
    if (startsName(source.charCodeAt(start))) continue;
    for (const concise of [true, false]) {
      const end = nameEnd(source, start, concise);
      if (end > start) names.add(source.slice(start, end));
    }
  }
  return names;
}

/** A body mode's tag type: html (and `preserve`) is the absent default. */
function typeOf(mode: MxBodyMode): TagTypeValue | undefined {
  switch (mode) {
    case "void":
      return TagType.void;
    case "parsed-text":
    case "parsed-text-preserve":
      return TagType.text;
    default:
      return undefined;
  }
}

/**
 * The table for `source`, keyed by the full written static name (addendum
 * 3): a statement keyword is `statement` (the parser applies it only on a
 * concise line), any other name its `tagShape` body mode's type. `@name` is
 * never asked (an attribute tag's body is html, decision 163 addendum 8).
 */
/** `tagTypes[name]` as an own property: a tag named `toString` is not a function. */
export function ownTagType(
  tagTypes: Readonly<Record<string, TagTypeValue>>,
  name: string,
): TagTypeValue | undefined {
  return Object.hasOwn(tagTypes, name) ? tagTypes[name] : undefined;
}

export function buildTagTypes(
  source: string,
  statementKeywords: ReadonlySet<MxStatementKeyword>,
  shapeOf: (name: string) => MxBodyMode,
): Record<string, TagTypeValue> {
  // No prototype: a tag may be named `__proto__` or `constructor`.
  const table: Record<string, TagTypeValue> = Object.create(null);
  for (const name of candidateNames(source)) {
    if (name.startsWith("@")) continue;
    const type = statementKeywords.has(name as MxStatementKeyword)
      ? TagType.statement
      : typeOf(shapeOf(name));
    if (type !== undefined) table[name] = type;
  }
  return table;
}

/** A tag type's name, for messages. */
const TYPE_NAMES: Record<number, string> = {
  [TagType.html]: "html",
  [TagType.text]: "text",
  [TagType.void]: "void",
  [TagType.statement]: "statement",
};

/**
 * The statement rule against a caller's table, checked before the parse
 * (decision 182 addenda 2 and 3): `statementKeywords` alone decides what is a
 * statement, on a concise line only. A table may give a keyword `statement`
 * or leave it out (it is filled in, see `withStatementKeywords`), never
 * another type, and may give no other name `statement`. A keyword's
 * HTML-mode spelling is parsed as html, so `tagShape` must answer `html` or
 * `preserve` for it. Returns one sentence per problem; empty means the
 * parse can start. `shapeOf` is asked once per keyword.
 */
export function statementRuleProblems(
  tagTypes: Readonly<Record<string, TagTypeValue>> | undefined,
  statementKeywords: ReadonlySet<MxStatementKeyword>,
  shapeOf: (name: string) => string,
): string[] {
  const problems: string[] = [];
  for (const [name, type] of Object.entries(tagTypes ?? {})) {
    const keyword = statementKeywords.has(name as MxStatementKeyword);
    if (keyword && type !== TagType.statement) {
      problems.push(
        `\`tagTypes\` gives the statement keyword "${name}" ${TYPE_NAMES[type] ?? type}; a statement keyword is a statement on a concise line whatever the table says, so the table may only give it statement (3) or leave it out`,
      );
    } else if (!keyword && type === TagType.statement) {
      problems.push(
        `\`tagTypes\` gives "${name}" statement, but it is not in \`statementKeywords\`; only a statement keyword is a statement`,
      );
    }
  }
  for (const keyword of statementKeywords) {
    const mode = shapeOf(keyword);
    if (
      mode === "void" ||
      mode === "parsed-text" ||
      mode === "parsed-text-preserve"
    ) {
      problems.push(
        `\`tagShape\` answers "${mode}" for the statement keyword "${keyword}", but its HTML-mode spelling (\`<${keyword}>\`) is parsed as html; answer "html" or "preserve" for it`,
      );
    }
  }
  return problems;
}

/**
 * `tagTypes` with every statement keyword given `statement`: the table the
 * template parser reads always carries the statement rule, whether or not a
 * caller's table or the pre-scan listed a keyword. The same object when
 * nothing is missing.
 */
export function withStatementKeywords(
  tagTypes: Readonly<Record<string, TagTypeValue>>,
  statementKeywords: ReadonlySet<MxStatementKeyword>,
): Readonly<Record<string, TagTypeValue>> {
  let out: Record<string, TagTypeValue> | undefined;
  for (const keyword of statementKeywords) {
    if (ownTagType(tagTypes, keyword) !== TagType.statement) {
      out ??= { ...tagTypes };
      out[keyword] = TagType.statement;
    }
  }
  return out ?? tagTypes;
}
