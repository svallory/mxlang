import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTemplate } from "@angular/compiler";
import { compile, compileTagModuleFile } from "@mxlang/angular";
import { getCustomTags, type MxWarning } from "@mxlang/core";

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

const MIN_FIXTURES = 67;

type Verdict = "pass" | "fail";

interface Row {
  fixture: string;
  kind: "pass" | "error" | "tag";
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

/** The `template: "…"` string of an emitted component module, unescaped. */
function templateOf(code: string): string | null {
  const match = code.match(/^ {2}template: (".*"),$/m);
  return match ? (JSON.parse(match[1] as string) as string) : null;
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
  for (const dir of dirs) {
    const hasInput = existsSync(join(fixturesRoot, dir, "input.mx"));
    const hasExpected = existsSync(join(fixturesRoot, dir, "expected.html"));
    const hasError = existsSync(join(fixturesRoot, dir, "expected.error.txt"));
    // A tag fixture's expected output is a component *module*, not a
    // template, so it is a third kind rather than a variant of `pass`
    // (A3's two output kinds: a `.mx` compiles to one of two very different
    // artifacts on this host).
    const hasTag = existsSync(join(fixturesRoot, dir, "expected.ts"));
    const kinds = [hasExpected, hasError, hasTag].filter(Boolean).length;
    if (!hasInput || kinds !== 1) {
      throw new Error(
        `fixture "${dir}" must have input.mx and exactly one of expected.html / expected.error.txt / expected.ts`,
      );
    }
    if (hasExpected) passFixtures.push(dir);
    else if (hasTag) tagFixtures.push(dir);
    else errorFixtures.push(dir);
  }

  if (
    passFixtures.length === 0 &&
    errorFixtures.length === 0 &&
    tagFixtures.length === 0
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
