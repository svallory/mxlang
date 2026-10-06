import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  fixtures,
  mxTsc,
  repoRoot,
  run,
  SPAWN_TIMEOUT_MS,
} from "./test-support.ts";

/**
 * Decision 140, round 2: `mx-tsc` emits JavaScript from the same projection it
 * type-checks, so the handler wrapper must be erased by TypeScript's emit. A
 * helper *call* survives emit and throws at run time; a `satisfies` does not.
 * Each host: emit with `mx-tsc` (strict, `react-jsx`, the host's
 * `jsxImportSource`, `esnext`), import the emitted module, render it.
 */
const HOSTS = [
  { host: "preact", jsxImportSource: "preact" },
  { host: "react", jsxImportSource: "react" },
  { host: "hono", jsxImportSource: "hono/jsx" },
] as const;

const SOURCE = [
  "<div>",
  "  <button onClick(e: any) { e.preventDefault(); }>x</button>",
  "  <input onKeyDown=((e: any) => e.key)/>",
  "  <my-el onBlur=((a: string) => a)>y</my-el>",
  "</div>",
  "",
].join("\n");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Every function-valued `on…` prop in a rendered JSX tree, by prop name. */
function handlers(node: unknown, found: Record<string, unknown> = {}) {
  if (Array.isArray(node)) {
    for (const child of node) handlers(child, found);
  } else if (node && typeof node === "object") {
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (/^on[A-Z]/.test(key) && typeof value === "function") {
          found[key] = value;
        }
      }
      handlers(props.children, found);
    }
  }
  return found;
}

describe.each(HOSTS)(
  "mx-tsc emit on $host (decision 140)",
  ({ host, jsxImportSource }) => {
    afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

    it(
      "emits a module that runs and carries no type-check helper",
      async () => {
        const root = mkdtempSync(join(fixtures, `.handler-emit-${host}-`));
        roots.push(root);
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "Emit.mx"), SOURCE);
        // Preact and React have no catch-all for custom tags (hono does):
        // declare `<my-el>` as a consumer would, since plain TSX needs the same.
        if (host !== "hono") {
          writeFileSync(
            join(root, "src", "custom.d.ts"),
            `import "${host}"; declare module "${host}" { namespace JSX { interface IntrinsicElements { "my-el": Record<string, unknown>; } } }\n`,
          );
        }
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({ mx: { host } }),
        );
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              module: "esnext",
              moduleResolution: "bundler",
              target: "esnext",
              lib: ["esnext", "dom"],
              jsx: "react-jsx",
              jsxImportSource,
              types: [],
              noEmit: false,
              rootDir: "src",
              outDir: "out",
              baseUrl: ".",
              paths: {
                "@mxlang/core": [
                  join(repoRoot, "packages", "core", "src", "index.ts"),
                ],
              },
              ignoreDeprecations: "6.0",
            },
            include: ["src/Emit.mx", "src/custom.d.ts"],
          }),
        );

        const result = run(mxTsc, ["-p", root]);
        expect(result.output).toBe("");
        expect(result.status).toBe(0);

        const out = join(root, "out", "Emit.mx.js");
        const js = readFileSync(out, "utf8");
        // Reserved runtime helpers remain; type-check-only names are erased.
        expect(js).not.toMatch(/__Mx|satisfies/);
        // Same handlers as the runtime compile, modulo the one paren layer
        // TypeScript keeps around an erased `satisfies` operand.
        expect(js).toMatch(
          /onClick: \(?\(e\) => \{ e\.preventDefault\(\); \}\)?/,
        );
        expect(js).toMatch(/onKeyDown: \(?\(e\) => e\.key\)?/);

        const module = await import(pathToFileURL(out).href);
        const tree = module.default({});
        const found = handlers(tree);
        expect(Object.keys(found)).toContain("onKeyDown");
        expect((found.onKeyDown as (e: unknown) => unknown)({ key: "k" })).toBe(
          "k",
        );
        let prevented = false;
        (found.onClick as (e: unknown) => void)({
          preventDefault: () => {
            prevented = true;
          },
        });
        expect(prevented).toBe(true);
      },
      SPAWN_TIMEOUT_MS,
    );
  },
);
