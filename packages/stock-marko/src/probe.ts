/**
 * `bun run --cwd packages/stock-marko probe '<source>'`
 *
 * Prints, side by side: the stock htmljs-parser 5.18.0 event stream, the
 * MX template parser event stream, and whether stock Marko
 * (@marko/compiler 5.42.10 + marko 6.3.51's translator, wired to the
 * stock parser) compiles the source.
 *
 * Every report that cites this probe must say which parser its "Marko"
 * ran on; the header below prints that sentence.
 */
import { stockMarkoCompile } from "./marko.ts";
import { mxEvents, stockEvents } from "./stock.ts";
import { STOCK_PARSER_VERSION, STOCK_TARBALL_INTEGRITY } from "./vendor.ts";

const source = process.argv[2];
if (source === undefined) {
  console.error("usage: bun run --cwd packages/stock-marko probe '<source>'");
  process.exit(2);
}

console.log(
  `This probe's "Marko" is @marko/compiler 5.42.10 + marko 6.3.51 running on STOCK htmljs-parser ${STOCK_PARSER_VERSION} (vendored tarball, ${STOCK_TARBALL_INTEGRITY}), NOT this repo's patched install. The MX column is packages/parser's template parser (the patched rules).`,
);

console.log("\n== stock htmljs-parser events ==");
for (const line of stockEvents(source)) console.log(line);

console.log("\n== MX template parser events ==");
for (const line of mxEvents(source)) console.log(line);

console.log("\n== stock Marko compile ==");
const result = stockMarkoCompile(source);
if (result.ok) {
  console.log("compiles");
} else {
  const { error } = result;
  const where = error?.loc
    ? ` at line ${error.loc.line}, column ${error.loc.column + 1} (index ${error.loc.index})`
    : "";
  console.log(`error${where}: ${error?.label ?? error?.message ?? "unknown"}`);
  if (error?.label && error.message && error.message !== error.label) {
    console.log(error.message);
  }
}
