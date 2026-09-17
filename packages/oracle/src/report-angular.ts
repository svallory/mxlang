import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTemplate } from "@angular/compiler";
import { compile, compileNgMx, compileTagModuleFile } from "@mxlang/angular";
import { getCustomTags, type MxWarning } from "@mxlang/core";
import ts from "typescript";

/**
 * `oracle:angular`'s one table (design note A6): every fixture under
 * `packages/oracle/fixtures/angular/<name>/` compiles through
 * `@mxlang/angular`'s emitter, then the emitted template is checked two
 * ways against Angular's own compiler — `parseTemplate(...).errors === null`
 * and a span-stripped AST snapshot, both against `@angular/compiler@22.1.7`.
 *
 * A fixture is either a **pass** fixture (`expected.html`, byte-compared to
 * the emitted template) or an **error** fixture (`expected.error.txt`,
 * matched exactly against the `TranslateError` message A2 pins, once the
 * absolute-path prefix `compile()` prepends is stripped) — never both. A
 * pass fixture whose A1 row is a **W**arning also carries
 * `expected.warnings.txt` (one warning per line, in emission order,
 * byte-compared); a pass fixture with no such file asserts zero warnings.
 * `input.json` is unused here (the emitter has no runtime input), listed in
 * the design note only for hosts that need one.
 */

/**
 * `@marko/compiler`'s `compileSync` resolves the filename it is given and
 * prepends it to every thrown message as `"<absolute path>: "` — measured
 * directly: `compile("<try>x</try>", "x.mx")` throws
 * `"/…/x.mx: \`<try>\` cannot be emitted…"`, so the prefix is real, not
 * inert. Matched by shape (an absolute path ending in the exact fixture
 * filename, then `": "`) rather than by recomputing `resolve(cwd, ...)`
 * ourselves, so this stays correct however this script's cwd differs from
 * the compiler's own resolution.
 */
const FIXTURE_FILENAME = "x.mx";
const ERROR_PREFIX_PATTERN = new RegExp(`^\\S*${FIXTURE_FILENAME}: `);
// A tag fixture stages under its own basename (`${tagName}.mx`, not
// `x.mx` — see `stageTag`'s own comment on why), so its thrown message
// carries a different filename in the same position. Matched generically
// by shape rather than a second fixed name.
const ANY_MX_PATH_PREFIX_PATTERN = /^\S*\.mx: /;

function stripAnyPathPrefix(message: string): string {
  return message.replace(ANY_MX_PATH_PREFIX_PATTERN, "");
}

function stripPathPrefix(message: string): string {
  return message.replace(ERROR_PREFIX_PATTERN, "");
}

// Every span-bearing key `@angular/compiler@22.1.7`'s `parseTemplate` emits,
// matched exactly (case-sensitive, no substring/prefix matching) — the
// prior case-insensitive substring regex matched `references` (a real
// semantic field: `<ng-template #Empty>`'s template reference variable
// name) and stripped it, which made `define-no-params`'s golden identical
// whether the source read `#Empty`, `#TOTALLY_WRONG`, or no reference at
// all. `location`/`source`/`errors` are dropped too: derived text/position
// data (`"x.html@0:14"`, the raw expression source slice, and an
// always-`[]` post-`parseTemplate` array respectively), not structure.
// Enumerated by walking parseTemplate's own output for every construct this
// emitter produces (bindings, events, two-way, @if/@for/@let, references,
// ng-template, ng-content) rather than guessed.
const SPAN_KEY = new Set([
  "span",
  "sourceSpan",
  "startSourceSpan",
  "endSourceSpan",
  "nameSpan",
  "keySpan",
  "valueSpan",
  "handlerSpan",
  "argumentSpan",
  "mainBlockSpan",
  "trackKeywordSpan",
  "i18n",
  "location",
  "source",
  "errors",
]);

function angularAstSnapshot(template: string): unknown {
  const result = parseTemplate(template, "x.html");
  return JSON.parse(
    JSON.stringify(result.nodes, (key, value) =>
      SPAN_KEY.has(key) ? undefined : value,
    ),
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "fixtures", "angular");
const goldenDir = join(fixturesRoot, "__golden__");

const MIN_FIXTURES = 88;

type Verdict = "pass" | "fail";

interface Row {
  fixture: string;
  kind: "pass" | "error" | "tag" | "ngmx";
  verdict: Verdict;
  detail?: string;
}

/**
 * Copies a fixture's `tags/` directory into a temp directory and writes its
 * template there as `FIXTURE_FILENAME`, returning that path.
 *
 * Lets a fixture exercise real tag discovery (which walks upward from the
 * compiled file) while every emitted name the goldens pin stays derived from
 * `x.mx`, not from wherever this repository happens to be checked out.
 */
function stageWithTags(fixtureDir: string, source: string): string {
  const staged = mkdtempSync(join(tmpdir(), "mx-angular-fixture-"));
  cpSync(join(fixtureDir, "tags"), join(staged, "tags"), { recursive: true });
  // A package boundary stops the upward scan at the staged directory, so a
  // `tags/` directory above the temp dir can never leak into a fixture.
  writeFileSync(join(staged, "package.json"), JSON.stringify({ name: "f" }));
  const path = join(staged, FIXTURE_FILENAME);
  writeFileSync(path, source);
  return path;
}

/**
 * Rewrites the staged temp directory out of a warning message.
 *
 * The import warning names the TypeScript file the author must edit, echoing
 * whatever filename it was compiled under (`x.mx` -> `x.ts`) — correct
 * behavior, but a staged fixture's path is this machine's temp directory, so
 * the golden would never match on another checkout. Reduced to the bare
 * filename the non-staged fixtures already produce.
 */
function stripStagedDir(message: string, stagedPath: string): string {
  return message.replaceAll(`${dirname(stagedPath)}/`, "");
}

/**
 * Copies a tag fixture into a temp directory under `filename`, plus any
 * `tags/` directory it has, and returns the staged path.
 */
function stageTag(fixtureDir: string, filename: string): string {
  const staged = mkdtempSync(join(tmpdir(), "mx-angular-tagfix-"));
  if (existsSync(join(fixtureDir, "tags"))) {
    cpSync(join(fixtureDir, "tags"), join(staged, "tags"), { recursive: true });
  }
  writeFileSync(join(staged, "package.json"), JSON.stringify({ name: "f" }));
  const path = join(staged, filename);
  writeFileSync(path, readFileSync(join(fixtureDir, "input.mx"), "utf8"));
  return path;
}

/**
 * Copies a `.ng.mx` fixture and its `tags/` directory into a temp directory
 * with a `package.json` boundary, and returns the staged path.
 *
 * The boundary is what stops the upward tag scan at the fixture: without it
 * a fixture would discover this repository's own `tags/` directories.
 */
function stageNgMx(fixtureDir: string): string {
  const staged = mkdtempSync(join(tmpdir(), "mx-angular-ngmxfix-"));
  cpSync(join(fixtureDir, "tags"), join(staged, "tags"), { recursive: true });
  writeFileSync(join(staged, "package.json"), JSON.stringify({ name: "f" }));
  const path = join(staged, "input.ng.mx");
  writeFileSync(path, readFileSync(join(fixtureDir, "input.ng.mx"), "utf8"));
  return path;
}

/** The `template: "…"` string of an emitted component module, unescaped. */
function templateOf(code: string): string | null {
  const quoted = code.match(/^ {2}template: (".*"),$/m);
  if (quoted) return JSON.parse(quoted[1] as string) as string;
  // A `.ng.mx` module emits a **backtick** template literal rather than a
  // double-quoted string (decision 99), so the two module kinds need two
  // patterns. Unescaping is the inverse of `escapeTemplateLiteral`'s three
  // substitutions, and `\\` must come last or it would consume the
  // backslashes the other two just removed.
  const backticked = code.match(/^ {2}template: `([\s\S]*?)`,$/m);
  if (!backticked) return null;
  return (backticked[1] as string)
    .replace(/\\`/g, "`")
    .replace(/\\\$\{/g, "${")
    .replace(/\\\\/g, "\\");
}

/**
 * Typechecks an emitted tag component module for real, with
 * `ts.createProgram` and `@angular/core` on the type path — `parseTemplate`
 * alone only proves the `template:` string is syntax Angular accepts, and
 * never sees the surrounding module. This is exactly the bug class the
 * `Input`/`export interface Input` collision was (`TS2440`): every existing
 * gate here passed while a real `ng build` failed on every tag declaring at
 * least one input. Returns the formatted diagnostics, or `null` when clean.
 */
function typecheckTagModule(
  code: string,
  /**
   * Modules the checked code imports, as `relative path -> source`. A
   * `.ng.mx` that calls a discovered tag imports that tag's *emitted*
   * module, so the sibling has to exist or `tsc` reports TS2307 for code
   * that is in fact correct. Writing the real compiled tag beside it also
   * checks the two halves agree about the class name and path.
   */
  siblings: Record<string, string> = {},
): string | null {
  const dir = mkdtempSync(join(here, ".typecheck-tmp-"));
  try {
    const filePath = join(dir, "tag.ts");
    writeFileSync(filePath, code);
    for (const [relative, source] of Object.entries(siblings)) {
      const target = join(dir, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }

    const program = ts.createProgram([filePath], {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      experimentalDecorators: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length === 0) return null;
    return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => dir,
      getNewLine: () => "\n",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runAngularTable(update: boolean): {
  rows: Row[];
  failed: boolean;
} {
  if (!existsSync(fixturesRoot)) {
    console.error(`oracle:angular: fixtures root not found: ${fixturesRoot}`);
    return { rows: [], failed: true };
  }

  // Not `discoverFixtures` (C2): that helper pairs one input with one
  // expected file across the whole root and throws on a half pair, but this
  // root deliberately holds two disjoint fixture kinds side by side — a
  // pass fixture has `expected.html` and no `expected.error.txt`, an error
  // fixture the reverse. Classify directly instead of forcing the mixed set
  // through a single-pair contract it was not built for.
  const dirs = readdirSync(fixturesRoot)
    .filter((entry) => statSync(join(fixturesRoot, entry)).isDirectory())
    .filter((entry) => entry !== "__golden__")
    .sort();

  const passFixtures: string[] = [];
  const errorFixtures: string[] = [];
  const tagFixtures: string[] = [];
  const tagErrorFixtures: string[] = [];
  const ngMxFixtures: string[] = [];
  const ngMxErrorFixtures: string[] = [];
  for (const dir of dirs) {
    // A `.ng.mx` fixture is a whole TypeScript module, not a template, so
    // its input is `input.ng.mx` and it never goes through `compile()`.
    // Its own extension is the discriminator — no name-prefix convention
    // needed, unlike a tag fixture's `tag-`.
    if (existsSync(join(fixturesRoot, dir, "input.ng.mx"))) {
      if (existsSync(join(fixturesRoot, dir, "expected.error.txt"))) {
        ngMxErrorFixtures.push(dir);
      } else if (existsSync(join(fixturesRoot, dir, "expected.ts"))) {
        ngMxFixtures.push(dir);
      } else {
        throw new Error(
          `fixture "${dir}" has input.ng.mx and must have expected.ts or expected.error.txt`,
        );
      }
      continue;
    }
    const hasInput = existsSync(join(fixturesRoot, dir, "input.mx"));
    const hasExpected = existsSync(join(fixturesRoot, dir, "expected.html"));
    const hasError = existsSync(join(fixturesRoot, dir, "expected.error.txt"));
    // A tag fixture's expected output is a component *module*, not a
    // template, so it is a third kind rather than a variant of `pass`
    // (A3's two output kinds: a `.mx` compiles to one of two very different
    // artifacts on this host).
    const hasTag = existsSync(join(fixturesRoot, dir, "expected.ts"));
    // A tag fixture whose own compile is expected to *throw* has neither
    // `expected.ts` nor `expected.html` — only `expected.error.txt`, plus a
    // `tags/` marker (its own `tag-` name prefix) distinguishing it from an
    // ordinary page-level error fixture, which compiles through `compile()`
    // rather than `compileTagModuleFile`.
    const hasTagError = hasError && dir.startsWith("tag-");
    const kinds = [hasExpected, hasError && !hasTagError, hasTag].filter(
      Boolean,
    ).length;
    if (!hasInput || (kinds !== 1 && !hasTagError)) {
      throw new Error(
        `fixture "${dir}" must have input.mx and exactly one of expected.html / expected.error.txt / expected.ts`,
      );
    }
    if (hasExpected) passFixtures.push(dir);
    else if (hasTagError) tagErrorFixtures.push(dir);
    else if (hasTag) tagFixtures.push(dir);
    else errorFixtures.push(dir);
  }

  if (
    passFixtures.length === 0 &&
    errorFixtures.length === 0 &&
    tagFixtures.length === 0 &&
    tagErrorFixtures.length === 0 &&
    ngMxFixtures.length === 0 &&
    ngMxErrorFixtures.length === 0
  ) {
    console.error(
      `oracle:angular: fixture glob expanded to nothing under ${fixturesRoot}`,
    );
    return { rows: [], failed: true };
  }

  const rows: Row[] = [];
  let failed = false;

  for (const name of passFixtures) {
    const dir = join(fixturesRoot, name);
    const input = readFileSync(join(dir, "input.mx"), "utf8");
    const expected = readFileSync(join(dir, "expected.html"), "utf8");
    const warningsPath = join(dir, "expected.warnings.txt");
    const expectedWarnings = existsSync(warningsPath)
      ? readFileSync(warningsPath, "utf8").split("\n").filter(Boolean)
      : [];

    // A fixture with its own `tags/` directory exercises the discovered-tag
    // call site. Tag discovery walks upward from the compiled file, so the
    // file must sit beside that directory on disk — but compiling at the
    // fixture's real path would bake this checkout's absolute path into the
    // emitted warning text, and every existing warning golden is written
    // against the bare `x.ts`. Staged into a temp directory as
    // `FIXTURE_FILENAME` instead, which satisfies both: discovery finds the
    // copied `tags/`, and every emitted name stays machine-independent.
    const hasTagsDir = existsSync(join(dir, "tags"));
    const compilePath = hasTagsDir
      ? stageWithTags(dir, input)
      : FIXTURE_FILENAME;

    let code: string;
    const warnings: MxWarning[] = [];
    try {
      code = compile(input, compilePath, {
        warnings,
        customTags: hasTagsDir
          ? (getCustomTags(compilePath, { host: "angular" }) as never)
          : undefined,
      }).code;
    } catch (err) {
      rows.push({
        fixture: name,
        kind: "pass",
        verdict: "fail",
        detail: `unexpected throw: ${stripPathPrefix((err as Error).message).slice(0, 80)}`,
      });
      failed = true;
      continue;
    }

    if (code !== expected) {
      rows.push({
        fixture: name,
        kind: "pass",
        verdict: "fail",
        detail: `emitted mismatch: got ${JSON.stringify(code)}`,
      });
      failed = true;
      continue;
    }

    const actualWarnings = warnings.map((w) =>
      hasTagsDir ? stripStagedDir(w.message, compilePath) : w.message,
    );
    if (
      actualWarnings.length !== expectedWarnings.length ||
      actualWarnings.some((w, i) => w !== expectedWarnings[i])
    ) {
      rows.push({
        fixture: name,
        kind: "pass",
        verdict: "fail",
        detail: `warnings mismatch: expected ${JSON.stringify(expectedWarnings)}, got ${JSON.stringify(actualWarnings)}`,
      });
      failed = true;
      continue;
    }

    const parsed = parseTemplate(code, `${name}.html`);
    if (parsed.errors) {
      rows.push({
        fixture: name,
        kind: "pass",
        verdict: "fail",
        detail: `angular parseTemplate reported errors: ${parsed.errors.map((e) => e.msg).join("; ")}`,
      });
      failed = true;
      continue;
    }

    const snapshot = angularAstSnapshot(code);
    const goldenPath = join(goldenDir, `${name}.ast.json`);
    const goldenText = `${JSON.stringify(snapshot, null, 2)}\n`;
    const goldenExisted = existsSync(goldenPath);
    if (!goldenExisted || update) {
      if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });
      writeFileSync(goldenPath, goldenText);
    }
    // A missing golden is a failure, not a silent first-write pass: writing
    // it above and then reading the just-written file back would always
    // compare equal to itself, so a fixture whose golden was never
    // committed — or was deleted — would report "pass" the first time it
    // runs and never again get the human review a real snapshot deserves.
    if (!goldenExisted && !update) {
      rows.push({
        fixture: name,
        kind: "pass",
        verdict: "fail",
        detail: `no AST golden at ${goldenPath} (run with --update to generate it, then review and commit it)`,
      });
      failed = true;
      continue;
    }
    const golden = readFileSync(goldenPath, "utf8");
    if (golden !== goldenText) {
      rows.push({
        fixture: name,
        kind: "pass",
        verdict: "fail",
        detail: "AST snapshot mismatch (run with --update to regenerate)",
      });
      failed = true;
      continue;
    }

    rows.push({ fixture: name, kind: "pass", verdict: "pass" });
  }

  for (const name of tagFixtures) {
    const dir = join(fixturesRoot, name);
    // Compiled at its real path, not under `FIXTURE_FILENAME`: a tag's
    // selector and class name are both derived from its *basename*, so
    // compiling `input.mx` as `x.mx` would assert the wrong names entirely.
    const expected = readFileSync(join(dir, "expected.ts"), "utf8");
    // Staged under the *tag's own* basename rather than compiled as
    // `input.mx`: a tag's selector and exported class are both derived from
    // its filename, so `input.mx` would name every fixture's component
    // `Input` — colliding with the `export interface Input` it also emits.
    // The name comes from the fixture directory with its `tag-` prefix
    // dropped, so `tag-named-slot/` compiles as `named-slot.mx`.
    const tagName = name.replace(/^tag-/, "");
    const inputPath = stageTag(dir, `${tagName}.mx`);

    let code: string;
    try {
      code = compileTagModuleFile(inputPath, {
        customTags: getCustomTags(inputPath, { host: "angular" }) as never,
      }).code;
    } catch (err) {
      rows.push({
        fixture: name,
        kind: "tag",
        verdict: "fail",
        detail: `unexpected throw: ${(err as Error).message.slice(0, 80)}`,
      });
      failed = true;
      continue;
    }

    if (code !== expected) {
      rows.push({
        fixture: name,
        kind: "tag",
        verdict: "fail",
        detail: "emitted module mismatch",
      });
      failed = true;
      continue;
    }

    // The module is TypeScript, which Angular's template parser cannot read,
    // so the template is extracted and checked on its own — the same
    // `parseTemplate` gate every pass fixture gets.
    const template = templateOf(code);
    if (template === null) {
      rows.push({
        fixture: name,
        kind: "tag",
        verdict: "fail",
        detail: "no template line found in the emitted module",
      });
      failed = true;
      continue;
    }
    const parsedTag = parseTemplate(template, `${name}.html`);
    if (parsedTag.errors) {
      rows.push({
        fixture: name,
        kind: "tag",
        verdict: "fail",
        detail: `angular parseTemplate reported errors: ${parsedTag.errors.map((e) => e.msg).join("; ")}`,
      });
      failed = true;
      continue;
    }

    // `parseTemplate` above only proves the extracted template string is
    // syntax Angular accepts — it never sees the surrounding module, so the
    // `Input`/`export interface Input` collision (TS2440) compiled clean
    // through every gate above until a real `ng build` hit it. This is the
    // real `tsc` pass that closes that gap.
    const typeErrors = typecheckTagModule(code);
    if (typeErrors !== null) {
      rows.push({
        fixture: name,
        kind: "tag",
        verdict: "fail",
        detail: `emitted module failed to typecheck:\n${typeErrors}`,
      });
      failed = true;
      continue;
    }

    rows.push({ fixture: name, kind: "tag", verdict: "pass" });
  }

  for (const name of errorFixtures) {
    const dir = join(fixturesRoot, name);
    const input = readFileSync(join(dir, "input.mx"), "utf8");
    const expectedMessage = readFileSync(
      join(dir, "expected.error.txt"),
      "utf8",
    ).trim();

    let thrown: string | null = null;
    try {
      compile(input, FIXTURE_FILENAME);
    } catch (err) {
      thrown = stripPathPrefix((err as Error).message);
    }

    if (thrown === null) {
      rows.push({
        fixture: name,
        kind: "error",
        verdict: "fail",
        detail: "expected a TranslateError, but compile() did not throw",
      });
      failed = true;
      continue;
    }

    if (thrown !== expectedMessage) {
      rows.push({
        fixture: name,
        kind: "error",
        verdict: "fail",
        detail: `expected error ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(thrown)}`,
      });
      failed = true;
      continue;
    }

    rows.push({ fixture: name, kind: "error", verdict: "pass" });
  }

  // A tag whose own compile must throw — unlike `errorFixtures` above,
  // compiled through `compileTagModuleFile` (a tag file is its own
  // compilation unit, task 1.7), not `compile()` against a page. A page
  // calling such a tag does not itself throw: the call site resolves
  // against the tag's *cached metadata* (`{ readsContent, attributeTags }`),
  // never the tag's own emitted host module, so this error is only
  // observable where `mx-angular build` actually compiles the tag file.
  for (const name of tagErrorFixtures) {
    const dir = join(fixturesRoot, name);
    const tagName = name.replace(/^tag-/, "");
    const expectedMessage = readFileSync(
      join(dir, "expected.error.txt"),
      "utf8",
    ).trim();
    const inputPath = stageTag(dir, `${tagName}.mx`);

    let thrown: string | null = null;
    try {
      compileTagModuleFile(inputPath, {
        customTags: getCustomTags(inputPath) as never,
      });
    } catch (err) {
      thrown = stripStagedDir(
        stripAnyPathPrefix((err as Error).message),
        inputPath,
      );
    }

    if (thrown === null) {
      rows.push({
        fixture: name,
        kind: "tag",
        verdict: "fail",
        detail:
          "expected a TranslateError, but compileTagModuleFile() did not throw",
      });
      failed = true;
      continue;
    }

    if (thrown !== expectedMessage) {
      rows.push({
        fixture: name,
        kind: "tag",
        verdict: "fail",
        detail: `expected error ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(thrown)}`,
      });
      failed = true;
      continue;
    }

    rows.push({ fixture: name, kind: "tag", verdict: "pass" });
  }

  for (const name of ngMxFixtures) {
    const dir = join(fixturesRoot, name);
    const expected = readFileSync(join(dir, "expected.ts"), "utf8");
    // Compiled under its own basename — unlike a tag, a `.ng.mx`'s class and
    // selector are written by the author in the file itself, so nothing is
    // derived from the filename. A fixture with its own `tags/` directory is
    // staged in a temp directory with a `package.json` boundary, because tag
    // discovery walks *upward* and would otherwise escape the fixture and
    // find this repository's own tags.
    const inputPath = existsSync(join(dir, "tags"))
      ? stageNgMx(dir)
      : join(dir, "input.ng.mx");

    let code: string;
    try {
      code = compileNgMx(readFileSync(inputPath, "utf8"), inputPath, {
        customTags: getCustomTags(inputPath, { host: "angular" }) as never,
      }).code;
    } catch (err) {
      rows.push({
        fixture: name,
        kind: "ngmx",
        verdict: "fail",
        detail: `unexpected throw: ${(err as Error).message.slice(0, 80)}`,
      });
      failed = true;
      continue;
    }

    if (code !== expected) {
      rows.push({
        fixture: name,
        kind: "ngmx",
        verdict: "fail",
        detail: "emitted module mismatch",
      });
      failed = true;
      continue;
    }

    // The emitted module is TypeScript, so the template is extracted and put
    // through Angular's own parser on its own — the same gate every pass and
    // tag fixture gets.
    const template = templateOf(code);
    if (template === null) {
      rows.push({
        fixture: name,
        kind: "ngmx",
        verdict: "fail",
        detail: "no template line found in the emitted module",
      });
      failed = true;
      continue;
    }
    const parsedNg = parseTemplate(template, `${name}.html`);
    if (parsedNg.errors) {
      rows.push({
        fixture: name,
        kind: "ngmx",
        verdict: "fail",
        detail: `angular parseTemplate reported errors: ${parsedNg.errors.map((e) => e.msg).join("; ")}`,
      });
      failed = true;
      continue;
    }

    // And the module itself through `tsc`, which is what catches a decorator
    // edit producing valid-looking text but invalid TypeScript. A fixture
    // whose template calls a discovered tag also needs that tag's *emitted*
    // module written beside it, or `tsc` reports TS2307 for an import that
    // is in fact correct — and compiling it here proves the two halves
    // agree on the class name and the path.
    const siblings: Record<string, string> = {};
    if (existsSync(join(dir, "tags"))) {
      for (const entry of readdirSync(join(dir, "tags"))) {
        if (!entry.endsWith(".mx")) continue;
        const tagPath = join(dirname(inputPath), "tags", entry);
        siblings[`tags/${entry.replace(/\.mx$/, ".ts")}`] =
          compileTagModuleFile(tagPath, {
            customTags: getCustomTags(tagPath, { host: "angular" }) as never,
          }).code;
      }
    }
    const typeErrors = typecheckTagModule(code, siblings);
    if (typeErrors !== null) {
      rows.push({
        fixture: name,
        kind: "ngmx",
        verdict: "fail",
        detail: `tsc reported errors: ${typeErrors}`,
      });
      failed = true;
      continue;
    }

    rows.push({ fixture: name, kind: "ngmx", verdict: "pass" });
  }

  for (const name of ngMxErrorFixtures) {
    const dir = join(fixturesRoot, name);
    const inputPath = join(dir, "input.ng.mx");
    const expectedMessage = readFileSync(
      join(dir, "expected.error.txt"),
      "utf8",
    ).trim();

    let thrown: string | null = null;
    try {
      compileNgMx(readFileSync(inputPath, "utf8"), inputPath, {
        customTags: getCustomTags(inputPath, { host: "angular" }) as never,
      });
    } catch (err) {
      thrown = stripPathPrefix((err as Error).message);
    }

    if (thrown === null) {
      rows.push({
        fixture: name,
        kind: "ngmx",
        verdict: "fail",
        detail: "expected a throw, but compileNgMx() did not throw",
      });
      failed = true;
      continue;
    }

    if (thrown !== expectedMessage) {
      rows.push({
        fixture: name,
        kind: "ngmx",
        verdict: "fail",
        detail: `expected error ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(thrown)}`,
      });
      failed = true;
      continue;
    }

    rows.push({ fixture: name, kind: "ngmx", verdict: "pass" });
  }

  const nameWidth = Math.max(8, ...rows.map((r) => r.fixture.length));
  console.log("");
  console.log("=== angular fixtures (@mxlang/angular) ===");
  console.log(`${"fixture".padEnd(nameWidth)}  kind    verdict`);
  for (const r of rows) {
    console.log(
      `${r.fixture.padEnd(nameWidth)}  ${r.kind.padEnd(6)}  ${r.verdict}${r.detail ? `  (${r.detail})` : ""}`,
    );
  }

  const passCount = rows.filter((r) => r.verdict === "pass").length;
  const failCount = rows.filter((r) => r.verdict === "fail").length;
  console.log("");
  console.log(
    `processed: ${rows.length} angular fixtures (minimum required: ${MIN_FIXTURES}) — ${passCount} pass, ${failCount} fail`,
  );

  if (rows.length < MIN_FIXTURES) {
    console.error(
      `oracle:angular: only ${rows.length} fixtures processed, below the required minimum of ${MIN_FIXTURES} — treating as a failed run, not a pass`,
    );
    failed = true;
  }

  return { rows, failed };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const { failed } = runAngularTable(update);
  process.exit(failed ? 1 : 0);
}
