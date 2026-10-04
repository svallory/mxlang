import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderStockMarko } from "./marko-compile-stock";
import { htmlEquals } from "./normalize-html";
import { renderTranslator } from "./translator-render";

/**
 * `oracle:marko`'s one table (decisions 66, 68): parity between Marko's own
 * toolchain and `@mxlang/html` for the stock `.marko` fixture set.
 *
 * There is no dialect to compare it against any more (decision 68 retired
 * `.mx` and `@mxlang/html`), so this asks a single, narrow question: for
 * templates an ordinary Marko user would write, does the expressions-only
 * translator emit what Marko's own server render emits? Every fixture is
 * expected to pass, and a skip needs a decision-65 reason — "this target
 * cannot", never "my code cannot".
 *
 * Same comparison as the first table: `htmlEquals` parses both sides with
 * parse5 and compares decoded content, and Marko's resume/hydration markers
 * are stripped (they have no expressions-only equivalent and their ids are
 * random per compile).
 *
 * Decision 55: the run fails if the glob expands to nothing, if a fixture is
 * missing one of its three files, or if fewer than MIN_FIXTURES were
 * processed — a gate must assert it did work, not merely that nothing failed.
 */

const MIN_FIXTURES = 42; // was 41; +1 for spread-between-props (round-3 code review, source-order prop/spread precedence)

interface FixtureMeta {
  /**
   * "skip" is never compiled. "divergence" is compiled and expected to
   * differ from `expected.html`. "error" is compiled and expected to throw
   * on *both* sides, matching `errorPattern` — this is decision 67's closed
   * class: a construct the translator now rejects the same way Marko does,
   * so `expected.html` plays no role and both throwing the same message is
   * itself the pass.
   */
  marko?: "skip" | "divergence" | "error";
  reason?: string;
  /** Required when `marko: "error"`: both sides' thrown message must match this. */
  errorPattern?: string;
}

type Verdict = "pass" | "translator bug" | "skipped (reason)";

interface Row {
  fixture: string;
  marko: string;
  translator: string;
  verdict: Verdict;
  detail?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(
  here,
  "..",
  "..",
  "targets",
  "html",
  "fixtures-marko",
);

export async function runStockTable(): Promise<{
  rows: Row[];
  failed: boolean;
}> {
  if (!existsSync(fixturesRoot)) {
    console.error(`oracle:marko: fixtures root not found: ${fixturesRoot}`);
    return { rows: [], failed: true };
  }

  const entries = readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    console.error(
      `oracle:marko: stock fixture glob expanded to nothing under ${fixturesRoot}`,
    );
    return { rows: [], failed: true };
  }

  let malformed = false;
  for (const name of entries) {
    const dir = join(fixturesRoot, name);
    for (const file of ["input.marko", "input.json", "expected.html"]) {
      if (!existsSync(join(dir, file))) {
        console.error(
          `oracle:marko: stock fixture "${name}" is missing ${file}`,
        );
        malformed = true;
      }
    }
  }
  if (malformed) return { rows: [], failed: true };

  const rows: Row[] = [];
  let unresolved = false;

  for (const name of entries) {
    const dir = join(fixturesRoot, name);
    const metaPath = join(dir, "meta.json");
    const meta: FixtureMeta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, "utf8")) as FixtureMeta)
      : {};

    if (meta.marko === "skip") {
      if (!meta.reason) {
        console.error(
          `oracle:marko: stock fixture "${name}" has marko:"skip" with no reason`,
        );
        malformed = true;
      }
      rows.push({
        fixture: name,
        marko: "skipped (reason)",
        translator: "skipped (reason)",
        verdict: "skipped (reason)",
        detail: meta.reason,
      });
      continue;
    }

    if (meta.marko === "error") {
      if (!meta.reason || !meta.errorPattern) {
        console.error(
          `oracle:marko: stock fixture "${name}" has marko:"error" with no reason/errorPattern`,
        );
        malformed = true;
        continue;
      }
      const pattern = new RegExp(meta.errorPattern);
      const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8"));

      let markoThrew: string | null = null;
      try {
        await renderStockMarko(dir, input);
      } catch (err) {
        markoThrew = (err as Error).message;
      }
      let translatorThrew: string | null = null;
      try {
        await renderTranslator(dir, join(dir, "input.marko"), input);
      } catch (err) {
        translatorThrew = (err as Error).message;
      }

      const markoMatched = markoThrew !== null && pattern.test(markoThrew);
      const translatorMatched =
        translatorThrew !== null && pattern.test(translatorThrew);

      let verdict: Verdict;
      let detail: string | undefined;
      if (markoMatched && translatorMatched) {
        verdict = "pass";
      } else {
        verdict = "translator bug";
        unresolved = true;
        detail = `expected both sides to throw matching /${meta.errorPattern}/ -- marko: ${markoThrew ?? "did not throw"}; translator: ${translatorThrew ?? "did not throw"}`;
      }

      rows.push({
        fixture: name,
        marko: markoMatched ? "error (matched)" : (markoThrew ?? "no error"),
        translator: translatorMatched
          ? "error (matched)"
          : (translatorThrew ?? "no error"),
        verdict,
        detail,
      });
      continue;
    }

    const input = JSON.parse(
      readFileSync(join(dir, "input.json"), "utf8"),
    ) as unknown;
    const expected = readFileSync(join(dir, "expected.html"), "utf8");

    let markoStatus: string;
    try {
      markoStatus = htmlEquals(await renderStockMarko(dir, input), expected)
        ? "pass"
        : "mismatch";
    } catch (err) {
      markoStatus = `error: ${(err as Error).message.slice(0, 60)}`;
    }

    let translatorStatus: string;
    try {
      translatorStatus = htmlEquals(
        await renderTranslator(dir, join(dir, "input.marko"), input),
        expected,
      )
        ? "pass"
        : "mismatch";
    } catch (err) {
      translatorStatus = `error: ${(err as Error).message.slice(0, 60)}`;
    }

    const bothPass = markoStatus === "pass" && translatorStatus === "pass";

    let verdict: Verdict;
    let detail: string | undefined;
    if (bothPass) {
      verdict = "pass";
    } else if (meta.marko === "divergence") {
      verdict = "skipped (reason)";
      detail = meta.reason;
    } else {
      verdict = "translator bug";
      detail = "unclassified: mismatch or error with no meta.json entry";
      unresolved = true;
    }

    rows.push({
      fixture: name,
      marko: markoStatus,
      translator: translatorStatus,
      verdict,
      detail,
    });
  }

  const nameWidth = Math.max(8, ...rows.map((r) => r.fixture.length));
  console.log("");
  console.log("=== stock .marko fixtures (@mxlang/html) ===");
  console.log(
    `${"fixture".padEnd(nameWidth)}  marko            translator       verdict`,
  );
  for (const r of rows) {
    console.log(
      `${r.fixture.padEnd(nameWidth)}  ${r.marko.padEnd(15)}  ${r.translator.padEnd(15)}  ${r.verdict}${r.detail ? `  (${r.detail})` : ""}`,
    );
  }

  const passCount = rows.filter((r) => r.verdict === "pass").length;
  const skippedCount = rows.filter(
    (r) => r.verdict === "skipped (reason)",
  ).length;
  const bugCount = rows.filter((r) => r.verdict === "translator bug").length;

  console.log("");
  console.log(
    `processed: ${rows.length} stock fixtures (minimum required: ${MIN_FIXTURES}) — ${passCount} pass, ${skippedCount} skipped(reason), ${bugCount} translator bug`,
  );

  let failed = malformed || unresolved;
  if (rows.length < MIN_FIXTURES) {
    console.error(
      `oracle:marko: only ${rows.length} stock fixtures processed, below the required minimum of ${MIN_FIXTURES} — treating as a failed run, not a pass`,
    );
    failed = true;
  }

  return { rows, failed };
}
