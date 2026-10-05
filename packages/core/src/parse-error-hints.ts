/**
 * Fix hints for Marko's own parse errors (audit item 14).
 *
 * `@marko/compiler` reports a syntax mistake in the vocabulary of its parser
 * ("Unexpected token, expected \"{\""), which says what it could not read but
 * not what to write. MX recognises the few mistakes authors from other
 * template languages make and appends one short sentence to the reason, in
 * place: same message, same position, nothing else changes. An error it does
 * not recognise is left untouched.
 *
 * Marko 6.3.51 is the authority for every suggestion (`<div id>` and
 * `<const/x=1/>` compile; a `$` scriptlet is rejected outright with
 * "Scriptlets are not supported when using the tags api.").
 */

import type { HostDeclarations } from "./declarations.ts";
import { lexedAtoms } from "./stock-parser.ts";

// With colours on (CI, FORCE_COLOR) Marko wraps the reason in escape codes that
// run to the end of the line, so allow SGR sequences after the reason.
const SGR = "(?:\\u001b\\[[0-9;]*m)*";

type Located = Error & {
  loc?: { start?: { line: number; column: number; index?: number } };
  label?: unknown;
  errors?: unknown[];
};

/** What to write instead of a scriptlet that declares `name`, core's default. */
const DEFAULT_REPLACEMENT = (name: string, keyword: "const" | "let" | "var") =>
  `declare a value with \`<${keyword === "const" ? "const" : "let"}/${name}=…/>\``;

export type ScriptletDeclaration = {
  name: string;
  keyword: "const" | "let" | "var";
};

/**
 * The scriptlet message tail: the sentence every host shares, plus the host's
 * replacement when the statement declares exactly one variable. A call, an
 * assignment, a class, an import or a destructuring declares no single value,
 * so nothing is advised for them.
 */
export function scriptletSentence(
  binding: ScriptletDeclaration | undefined,
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): string {
  if (!binding) return "";
  const replacement = (
    declarations?.scriptletReplacement ?? DEFAULT_REPLACEMENT
  )(binding.name, binding.keyword);
  return replacement ? `; ${replacement}` : "";
}

/**
 * The variable a `const|let|var NAME =` statement declares, when it declares
 * exactly that one (no second declarator after a top-level comma).
 */
export const declaredBinding = (
  statement: string,
): ScriptletDeclaration | undefined => {
  const found = statement.match(
    /^\s*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/,
  );
  if (!found) return undefined;
  let depth = 0;
  let quote = "";
  for (const char of found[3] ?? "") {
    if (quote) {
      if (char === quote) quote = "";
    } else if ("\"'`".includes(char)) quote = char;
    else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) return undefined;
  }
  return {
    name: found[2] as string,
    keyword: found[1] as ScriptletDeclaration["keyword"],
  };
};

/**
 * Whether `offset` sits inside a `{…}` expression of the tag or placeholder
 * being written (a multi-line attribute value, `${…}`), where a line starting
 * with `$` is expression text, not a scriptlet.
 */
function insideBraces(source: string, offset: number): boolean {
  const open = Math.max(
    source.lastIndexOf("<", offset),
    source.lastIndexOf("${", offset),
  );
  let depth = 0;
  let quote = "";
  for (const char of source.slice(Math.max(open, 0), offset)) {
    if (quote) {
      if (char === quote) quote = "";
    } else if ("\"'`".includes(char)) quote = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  return depth > 0;
}

/**
 * The atom a parse error at `offset` is on (`:a` at its `:`) or right after
 * (`{:a}` fails at the `}`). Only an atom the installed parser really lexed
 * counts (`lexedAtoms`), so a scriptlet, a statement tag or a ternary's `:`
 * never gets the hint.
 */
function atomAt(source: string, offset: number): string | undefined {
  const atoms = lexedAtoms(source);
  if (!atoms?.length) return undefined;
  const on = atoms.find((atom) => atom.start === offset);
  if (on) return source.slice(on.start, on.end);
  // Right after an atom only where a binding or a key would end (`{:a}`,
  // `(:a) =>`); `[:a :b]` fails at `:b`, a missing comma, not misuse.
  if (!/[)}\]=,;]/.test(source[offset] ?? "")) return undefined;
  const before = source.slice(0, offset).trimEnd().length;
  const after = atoms.find((atom) => atom.end === before);
  return after ? source.slice(after.start, after.end) : undefined;
}

/**
 * The last `word? :name` on the error's line starting at or before `offset` whose
 * `:name` the installed parser did not lex as an atom: `[written, word,
 * ":name"]`.
 */
function optionalMarkerBefore(
  source: string,
  offset: number,
): [string, string, string] | undefined {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const atoms = lexedAtoms(source);
  let found: [string, string, string] | undefined;
  for (const m of line.matchAll(
    /([A-Za-z_$][\w$]*)\?[ \t]+(:[A-Za-z_$][\w$]*(?:-[\w$]+)*)/g,
  )) {
    if (lineStart + m.index > offset) break;
    const [written, word = "", atom = ""] = m;
    const atomStart = lineStart + m.index + written.length - atom.length;
    if (atoms?.some((lexed) => lexed.start === atomStart)) continue;
    found = [written, word, atom];
  }
  return found;
}

/**
 * The `word<args> :name` on the error's line whose `:name` starts exactly at
 * `offset` (the `:` Babel tripped on) and that the installed parser did not
 * lex as an atom: `[typed, ":name"]` (decision 156 addendum 4). A match
 * elsewhere on the line is valid TypeScript and never takes the hint.
 */
function typeArgsBefore(
  source: string,
  offset: number,
): [string, string] | undefined {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const atoms = lexedAtoms(source);
  let found: [string, string] | undefined;
  for (const m of line.matchAll(
    /([A-Za-z_$][\w$]*<[^<>\n]*>)[ \t]+(:[A-Za-z_$][\w$]*(?:-[\w$]+)*)/g,
  )) {
    if (lineStart + m.index > offset) break;
    const [written, typed = "", atom = ""] = m;
    const atomStart = lineStart + m.index + written.length - atom.length;
    if (atomStart !== offset) continue;
    if (atoms?.some((lexed) => lexed.start === atomStart)) continue;
    found = [typed, atom];
  }
  return found;
}

/** Offset of a 1-based line and 0-based column in `source`. */
function offsetOf(source: string, line: number, column: number): number {
  let start = 0;
  for (let at = 1; at < line; at++) {
    const next = source.indexOf("\n", start);
    if (next === -1) return -1;
    start = next + 1;
  }
  return start + column;
}

function hintFor(
  reason: string,
  source: string,
  at: { line: number; column: number; index?: number },
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): string | null {
  const offset = at.index ?? offsetOf(source, at.line, at.column);
  if (offset < 0) return null;

  // Decision 156: Babel rejects an atom where a binding, an assignment target
  // or a shorthand property must stand (its stand-in is a number), at the atom
  // or right after it; say what the author wrote.
  const atom = atomAt(source, offset);
  // Decision 156 addendum 4: a ternary whose `:` was lexed as an atom because
  // the lexer read a spaced `< >` as comparison (`c ? a < b > :z`, a
  // conditional type inside type arguments). TypeScript owned that `:`.
  if (atom && reason.startsWith('Unexpected token, expected ":"')) {
    return `\`${atom}\` was read as an atom (decision 156), so the ternary has no \`:\`; if TypeScript owns that \`:\` (type arguments before it, ADR 156 known limits), write \`: ${atom.slice(1)}\` with a space`;
  }
  if (atom) {
    return `\`${atom}\` is an atom (decision 156): a value, not a binding, an assignment target or a shorthand property`;
  }

  // Review round 5 (N4): `cond? :yes : :no`. A `?` touching a word is
  // TypeScript's optional marker, so the parser lexed no atom after it and
  // Babel trips somewhere past it; name the spelling the author meant.
  const marker = optionalMarkerBefore(source, offset);
  if (marker) {
    const [written, word, atom] = marker;
    return `\`${written}\` is TypeScript's optional marker (a \`?\` touching \`${word}\`), so \`${atom}\` is not an atom there; write \`${word} ? ${atom}\` for a ternary`;
  }

  // Decision 156 addendum 4: `(a<b> :c)` with no open `?`. TypeScript reads
  // `a<b>` as type arguments, so the parser lexed no atom and Babel trips on
  // the `:`. The lexer does not decide this spelling; name the ambiguity.
  const typedArgs = typeArgsBefore(source, offset);
  if (typedArgs) {
    const [typed, atom] = typedArgs;
    return `\`${typed} ${atom}\` reads \`${typed}\` as type arguments (TypeScript's reading), so \`${atom}\` is not an atom there; this spelling is ambiguous (ADR 156, known limits)`;
  }

  // `<div id= class="a">`: the next attribute's name was read as `id`'s value,
  // so the parser trips on that attribute's own `=`.
  if (reason === 'Unexpected token, expected "{"' && source[offset] === "=") {
    const missing = source
      .slice(0, offset)
      .match(/([^\s=<>"'`/]+)\s*=\s+[^\s=<>"'`/]+$/)?.[1];
    if (missing) {
      return `\`${missing}=\` has no value; write \`${missing}="…"\` or \`${missing}=expr\`, or drop the \`=\``;
    }
  }

  // A syntax error inside a `$` scriptlet line: whatever is fixed there, the
  // line is rejected next, so say so now.
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const text = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const scriptlet = text.match(/^\s*\$\s+(\S.*)$/);
  if (scriptlet && !insideBraces(source, lineStart)) {
    return `scriptlets (\`$ …\`) are not supported${scriptletSentence(declaredBinding(scriptlet[1] ?? ""), declarations)}`;
  }
  return null;
}

/**
 * Appends `hint` to the first not-yet-hinted line of `message` that ends with
 * `reason`, searching from the frame that names `at` (`:line:column`, 1-based)
 * when the message has one. A hinted line no longer ends with the bare reason,
 * so the entries of an aggregate land on their own frames in order, and an
 * unhinted entry with the same reason cannot take another's hint.
 */
function appendToReason(
  message: string,
  reason: string,
  hint: string,
  at?: { line: number; column: number },
) {
  const escaped = reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ending = new RegExp(`${escaped}(${SGR})(?=\\r?\\n|$)`);
  const marker = at ? message.indexOf(`:${at.line}:${at.column + 1}\n`) : -1;
  const from = Math.max(marker, 0);
  const found = ending.exec(message.slice(from));
  if (!found) return message;
  const start = from + found.index;
  return `${message.slice(0, start)}${reason}; ${hint}${found[1]}${message.slice(start + found[0].length)}`;
}

/** `CompileError.message` is an accessor whose setter can drop an assignment. */
function setMessage(error: Error, message: string): void {
  Object.defineProperty(error, "message", {
    value: message,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hintOne(
  error: Located,
  source: string,
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): string | null {
  const reason = typeof error.label === "string" ? error.label : null;
  const at = error.loc?.start;
  if (!reason || !at) return null;
  const hint = hintFor(reason, source, at, declarations);
  if (!hint) return null;
  setMessage(error, appendToReason(error.message, reason, hint, at));
  error.label = `${reason}; ${hint}`;
  return hint;
}

/**
 * Appends a fix hint to a recognised Marko parse error's reason, in place
 * (message and `label`, the two places a caller reads it from). An aggregate
 * error is handled entry by entry, mirroring `annotateCloseTagOpener`.
 */
/** Marko's hint for a `{…}`-wrapped attribute value whose inside parses. */
const JSX_WRAP_SENTENCE =
  " Attribute values in Marko are plain JavaScript expressions, not JSX; remove the wrapping `{ }`.";

/**
 * `x={ new :a }` (decision 156; lead ruling, review round 3): a keyword key
 * followed by whitespace before `:` is read as the keyword plus an atom, so
 * `{ … }` fails and its inside (`new 0.`) parses, which makes Marko suggest
 * removing the braces. Say what happened instead, in place.
 */
function rewriteKeywordAtom(
  error: Located,
  source: string,
): string | undefined {
  const reason = typeof error.label === "string" ? error.label : "";
  const at = error.loc?.start;
  if (!reason.includes(JSX_WRAP_SENTENCE) || !at) return undefined;
  const offset = at.index ?? offsetOf(source, at.line, at.column);
  const keyword = source.slice(offset).match(/^[A-Za-z_$][\w$]*/)?.[0];
  if (!keyword) return undefined;
  const gap = source.slice(offset + keyword.length).match(/^\s+/)?.[0];
  if (!gap) return undefined;
  const atomStart = offset + keyword.length + gap.length;
  const atom = lexedAtoms(source)?.find((found) => found.start === atomStart);
  if (!atom) return undefined;
  const name = source.slice(atom.start + 1, atom.end);
  const sentence = ` \`${keyword} :${name}\` reads as the keyword \`${keyword}\` and the atom \`:${name}\` (decision 156); for an object key write \`{ ${keyword}: ${name} }\`.`;
  error.label = reason.replace(JSX_WRAP_SENTENCE, sentence);
  setMessage(error, error.message.replace(JSX_WRAP_SENTENCE, sentence));
  return sentence;
}

export function hintParseError(
  error: unknown,
  source: string,
  declarations?: Pick<HostDeclarations, "scriptletReplacement">,
): void {
  if (!(error instanceof Error)) return;
  const aggregate = error as Located;
  rewriteKeywordAtom(aggregate, source);
  for (const entry of aggregate.errors ?? []) {
    if (typeof (entry as Located | null)?.message !== "string") continue;
    const sentence = rewriteKeywordAtom(entry as Located, source);
    if (sentence) {
      setMessage(
        aggregate,
        aggregate.message.replace(JSX_WRAP_SENTENCE, sentence),
      );
    }
  }
  hintOne(aggregate, source, declarations);
  for (const entry of aggregate.errors ?? []) {
    if (typeof (entry as Located | null)?.message !== "string") continue;
    const reason = (entry as Located).label;
    const hint = hintOne(entry as Located, source, declarations);
    if (hint && typeof reason === "string") {
      setMessage(
        aggregate,
        appendToReason(
          aggregate.message,
          reason,
          hint,
          (entry as Located).loc?.start,
        ),
      );
    }
  }
}
