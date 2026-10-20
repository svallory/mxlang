/**
 * The writes Marko refuses at compile time that core used to take silently:
 * a `<const>`, a `<for>` parameter or a `<define>` parameter written while the
 * template renders; a `<const>` or `<for>` parameter written in a handler or a
 * `<script>`; a `<let>` written above its declaration; a `<let>` as the left
 * side of a `for…of` or `for…in`. One error each, on `compileSource` and on
 * `lowerSource`, positioned at the write (the assignment or update, or a
 * loop's left side). Every row that must keep compiling is pinned beside the
 * ones that must not.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { lookup } from "./test-targets.ts";

const READONLY = "MX_READONLY_BINDING_WRITE";
const BELOW = "MX_LET_WRITE_BEFORE_DECLARATION";
const CONST_BELOW = "MX_CONST_WRITE_BEFORE_DECLARATION";
const LOOP = "MX_LET_LOOP_ASSIGNMENT";

const constMessage = (name: string) =>
  `\`${name}\` is a \`<const>\` and cannot be written. Keep a value that changes in a \`<let>\` and write that in an event handler or a \`<script>\` body, or derive a new value with another \`<const>\`.`;
const forMessage = (name: string) =>
  `\`${name}\` is a \`<for>\` parameter and cannot be written. Keep a value that changes in a \`<let>\`, or derive a new value with a \`<const>\`.`;
const defineMessage = (name: string) =>
  `\`${name}\` is a \`<define>\` parameter and cannot be written while the template renders. Write it in an event handler or a \`<script>\` body, or derive a value with \`<const>\`.`;
const definePlainMessage = (name: string) =>
  `\`${name}\` is a \`<define>\` parameter and cannot be written. Keep a value that changes in a \`<let>\`, or derive a new value with a \`<const>\`.`;
const belowMessage = (name: string) =>
  `\`${name}\` is a \`<let>\` declared below this write, and a \`<let>\` can only be written below its declaration. Move the \`<let>\` above this code.`;
const constBelowMessage = (name: string) =>
  `\`${name}\` is a \`<const>\` declared below this write, and a tag variable can only be assigned below its declaration. Move the \`<const>\` above this code.`;
const loopMessage = (name: string, loop: "of" | "in") =>
  `\`${name}\` is a \`<let>\`, so a \`for...${loop}\` cannot assign to it. Loop into a local variable and assign \`${name}\` from it instead.`;
const letRenderMessage = (name: string) =>
  `\`${name}\` is a \`<let>\` and cannot be written while the template renders. Write it in an event handler or a \`<script>\` body, or derive a value with \`<const>\`.`;

/** A host that has `<let>` and an element for every other name. */
const withLet: HostDeclarations = {
  name: "binding-write-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isBuiltinTag: (name) => name === "let",
  isDelegatedTag: (name) => name === "let",
  resolveDelegatedTag: () => ({}),
  resolveAttributeMethod: () => true,
};

function attempt(source: string): TranslateError | undefined {
  try {
    compileSource(source, "/page.mx", withLet, {
      targets: lookup,
      emitIr: () => "",
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

/** 1-based line, 0-based column of `needle` (found inside `within`) and its end. */
function span(source: string, needle: string, within = needle) {
  const base = source.indexOf(within);
  if (base < 0) throw new Error(`no ${within} in ${source}`);
  const at = base + within.indexOf(needle);
  const where = (offset: number) => {
    const before = source.slice(0, offset).split("\n");
    return { line: before.length, column: before.at(-1)?.length ?? 0 };
  };
  return { start: where(at), end: where(at + needle.length) };
}

type Row = {
  name: string;
  source: string;
  /** The text the error is positioned at. */
  write: string;
  /** Where `write` is found, when the text is not unique. */
  within?: string;
  code: string;
  message: string;
  /** `lowerSource` refuses `<define>` before it lowers anything. */
  skipLower?: boolean;
};

const row = (
  name: string,
  source: string,
  write: string,
  code: string,
  message: string,
  rest: { within?: string; skipLower?: boolean } = {},
): Row => ({ name, source, write, code, message, ...rest });

const LET = "<let/count=0/>\n";

const REFUSED: Row[] = [
  // --- a <const> --------------------------------------------------------
  row(
    "const written in a placeholder",
    "<const/x=1/>\n<div>${x = 2}</div>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const updated in a placeholder",
    "<const/x=1/>\n<div>${x++}</div>\n",
    "x++",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written in an attribute",
    "<const/x=1/>\n<div class=(x += 1)/>\n",
    "x += 1",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written by a destructuring in render",
    "<const/x=1/>\n<div>${[x] = [2]}</div>\n",
    "[x] = [2]",
    READONLY,
    constMessage("x"),
  ),
  row(
    "a name from a const's object pattern, written in render",
    "<const/{ a }=o/>\n<div>${a = 2}</div>\n",
    "a = 2",
    READONLY,
    constMessage("a"),
  ),
  row(
    "const written in an arrow handler",
    "<const/x=1/>\n<button onClick=() => { x = 2 }/>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written in a method handler",
    "<const/x=1/>\n<button onClick() { x = 2 }/>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const updated in a method handler",
    "<const/x=1/>\n<button onClick() { x++ }/>\n",
    "x++",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written by an array destructuring in a handler",
    "<const/x=1/>\n<button onClick() { [x] = [2] }/>\n",
    "[x] = [2]",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written by an object destructuring in a handler",
    "<const/x=1/>\n<button onClick() { ({ x } = o) }/>\n",
    "{ x } = o",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written in a callback inside a handler",
    "<const/x=1/>\n<button onClick() { xs.forEach(() => { x = 2 }) }/>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const as the left side of a for…of in a handler",
    "<const/x=1/>\n<button onClick() { for (x of xs) {} }/>\n",
    "x",
    READONLY,
    constMessage("x"),
    { within: "for (x of xs)" },
  ),
  row(
    "const written in a script",
    "<const/x=1/>\n<script>x = 2</script>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written after an await in a script",
    "<const/x=1/>\n<script>await go(); x += 2</script>\n",
    "x += 2",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written in a script of a nested block",
    "<const/x=1/>\n<if=ok>\n  <script>x = 2</script>\n</if>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  row(
    "const written in a handler of a nested block",
    "<const/x=1/>\n<div>\n  <button onClick() { x = 2 }/>\n</div>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  // --- a <for> parameter -------------------------------------------------
  row(
    "for value written in render",
    "<for|item| of=xs>\n  ${item = 2}\n</for>\n",
    "item = 2",
    READONLY,
    forMessage("item"),
  ),
  row(
    "for index updated in render",
    "<for|item, i| of=xs>\n  ${i++}\n</for>\n",
    "i++",
    READONLY,
    forMessage("i"),
  ),
  row(
    "for key written in render",
    "<for|k, v| in=o>\n  ${k = 'a'}\n</for>\n",
    "k = 'a'",
    READONLY,
    forMessage("k"),
  ),
  row(
    "for range index written in render",
    "<for|i| from=0 to=3>\n  ${i += 1}\n</for>\n",
    "i += 1",
    READONLY,
    forMessage("i"),
  ),
  row(
    "a name from a for parameter's object pattern, written in render",
    "<for|{ a }| of=xs>\n  ${a = 2}\n</for>\n",
    "a = 2",
    READONLY,
    forMessage("a"),
  ),
  row(
    "for value written in a handler",
    "<for|item| of=xs>\n  <button onClick() { item = 2 }/>\n</for>\n",
    "item = 2",
    READONLY,
    forMessage("item"),
  ),
  row(
    "for index updated in a handler",
    "<for|item, i| of=xs>\n  <button onClick() { i++ }/>\n</for>\n",
    "i++",
    READONLY,
    forMessage("i"),
  ),
  row(
    "for key written in a handler",
    "<for|k, v| in=o>\n  <button onClick() { k = 'a' }/>\n</for>\n",
    "k = 'a'",
    READONLY,
    forMessage("k"),
  ),
  row(
    "for value with a default written in a handler",
    "<for|item = 0| of=xs>\n  <button onClick() { item = 2 }/>\n</for>\n",
    "item = 2",
    READONLY,
    forMessage("item"),
  ),
  row(
    "for value written by a destructuring in a handler",
    "<for|item| of=xs>\n  <button onClick() { ({ item } = o) }/>\n</for>\n",
    "{ item } = o",
    READONLY,
    forMessage("item"),
  ),
  row(
    "for value written in a script",
    "<for|item| of=xs>\n  <script>item = 2</script>\n</for>\n",
    "item = 2",
    READONLY,
    forMessage("item"),
  ),
  row(
    "for value written in a handler of an inner block",
    "<for|item| of=xs>\n  <if=ok>\n    <button onClick() { item = 2 }/>\n  </if>\n</for>\n",
    "item = 2",
    READONLY,
    forMessage("item"),
  ),
  // --- a <define> parameter: a destructured name in render only, a plain name anywhere ------------------------------
  row(
    "define parameter written in render",
    "<define/D|{ a }|>\n  ${a = 2}\n</define>\n<D a=1/>\n",
    "a = 2",
    READONLY,
    defineMessage("a"),
    { skipLower: true },
  ),
  row(
    "define plain parameter updated in render",
    "<define/D|a|>\n  ${a++}\n</define>\n<D a=1/>\n",
    "a++",
    READONLY,
    definePlainMessage("a"),
    { skipLower: true },
  ),
  row(
    "define plain parameter written in a handler",
    "<define/D|a|>\n  <button onClick() { a = 2 }/>\n</define>\n<D a=1/>\n",
    "a = 2",
    READONLY,
    definePlainMessage("a"),
    { skipLower: true },
  ),
  row(
    "define plain parameter with a default, written in a handler",
    "<define/D|a = 1|>\n  <button onClick() { a = 2 }/>\n</define>\n<D/>\n",
    "a = 2",
    READONLY,
    definePlainMessage("a"),
    { skipLower: true },
  ),
  row(
    "define plain parameter written in a script",
    "<define/D|a|>\n  <script>a = 2</script>\n</define>\n<D a=1/>\n",
    "a = 2",
    READONLY,
    definePlainMessage("a"),
    { skipLower: true },
  ),
  // --- a two-way binding on a const -------------------------------------
  row(
    "a two-way binding on a const",
    "<const/x=1/>\n<input value:=x/>\n",
    "x",
    READONLY,
    constMessage("x"),
    { within: "value:=x" },
  ),
  row(
    "a refined two-way binding on a const",
    "<const/x=1/>\n<input value:x:=x/>\n",
    "x",
    READONLY,
    constMessage("x"),
    { within: ":=x" },
  ),
  row(
    "a function refinement bound to a const",
    "<const/x=1/>\n<div v:fn:=x/>\n",
    "x",
    READONLY,
    constMessage("x"),
    { within: "v:fn:=x" },
  ),
  // --- a <const> above its declaration ----------------------------------
  row(
    "const written in render above its declaration",
    "${x = 2}\n<const/x=1/>\n",
    "x = 2",
    CONST_BELOW,
    constBelowMessage("x"),
  ),
  row(
    "const written in a handler above its declaration",
    "<button onClick() { x = 2 }/>\n<const/x=1/>\n",
    "x = 2",
    CONST_BELOW,
    constBelowMessage("x"),
  ),
  row(
    "const written in a script above its declaration",
    "<script>x = 1</script>\n<const/x=1/>\n",
    "x = 1",
    CONST_BELOW,
    constBelowMessage("x"),
  ),
  row(
    "const written in an attribute above its declaration",
    "<div>\n  <p class=(x = 1)/>\n</div>\n<const/x=1/>\n",
    "x = 1",
    CONST_BELOW,
    constBelowMessage("x"),
  ),
  row(
    "a write between a const above and a const below sees the one above",
    "<const/x=1/>\n<button onClick() { x = 2 }/>\n<const/x=3/>\n",
    "x = 2",
    READONLY,
    constMessage("x"),
  ),
  // --- a <let> above its declaration -------------------------------------
  row(
    "let written in render above its declaration",
    "${count = 1}\n<let/count=0/>\n",
    "count = 1",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let updated in render above its declaration",
    "<p>${count++}</p>\n<let/count=0/>\n",
    "count++",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let written in a handler above its declaration",
    "<button onClick() { count = 1 }/>\n<let/count=0/>\n",
    "count = 1",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let written in a script above its declaration",
    "<script>count = 1</script>\n<let/count=0/>\n",
    "count = 1",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let written in a handler inside a block above its declaration",
    "<if=ok>\n  <button onClick() { count = 1 }/>\n</if>\n<let/count=0/>\n",
    "count = 1",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let written in an element above its declaration",
    "<div>\n  <p class=(count = 1)/>\n</div>\n<let/count=0/>\n",
    "count = 1",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let written in a for body above its declaration",
    "<for|x| of=xs>\n  <button onClick() { count = x }/>\n</for>\n<let/count=0/>\n",
    "count = x",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let written in a script, two blocks deep, above its declaration",
    "<if=a>\n  <if=b>\n    <script>count += 1</script>\n  </if>\n</if>\n<let/count=0/>\n",
    "count += 1",
    BELOW,
    belowMessage("count"),
  ),
  row(
    "let written above the second of two declarations",
    "<let/a=0/>\n<button onClick() { b = 1 }/>\n<let/b=0/>\n",
    "b = 1",
    BELOW,
    belowMessage("b"),
  ),
  row(
    "let written by a destructuring above its declaration",
    "<button onClick() { [count] = [1] }/>\n<let/count=0/>\n",
    "[count] = [1]",
    BELOW,
    belowMessage("count"),
  ),
  // --- a <let> as the left side of a for…of / for…in ---------------------
  row(
    "let as the left side of a for…of in a handler",
    `${LET}<button onClick() { for (count of [1, 2]) {} }/>\n`,
    "count",
    LOOP,
    loopMessage("count", "of"),
    { within: "for (count of" },
  ),
  row(
    "let as the left side of a for…in in a handler",
    `${LET}<button onClick() { for (count in { a: 1 }) {} }/>\n`,
    "count",
    LOOP,
    loopMessage("count", "in"),
    { within: "for (count in" },
  ),
  row(
    "let as the left side of a for…of in render",
    `${LET}<p>\${(() => { for (count of [1]) {} })()}</p>\n`,
    "count",
    LOOP,
    loopMessage("count", "of"),
    { within: "for (count of" },
  ),
  row(
    "let as the left side of a for…of in a script",
    `${LET}<script>for (count of [1, 2]) {}</script>\n`,
    "count",
    LOOP,
    loopMessage("count", "of"),
    { within: "for (count of" },
  ),
  row(
    "let as the left side of a for…of in an arrow handler",
    `${LET}<button onClick=() => { for (count of xs) {} }/>\n`,
    "count",
    LOOP,
    loopMessage("count", "of"),
    { within: "for (count of" },
  ),
  row(
    "let as the left side of a for…of in a block below its declaration",
    `${LET}<if=ok>\n  <button onClick() { for (count of xs) {} }/>\n</if>\n`,
    "count",
    LOOP,
    loopMessage("count", "of"),
    { within: "for (count of" },
  ),
];

describe("a write core used to take silently is one error", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-binding-write-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(REFUSED)("compileSource: $name", (r) => {
    const error = attempt(r.source);
    const at = span(r.source, r.write, r.within);
    expect(error?.message).toBe(r.message);
    expect(error?.diagnosticCode).toBe(r.code);
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
    expect(error?.end).toEqual(at.end);
    expect(error?.fixes).toBeUndefined();
  });

  it.each(REFUSED.filter((r) => !r.skipLower))("lowerSource: $name", (r) => {
    // `lowerSource` refuses the tag variable of a `<let>` outright; the write
    // is reported first, and only it carries the code under test.
    const { diagnostics } = lowerSource(r.source, join(dir, "page.mx"), {
      tagRules: "html",
    });
    const found = diagnostics.filter((d) => d.code === r.code);
    const at = span(r.source, r.write, r.within);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "error",
      message: r.message,
      line: at.start.line,
      column: at.start.column,
      end: at.end,
    });
  });

  it("says no decision number, and no Marko link", () => {
    for (const r of REFUSED) {
      expect(r.message).not.toMatch(/decision|marko|https?:/i);
    }
  });
});

/** Sources that compile: the stock Marko controls and every shadow form. */
const COMPILES: [name: string, source: string][] = [
  // --- stock Marko compiles these (controls) -----------------------------
  [
    "a destructured define parameter written in a handler",
    "<define/D|{ a }|>\n  <button onClick() { a = 2 }/>\n</define>\n<D a=1/>\n",
  ],
  [
    "a destructured define parameter written in a script",
    "<define/D|{ a }|>\n  <script>a = 2</script>\n</define>\n<D a=1/>\n",
  ],
  [
    "a name from a const's object pattern, written in a handler",
    "<const/{ a, b }=o/>\n<button onClick() { a = 2 }/>\n",
  ],
  [
    "a name from a const's object pattern, written in a script",
    "<const/{ a }=o/>\n<script>a = 2</script>\n",
  ],
  [
    "a name from a for parameter's object pattern, written in a handler",
    "<for|{ a }| of=xs>\n  <button onClick() { a = 2 }/>\n</for>\n",
  ],
  [
    "a renamed name from a for parameter's object pattern, in a handler",
    "<for|{ a: b }| of=xs>\n  <button onClick() { b = 2 }/>\n</for>\n",
  ],
  [
    "a member of a const written in a handler",
    "<const/o={}/>\n<button onClick() { o.a = 2 }/>\n",
  ],
  [
    "a member of a for parameter written in a handler",
    "<for|item| of=xs>\n  <button onClick() { item.done = true }/>\n</for>\n",
  ],
  [
    "a member of a const written in render",
    "<const/o={}/>\n<p>${o.a = 2}</p>\n",
  ],
  ["a read above a const declaration", "${x}\n<const/x=1/>\n"],
  [
    "a const initializer reading a name a later const declares",
    "<const/y=x+1/>\n<const/x=1/>\n",
  ],
  [
    "a let initializer reading a name a later const declares",
    "<let/y=x+1/>\n<const/x=1/>\n",
  ],
  [
    "a two-way binding on a name from a const's object pattern",
    "<const/{ a, b }={a:1,b:2}/>\n<input value:=a/>\n",
  ],
  [
    "a two-way binding on a member of a const",
    "<const/x={y:1}/>\n<input value:=x.y/>\n",
  ],
  ["a two-way binding on a let", "<let/x=1/>\n<input value:=x/>\n"],
  [
    "a let written in a handler below its declaration",
    `${LET}<button onClick() { count = 1 }/>\n`,
  ],
  [
    "a let written in a script below its declaration",
    `${LET}<script>count = 1</script>\n`,
  ],
  [
    "a let written by a destructuring in a handler",
    `${LET}<button onClick() { [count] = [1] }/>\n`,
  ],
  [
    "a let in a sibling block written from another block (compiles in Marko)",
    "<div>\n  <let/c=0/>\n</div>\n<div>\n  <button onClick() { c = 1 }/>\n</div>\n",
  ],
  [
    "a let in a sibling if branch written from the other branch",
    "<if=a>\n  <let/c=0/>\n</if>\n<else>\n  <button onClick() { c = 1 }/>\n</else>\n",
  ],
  // --- a declaration the write sits below -------------------------------
  [
    "two lets, each written below its own declaration",
    "<let/a=0/>\n<button onClick() { a = 1 }/>\n<let/b=0/>\n<button onClick() { a = 1; b = 2 }/>\n",
  ],
  [
    "a let declared in a block, written in that block below it",
    "<if=ok>\n  <let/c=0/>\n  <button onClick() { c = 1 }/>\n</if>\n",
  ],
  [
    "a let declared above and a block that ends before the next declaration",
    "<let/a=0/>\n<if=ok>\n  <button onClick() { a = 1 }/>\n</if>\n<let/b=0/>\n",
  ],
  // --- shadowing a <const> or <for> parameter inside the expression ------
  [
    "a handler parameter shadows a const",
    "<const/x=1/>\n<button onClick(x) { x = 2 }/>\n",
  ],
  [
    "an arrow parameter shadows a const",
    "<const/x=1/>\n<button onClick=(x) => { x = 2 }/>\n",
  ],
  [
    "a destructured handler parameter shadows a const",
    "<const/x=1/>\n<button onClick({ x }) { x = 2 }/>\n",
  ],
  [
    "a local let shadows a const",
    "<const/x=1/>\n<button onClick() { let x = 0; x = 2 }/>\n",
  ],
  [
    "a local const shadows a for parameter, and its own write is its business",
    "<for|item| of=xs>\n  <button onClick() { var item = 0; item = 2 }/>\n</for>\n",
  ],
  [
    "a hoisted var shadows a const",
    "<const/x=1/>\n<button onClick() { x = 2; var x }/>\n",
  ],
  [
    "a catch parameter shadows a const",
    "<const/x=1/>\n<button onClick() { try {} catch (x) { x = 2 } }/>\n",
  ],
  [
    "a function declaration's own name shadows a const",
    "<const/x=1/>\n<button onClick() { function x() { x = 2 } }/>\n",
  ],
  [
    "a function expression's own name shadows a const",
    "<const/x=1/>\n<button onClick=function x() { x = 2 }/>\n",
  ],
  [
    "a declaring for…of loop does not write a const",
    "<const/x=1/>\n<button onClick() { for (const x of xs) { x } }/>\n",
  ],
  [
    "a declaring for…in loop does not write a for parameter",
    "<for|item| of=xs>\n  <button onClick() { for (let item in o) { item } }/>\n</for>\n",
  ],
  [
    "a script local shadows a const",
    "<const/x=1/>\n<script>let x = 0; x = 2</script>\n",
  ],
  [
    "a script function parameter shadows a for parameter",
    "<for|item| of=xs>\n  <script>const bump = (item) => { item = 2 }</script>\n</for>\n",
  ],
  [
    "a handler parameter shadows a let declared below",
    "<button onClick(count) { count = 1 }/>\n<let/count=0/>\n",
  ],
  [
    "a local shadows a let declared below",
    "<script>let count = 0; count = 1</script>\n<let/count=0/>\n",
  ],
  [
    "a handler parameter shadows a let in a for…of head",
    `${LET}<button onClick(count) { for (count of [1]) {} }/>\n`,
  ],
  [
    "a declaring for…of loop does not assign a let",
    `${LET}<button onClick() { for (const count of xs) { count } }/>\n`,
  ],
  [
    "a declaring for…in loop in render does not assign a let",
    `${LET}<p>\${(() => { for (let count in o) {} })()}</p>\n`,
  ],
  // --- shadowing by the template's own scopes ----------------------------
  [
    "a for parameter shadows a const of the same name",
    "<const/x=1/>\n<for|x| of=xs>\n  <p>${x}</p>\n</for>\n<button onClick() { x }/>\n",
  ],
  [
    "a for parameter shadows a let declared below",
    "<for|count| of=xs>\n  <p>${count}</p>\n</for>\n<let/count=0/>\n",
  ],
  [
    "a define parameter shadows a let declared below",
    "<define/D|{ count }|>\n  <button onClick() { count = 1 }/>\n</define>\n<let/count=0/>\n<D count=1/>\n",
  ],
  [
    "a define parameter shadows a for parameter",
    "<for|item| of=xs>\n  <define/D|{ item }|>\n    <button onClick() { item = 2 }/>\n  </define>\n  <D item=1/>\n</for>\n",
  ],
  [
    "a for parameter shadows a define parameter in render",
    "<define/D|a|>\n  <for|a| of=xs>\n    <button onClick=() => { a }/>\n  </for>\n</define>\n<D a=1/>\n",
  ],
  [
    "a for parameter shadows a let written in render in its body",
    `${LET}<for|count| of=xs>\n  <button onClick() { count }/>\n</for>\n`,
  ],
  [
    "a let in a block, written in a handler after a same-named const left its block",
    "<if=ok>\n  <const/x=1/>\n</if>\n<let/x=0/>\n<button onClick() { x = 2 }/>\n",
  ],
];

describe("what must keep compiling", () => {
  it.each(COMPILES)("%s", (_name, source) => {
    expect(attempt(source)).toBeUndefined();
  });

  it("the `<let>` render write keeps its own code", () => {
    const error = attempt(`${LET}<p>\${count++}</p>\n`);
    expect(error?.diagnosticCode).toBe("MX_LET_WRITE_IN_RENDER");
    expect(error?.message).toBe(letRenderMessage("count"));
  });

  it("a script that does not parse is refused as such, not skipped", () => {
    // Stock Marko 6.4.4 refuses it at Babel's error (1:13).
    expect(attempt("<const/x=1/>\n<script>x = = 2</script>\n")).toMatchObject({
      diagnosticCode: "MX_INVALID_STATEMENT",
      message: "Unexpected token",
    });
  });

  it("a `<script>` split by a placeholder is refused for the placeholder, not the write", () => {
    const error = attempt("<const/x=1/>\n<script>x = ${1}</script>\n");
    expect(error?.diagnosticCode).toBe("MX_INERT_TAG_SHAPE");
    expect(error?.message).toMatch(/placeholder/);
  });
});

describe("scope of the names", () => {
  it("a const stops being guarded when its block ends", () => {
    const source =
      "<if=ok>\n  <const/x=1/>\n</if>\n<else>\n  <p>${x = 2}</p>\n</else>\n";
    expect(attempt(source)).toBeUndefined();
  });

  it("a for parameter stops being guarded after the loop", () => {
    const source =
      "<for|item| of=xs>\n  <p>${item}</p>\n</for>\n<button onClick() { item = 1 }/>\n";
    expect(attempt(source)).toBeUndefined();
  });

  it("a define parameter stops being guarded after the define", () => {
    const source =
      "<define/D|a|>\n  <p>${a}</p>\n</define>\n<D a=1/>\n<p>${a = 1}</p>\n";
    expect(attempt(source)).toBeUndefined();
  });

  it("a let declared below stops being 'below' once declared", () => {
    const source = "<let/count=0/>\n<button onClick() { count = 1 }/>\n";
    expect(attempt(source)).toBeUndefined();
  });

  it("a let declared in an inner block is not 'below' an outer write", () => {
    const source =
      "<button onClick() { count = 1 }/>\n<if=ok>\n  <let/count=0/>\n</if>\n";
    expect(attempt(source)).toBeUndefined();
  });

  it("the write above the declaration is reported once, at the first", () => {
    const source =
      "<button onClick() { count = 1 }/>\n<button onClick() { count = 2 }/>\n<let/count=0/>\n";
    const error = attempt(source);
    const at = span(source, "count = 1");
    expect(error?.diagnosticCode).toBe(BELOW);
    expect([error?.line, error?.column]).toEqual([
      at.start.line,
      at.start.column,
    ]);
  });

  it("a const redeclared in an inner block guards the inner one", () => {
    const source =
      "<const/x=1/>\n<if=ok>\n  <const/x=2/>\n  <button onClick() { x = 3 }/>\n</if>\n";
    const error = attempt(source);
    expect(error?.diagnosticCode).toBe(READONLY);
  });
});

/** A host with a delegated `<widget>`, so attribute tags and block params are reachable. */
const withWidget: HostDeclarations = {
  ...withLet,
  isDelegatedTag: (name) => name === "let" || name === "widget",
};

function attemptWidget(source: string): TranslateError | undefined {
  try {
    compileSource(source, "/page.mx", withWidget, {
      targets: lookup,
      emitIr: () => "",
    } as never);
  } catch (error) {
    return error as TranslateError;
  }
  return undefined;
}

describe("scopes the lowerer opens for the template", () => {
  it("a `<for>` around attribute tags guards its parameter in render", () => {
    const source =
      "<widget>\n  <for|item| of=xs>\n    <@item value=(item = 1)/>\n  </for>\n</widget>\n";
    const error = attemptWidget(source);
    expect(error?.diagnosticCode).toBe(READONLY);
    expect(error?.message).toBe(forMessage("item"));
  });

  it("a `<for>` around attribute tags guards its parameter in a handler", () => {
    const source =
      "<widget>\n  <for|item| of=xs>\n    <@item onClick() { item = 1 }/>\n  </for>\n</widget>\n";
    const error = attemptWidget(source);
    expect(error?.diagnosticCode).toBe(READONLY);
    expect(error?.message).toBe(forMessage("item"));
  });

  it("a `<let>` below an enclosing block still counts inside a block with its own `<let>`", () => {
    const source =
      "<div>\n  <let/inner=0/>\n  <button onClick() { outer = 1 }/>\n</div>\n<let/outer=0/>\n";
    const error = attempt(source);
    expect(error?.diagnosticCode).toBe(BELOW);
    expect(error?.message).toBe(belowMessage("outer"));
  });

  it("a block parameter shadows a `<let>` declared below", () => {
    const source =
      "<widget>\n  <@footer|count|>\n    <button onClick() { count = 1 }/>\n  </@footer>\n</widget>\n<let/count=0/>\n";
    expect(attemptWidget(source)).toBeUndefined();
  });

  it("a block parameter shadows a `<const>` of the same spelling", () => {
    const source =
      "<const/year=1/>\n<widget>\n  <@footer|year|>\n    <button onClick() { year = 2 }/>\n  </@footer>\n</widget>\n";
    expect(attemptWidget(source)).toBeUndefined();
  });
});
