/**
 * Writes `dist/index.d.ts` from `src/public.d.ts`.
 *
 * `public.d.ts` is the package's hand-written public surface, wrapped in an
 * ambient `declare module "@mxlang/parser" { … }` so in-repo consumers can map
 * the specifier to it through `paths`. A published `types` entry must be a real
 * module instead, so this unwraps the block (same statements, same order,
 * dedented one level). `tsc --emitDeclarationOnly` over `src/index.ts` is not
 * an option: the vendored `src/babel/` tree needs tsconfig relaxations that
 * must not reach the emitted surface (see AGENTS.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/public.d.ts"), "utf8");

const open = /^declare module "@mxlang\/parser" \{\n/m.exec(source);
const close = source.lastIndexOf("\n}");
if (!open || close < open.index) {
  throw new Error(
    'src/public.d.ts: expected one `declare module "@mxlang/parser" { … }` block',
  );
}

const header = source.slice(0, open.index);
const body = source
  .slice(open.index + open[0].length, close)
  .split("\n")
  .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
  .join("\n");

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/index.d.ts"), `${header}${body}\n`);
