import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Importing the registry must load no compiler. The probe runs in a fresh
// `bun` process (the repo's Bun-first tooling loads every `@mxlang/*` source
// file the way the VSIX bundle inlines it) and lists the modules the process
// loaded that belong to a compiler: `@marko/compiler`, `@astrojs/compiler`,
// or the Babel core lowers and prints with (`@babel/core`, `generator`,
// `traverse`; `@babel/parser` is light and loads on import). Since decision
// 197 slice S3a a compile loads no `@marko/compiler`, so Babel shows one ran.

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mx-registry-light-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Bun's install layout nests a package as `.bun/@marko+compiler@x/node_modules/@marko/compiler`. */
const COMPILERS = String.raw`/node_modules\/(\.bun\/)?(@marko[+/]compiler|@astrojs[+/]compiler|@babel[+/](core|generator|traverse)[@/])|\/marko-frontend\.cjs$/`;

/**
 * A host's or target's compile entry: `src/index.ts` of a source-loaded
 * package, or `dist/index.js` of a packed one (`@mxlang/target-html` resolves
 * to `packages/targets/html/dist/index.js`). Importing the registry must pull
 * in only descriptor modules and their light dependencies — never a compile
 * entry — so a descriptor that eagerly imports its compile entry (e.g. a
 * top-level `import "@mxlang/target-html"` in the astro descriptor) fails the
 * import test below even though that entry is itself compiler-lazy today.
 */
const COMPILE_ENTRIES =
  /packages\/(hosts|targets)\/[^/]+\/(src\/index\.ts|dist\/index\.js)$/;

function probe(body: string): {
  loaded: string[];
  entries: string[];
  value: unknown;
} {
  const file = join(
    here,
    `.light-probe-${process.pid}-${Math.random().toString(36).slice(2)}.ts`,
  );
  writeFileSync(
    file,
    `import { builtinTargets } from "./index.ts";
const compilers = () => Object.keys(require.cache).filter((k) => ${COMPILERS}.test(k));
const compileEntries = () => Object.keys(require.cache).filter((k) => ${COMPILE_ENTRIES}.test(k));
const value = (() => { ${body} })();
console.log(JSON.stringify({ loaded: compilers(), entries: compileEntries(), value }));
`,
  );
  try {
    const run = spawnSync("bun", [file], { encoding: "utf8", cwd: here });
    expect(run.status, run.stderr).toBe(0);
    const last = run.stdout.trim().split("\n").at(-1) as string;
    return JSON.parse(last);
  } finally {
    rmSync(file, { force: true });
  }
}

describe("light import", () => {
  it("loads no compiler and no compile entry when the registry is imported", () => {
    const { loaded, entries, value } = probe(`return builtinTargets.length;`);
    expect(value).toBe(7);
    expect(loaded).toEqual([]);
    // Only descriptor modules and their light dependencies may appear.
    expect(entries).toEqual([]);
  });

  it("detects a compiler once a target's load() compiles (positive control)", () => {
    const page = join(work, "a.mx");
    const { loaded } = probe(
      `const html = builtinTargets.find((t) => t.name === "html")!;
       html.load!({} as never).compileModule("<p>hi</p>", ${JSON.stringify(page)}, {});
       return null;`,
    );
    expect(loaded.some((k) => k.includes("@babel"))).toBe(true);
  });

  it("loads no compiler for load() alone, and sees the compile entry astro's load() requires", () => {
    const { loaded, entries, value } = probe(
      `return builtinTargets.map((t) => { t.load?.({} as never); return t.name; });`,
    );
    expect(value).toEqual([
      "html",
      "astro-html",
      "solid-jsx",
      "preact-jsx",
      "react-jsx",
      "hono-jsx",
      "angular-template",
    ]);
    expect(loaded).toEqual([]);
    // Positive control for COMPILE_ENTRIES: astro's load() requires
    // `@mxlang/target-html`, so its compile entry must be listed.
    expect(
      entries.some((k) => k.endsWith("/packages/targets/html/dist/index.js")),
    ).toBe(true);
  });
});
