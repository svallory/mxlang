import { runStockTable } from "./report-marko-stock";

/**
 * `oracle:marko` (decisions 51, 55, 68): parity check between Marko's own
 * toolchain and `@mxlang/target-html`'s output for the stock `.marko` fixture
 * set at `packages/targets/html/fixtures-marko/`.
 *
 * Decision 68 retired the `.mx` dialect and `@mxlang/target-html`, so the table this
 * script used to print for `packages/mx-html/fixtures-mx/` is gone — there is
 * only one dialect (stock Marko) and one table now, `runStockTable()`'s.
 *
 * `--strict` is accepted for CLI symmetry with `oracle -- --strict`, but does
 * not change behaviour here: a recorded, reasoned skip/divergence (a
 * fixture's `meta.json`, see `fixtures/README.md`'s "oracle:marko" section)
 * never fails the run, in either mode — that classification is the settled
 * state, not unfinished work. Only an unclassified mismatch, a malformed
 * `meta.json`, or too few fixtures processed fails it (decision 55: a gate
 * must assert it did work, not merely that nothing failed).
 */

const args = process.argv.slice(2);
const strict = args.includes("--strict");

const { failed } = await runStockTable();

if (strict) console.log("(--strict: recorded skips/divergences do not fail)");

process.exit(failed ? 1 : 0);
