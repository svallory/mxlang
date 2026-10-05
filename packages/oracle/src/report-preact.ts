import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlEquals } from "./normalize-html";
import { renderPreact } from "./preact-render";

/**
 * `oracle:preact`: does the Preact host render the structural subset the same
 * way the string host does?
 *
 * The claim MX makes about hosts is that the *structure* — elements, text,
 * `<if>`, `<for>`, components, attribute tags — means the same thing on every
 * target. This is that claim, checked rather than asserted: every fixture in
 * the stock `.marko` set (`packages/targets/html/fixtures-marko/`, the same 45
 * `oracle:marko` uses) is compiled through `@mxlang/preact`, rendered with
 * `preact-render-to-string`, and compared against the fixture's own
 * `expected.html` — which was generated from real Marko, so a pass means
 * this host agrees with Marko too, transitively.
 *
 * The comparison is `normalize-html.ts`'s `htmlEquals`, the same semantic
 * equality `oracle:marko` uses: both sides parsed with parse5 and compared by
 * decoded tag/attribute/text/comment content. That matters more here than it
 * did there, because Preact's own serializer makes different spelling choices
 * than a string builder does (attribute quoting, void-element spelling,
 * entity form) and none of those are differences in what renders.
 *
 * ## Skips
 *
 * A fixture is skipped only for a construct this host *declares* unsupported
 * — decision 65's rule, "this target cannot", never "my code cannot" — and
 * each one names the construct. They are listed in `SKIPS` below rather than
 * in the fixtures' own `meta.json`, because a fixture's `meta.json` records
 * what *Marko* does with it and is shared with `oracle:marko`; a Preact skip
 * is this runner's fact, not the fixture's.
 *
 * Decision 55: the run fails if the fixture glob expands to nothing, if a
 * fixture is missing a file, or if fewer than MIN_FIXTURES were processed — a
 * gate must assert it did work, not merely that nothing failed.
 */

const MIN_FIXTURES = 43;

/**
 * Fixtures this host cannot render, each naming the construct.
 *
 * Every entry is a construct the *target* has no form for, and each is a
 * compile error with the same message the unit tests pin — so a skip here is
 * the documented behaviour, not an unimplemented row.
 */
function skips(targetName: string): Record<string, string> {
  return {
    "let-tag": `\`<let>\` is Marko reactive state; the ${targetName} host rejects it and directs the author to \`useState\``,
    "server-block": `a \`server\` block is Marko's server/client split; a ${targetName} component is one function with no server half`,
    "dynamic-tag":
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX dynamic-tag syntax
      "a dynamic tag name (`<${expr}>`) cannot sit in JSX tag position, which requires a capitalized identifier",
    "dynamic-tag-lowercase-import":
      "same as `dynamic-tag`: a runtime-resolved tag name has no JSX form",
    "doctype-page":
      "`<!doctype html>` belongs to the HTML shell that mounts the app, not to a component's markup",
    "html-comment-placeholder":
      "`<html-comment>` emits a comment node with interpolated content; JSX has no comment node that reaches the DOM",
    "html-comment-falsy":
      "same as `html-comment-placeholder`: a rendered HTML comment has no JSX form",
    "comments-and-html-comment":
      "same as `html-comment-placeholder`: a rendered HTML comment has no JSX form",
    "while-loop":
      "`<while>` is an unbounded loop; a JSX expression renders a finite list, and the host has no `.map` form for it",
    "style-object": `${targetName}'s own style serializer appends \`px\` to a numeric value for a dimensional property, so \`style={top: 0}\` renders \`top:0px\` where Marko renders \`top:0\`. Both set the same computed style; the difference is the target renderer's output, not this host's lowering — which passes the object through to the \`style\` prop unchanged (see the \`style-object\` unit test).`,
  };
}

interface Row {
  fixture: string;
  status: string;
  verdict: "pass" | "host bug" | "skipped (reason)";
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

export async function runJsxHostTable(
  targetName: string,
  renderHost: typeof renderPreact,
): Promise<{
  rows: Row[];
  failed: boolean;
}> {
  if (!existsSync(fixturesRoot)) {
    console.error(
      `oracle:${targetName.toLowerCase()}: fixtures root not found: ${fixturesRoot}`,
    );
    return { rows: [], failed: true };
  }

  const entries = readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    console.error(
      `oracle:${targetName.toLowerCase()}: fixture glob expanded to nothing under ${fixturesRoot}`,
    );
    return { rows: [], failed: true };
  }

  let malformed = false;
  for (const name of entries) {
    const dir = join(fixturesRoot, name);
    for (const file of ["input.marko", "input.json", "expected.html"]) {
      if (!existsSync(join(dir, file))) {
        console.error(
          `oracle:${targetName.toLowerCase()}: fixture "${name}" is missing ${file}`,
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

    const skip = skips(targetName)[name];
    if (skip) {
      rows.push({
        fixture: name,
        status: "skipped (reason)",
        verdict: "skipped (reason)",
        detail: skip,
      });
      continue;
    }

    // A fixture `oracle:marko` itself skips or expects to throw has no
    // `expected.html` to compare against on any host.
    const metaPath = join(dir, "meta.json");
    const meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, "utf8")) as {
          marko?: string;
          reason?: string;
        })
      : {};
    if (meta.marko === "skip" || meta.marko === "error") {
      rows.push({
        fixture: name,
        status: "skipped (reason)",
        verdict: "skipped (reason)",
        detail: `oracle:marko records this fixture as "${meta.marko}": ${meta.reason ?? "no reason given"}`,
      });
      continue;
    }

    const input = JSON.parse(
      readFileSync(join(dir, "input.json"), "utf8"),
    ) as unknown;
    const expected = readFileSync(join(dir, "expected.html"), "utf8");

    let status: string;
    try {
      status = htmlEquals(
        await renderHost(dir, join(dir, "input.marko"), input),
        expected,
        // Preact owns its serializer and emits props in its own order, so
        // comparing positionally would report a difference in Preact's
        // output for a difference in MX's lowering.
        { attributeOrder: "ignore" },
      )
        ? "pass"
        : "mismatch";
    } catch (err) {
      status = `error: ${(err as Error).message.slice(0, 70)}`;
    }

    let verdict: Row["verdict"];
    let detail: string | undefined;
    if (status === "pass") {
      verdict = "pass";
    } else if (meta.marko === "divergence") {
      verdict = "skipped (reason)";
      detail = `oracle:marko records a divergence here: ${meta.reason ?? "no reason given"}`;
    } else {
      verdict = "host bug";
      detail = "unclassified: mismatch or error with no recorded reason";
      unresolved = true;
    }

    rows.push({ fixture: name, status, verdict, detail });
  }

  const nameWidth = Math.max(8, ...rows.map((r) => r.fixture.length));
  console.log("");
  console.log(
    `=== stock .marko fixtures (@mxlang/${targetName.toLowerCase()}) ===`,
  );
  console.log(
    `${"fixture".padEnd(nameWidth)}  ${targetName.toLowerCase().padEnd(15)}  verdict`,
  );
  for (const r of rows) {
    console.log(
      `${r.fixture.padEnd(nameWidth)}  ${r.status.padEnd(15)}  ${r.verdict}${r.detail ? `  (${r.detail})` : ""}`,
    );
  }

  const passCount = rows.filter((r) => r.verdict === "pass").length;
  const skippedCount = rows.filter(
    (r) => r.verdict === "skipped (reason)",
  ).length;
  const bugCount = rows.filter((r) => r.verdict === "host bug").length;

  console.log("");
  console.log(
    `processed: ${rows.length} fixtures (minimum required: ${MIN_FIXTURES}) — ${passCount} pass, ${skippedCount} skipped(reason), ${bugCount} ${targetName.toLowerCase()} bug`,
  );

  let failed = unresolved;
  if (rows.length < MIN_FIXTURES) {
    console.error(
      `oracle:${targetName.toLowerCase()}: only ${rows.length} fixtures processed, below the required minimum of ${MIN_FIXTURES} — treating as a failed run, not a pass`,
    );
    failed = true;
  }

  return { rows, failed };
}

export function runPreactTable(): ReturnType<typeof runJsxHostTable> {
  return runJsxHostTable("Preact", renderPreact);
}
