// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tokens are MX source with ${…} placeholders
/**
 * Brief §1.2 E: two seeded input generators for the front end's no-throw
 * fuzz. `characters` draws from the template alphabet (markup and expression
 * punctuation, letters, non-ASCII letters, Unicode whitespace and line
 * terminators); `tokens` assembles tags, attributes, shorthands, statements,
 * concise lines and placeholders. `run` parses each input and checks the span
 * invariant; the long run is `long-fuzz.ts`.
 */
import { parse } from "../parse.ts";
import { checkInvariants } from "./invariants.ts";
import { OPTIONS } from "./options.ts";

/** mulberry32: a small seeded PRNG, so a failing input is reproducible from its seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, list: readonly T[]): T =>
  list[Math.floor(next() * list.length)] as T;

const ALPHABET = [
  ..."<>/=:#.@$!{}()[]|,;'\"`-?*+&^%~\\",
  ..."abcdivspnxyzABT0123456789_",
  " ",
  "\t",
  "\n",
  "\r\n",
  "é",
  "ß",
  "名",
  " ",
  " ",
  "　",
  "﻿",
  "${",
  "</",
  "/>",
  "--",
  "//",
  "/*",
  "*/",
  "<!--",
  "-->",
];

export function characters(seed: number, length: number): string {
  const next = random(seed);
  let out = "";
  const count = 1 + Math.floor(next() * length);
  for (let i = 0; i < count; i++) out += pick(next, ALPHABET);
  return out;
}

const NAMES = [
  "div",
  "p",
  "input",
  "script",
  "pre",
  "my-tag",
  "Card",
  "@head",
  "if",
  "for",
  "return",
  "const",
  "",
];
const SUGAR = [
  "#a",
  ".b",
  ":c",
  ".d:e",
  "#f.g",
  ".${x}",
  ".a${y}b",
  ":n:m",
  ".",
];
const ATTRS = [
  "x=1",
  "y",
  "z=a ? b : c",
  "w:=v",
  "on(e) { f(e) }",
  "async m() { }",
  "f(1)",
  "...rest",
  "=dflt",
  ":mail",
  ".cls",
  "#id=1",
  "a=[:b, :c]",
  's="q"',
  "t=`a${b}`",
  "/* c */",
  "// c\n",
  "class:x=1",
];
const HEAD = ["/v", "(a, b)", "<T>", "|p, q|", "<string>", "||"];
const LINES = [
  "static const a = 1",
  'import x from "y"',
  "export const B = 2",
  "$ const z = 1;",
  "$ { a }",
  "-- text ${y}",
  "${ x }",
  "<!-- c -->",
  "<!doctype html>",
  "<![CDATA[ d ]]>",
  "<?xml v?>",
  ",",
  "// line",
];

function tag(next: () => number, depth: number): string {
  const name = pick(next, NAMES);
  let head = name;
  while (next() < 0.3) head += pick(next, SUGAR);
  if (next() < 0.2) head += pick(next, HEAD);
  const attrs: string[] = [];
  while (next() < 0.5) attrs.push(pick(next, ATTRS));
  const open = `${head}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
  if (next() < 0.5) {
    // concise
    const children: string[] = [];
    if (depth < 3) while (next() < 0.4) children.push(item(next, depth + 1));
    const pad = "  ".repeat(depth + 1);
    return [
      open,
      ...children.map((c) => `${pad}${c.replace(/\n/g, `\n${pad}`)}`),
    ].join("\n");
  }
  if (next() < 0.3) return `<${open}/>`;
  let body = "";
  if (depth < 3) while (next() < 0.4) body += item(next, depth + 1);
  const close =
    next() < 0.1 ? "</>" : next() < 0.05 ? "</wrong>" : `</${name}>`;
  return `<${open}>${body}${next() < 0.9 ? close : ""}`;
}

function item(next: () => number, depth: number): string {
  const roll = next();
  if (roll < 0.5) return tag(next, depth);
  if (roll < 0.8) return pick(next, LINES);
  return pick(next, ["text", " ", "\n", "${a}", "$!{b}", "é"]);
}

export function tokens(seed: number): string {
  const next = random(seed);
  const parts: string[] = [];
  const count = 1 + Math.floor(next() * 4);
  for (let i = 0; i < count; i++) parts.push(item(next, 0));
  let out = parts.join(next() < 0.5 ? "\n" : "");
  // Cut some inputs short, to reach the end-of-input paths.
  if (next() < 0.2) out = out.slice(0, Math.floor(next() * out.length));
  return out;
}

export interface FuzzResult {
  readonly inputs: number;
  /** A throw out of `parse`, an internal front-end error or a broken invariant. */
  readonly failures: { seed: number; input: string; problem: string }[];
  /** Inputs on which the template parser itself threw (a template-parser defect, reported, not a front-end failure). */
  readonly templateThrows: { seed: number; input: string; problem: string }[];
}

const TEMPLATE_THREW = "The MX template parser threw";

/** Parses each generated input: a throw, an internal error or a broken invariant is a failure. */
export function run(
  generate: (seed: number) => string,
  firstSeed: number,
  count: number,
): FuzzResult {
  const failures: FuzzResult["failures"] = [];
  const templateThrows: FuzzResult["templateThrows"] = [];
  for (let seed = firstSeed; seed < firstSeed + count; seed++) {
    const input = generate(seed);
    try {
      const document = parse(input, OPTIONS);
      const internal = document.errors.find(
        (e) => e.code === "MX_FRONT_END_INTERNAL",
      );
      if (internal?.message.startsWith(TEMPLATE_THREW)) {
        templateThrows.push({ seed, input, problem: internal.message });
      } else if (internal) {
        failures.push({ seed, input, problem: internal.message });
      }
      const broken = checkInvariants(document);
      if (broken.length) {
        failures.push({ seed, input, problem: broken[0] as string });
      }
    } catch (error) {
      failures.push({
        seed,
        input,
        problem: `threw ${(error as Error).message}`,
      });
    }
    if (failures.length > 20) break;
  }
  return { inputs: count, failures, templateThrows };
}
