import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTemplate } from "@angular/compiler";
import { compile } from "@mxlang/angular";
import type { MxWarning } from "@mxlang/core";

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

const MIN_FIXTURES = 59;

type Verdict = "pass" | "fail";

interface Row {
  fixture: string;
  kind: "pass" | "error";
  verdict: Verdict;
  detail?: string;
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
  for (const dir of dirs) {
    const hasInput = existsSync(join(fixturesRoot, dir, "input.mx"));
    const hasExpected = existsSync(join(fixturesRoot, dir, "expected.html"));
    const hasError = existsSync(join(fixturesRoot, dir, "expected.error.txt"));
    if (!hasInput || (hasExpected && hasError) || (!hasExpected && !hasError)) {
      throw new Error(
        `fixture "${dir}" must have input.mx and exactly one of expected.html / expected.error.txt`,
      );
    }
    if (hasExpected) passFixtures.push(dir);
    else errorFixtures.push(dir);
  }

  if (passFixtures.length === 0 && errorFixtures.length === 0) {
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

    let code: string;
    const warnings: MxWarning[] = [];
    try {
      code = compile(input, FIXTURE_FILENAME, { warnings }).code;
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

    const actualWarnings = warnings.map((w) => w.message);
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
