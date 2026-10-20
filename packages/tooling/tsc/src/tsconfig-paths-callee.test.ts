import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { here, mxTsc, run, SPAWN_TIMEOUT_MS } from "./test-support.ts";

/**
 * tsconfig `paths`/`baseUrl` reach `.mx` callee imports in `mx-tsc` (mx-c1cu):
 * the program's own compiler options decide alias resolution, so an aliased
 * import resolves to the same file a Vite `resolve.alias` build sees, instead
 * of falling back with a false `MX_UNREADABLE_CALLEE_INPUT`. TypeScript's
 * import resolver already honours aliases. Every case is a real `mx-tsc` run over a
 * scratch project; the language server has no ts program and stays as it was.
 */

const CALLEE = "export interface Input { a?: string }\n\n<div/>\n";
// An attribute tag in the body is what makes an unreadable callee warn, so
// the positive cases assert the read, not just the absence of other errors.
const PAGE = (specifier: string) =>
  `import Card from "${specifier}"\n\n<Card><@tab/></Card>\n`;

/**
 * The `paths` entry every case carries: the generated code imports
 * `@mxlang/target-html`, which a scratch project can only resolve by mapping
 * it to the workspace source, the way the host-dispatch fixture tsconfig
 * does. Written relative to the scratch project's directory.
 */
const targetHtmlEntry = (dir: string) => ({
  "@mxlang/target-html": [
    relative(
      dir,
      join(
        realpathSync(join(here, "..", "..", "..")),
        "targets/html/src/index.ts",
      ),
    ),
  ],
});

interface Project {
  dir: string;
  page: (source: string) => void;
  run: () => ReturnType<typeof run>;
}

/**
 * A scratch html project: `page.mx` plus `src/Card.mx`, a `package.json`
 * naming the html host, and the tsconfig this case needs. The page source is
 * written per case; everything else is fixed by the caller up front.
 */
function project(
  tsconfig: object,
  extra?: {
    callee?: string;
    files?: Record<string, string>;
  },
): Project {
  const dir = mkdtempSync(join(tmpdir(), "mx-tsconfig-paths-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), '{"name":"x","mx":{"host":"html"}}');
  writeFileSync(join(dir, "src", "Card.mx"), extra?.callee ?? CALLEE);
  const {
    compilerOptions,
    extends: extendsFile,
    ...rest
  } = tsconfig as {
    compilerOptions?: Record<string, unknown>;
    extends?: string;
  };
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      ...rest,
      ...(extendsFile === undefined ? {} : { extends: extendsFile }),
      compilerOptions: {
        // With `extends`, the base's `paths` must survive: the extending
        // config's `paths` replaces it wholesale, so the package mapping is
        // written into the base instead (see the `base.json` arm below).
        ...(extendsFile === undefined ? { baseUrl: "." } : {}),
        ...compilerOptions,
        ...(extendsFile === undefined
          ? {
              paths: {
                ...targetHtmlEntry(dir),
                ...(compilerOptions?.paths as object | undefined),
              },
            }
          : {}),
      },
    }),
  );
  for (const [name, text] of Object.entries(extra?.files ?? {})) {
    const file = join(dir, name);
    mkdirSync(join(file, ".."), { recursive: true });
    // An `extends` base supplies its own `paths`, which the extending
    // config's `paths` replaces wholesale: the package mapping this helper
    // writes into the main tsconfig must reach the base too, or the base's
    // aliases are silently dropped.
    if (name === "base.json") {
      const base = JSON.parse(text) as {
        compilerOptions?: Record<string, unknown>;
      };
      writeFileSync(
        file,
        JSON.stringify({
          ...base,
          compilerOptions: {
            baseUrl: ".",
            ...base.compilerOptions,
            paths: {
              ...targetHtmlEntry(dir),
              ...(base.compilerOptions?.paths as object | undefined),
            },
          },
        }),
      );
      continue;
    }
    writeFileSync(file, text);
  }
  return {
    dir,
    page: (source: string) => writeFileSync(join(dir, "page.mx"), source),
    run: () => run(mxTsc, ["--noEmit", "--pretty", "false", "-p", dir]),
  };
}

const BASE_OPTIONS = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "bundler",
  jsx: "preserve",
  types: [],
  allowImportingTsExtensions: true,
  ignoreDeprecations: "6.0",
};

it(
  "resolves a `paths` star alias with the .mx extension kept",
  () => {
    const p = project({
      compilerOptions: {
        ...BASE_OPTIONS,
        baseUrl: ".",
        paths: { "~/*": ["src/*"] },
      },
      include: ["page.mx", "src"],
    });
    try {
      p.page(PAGE("~/Card.mx"));
      const result = p.run();
      expect(result.output).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
      expect(result.output).not.toContain("TS2307");
      // The callee's real `Input` was read: `a` is `string | undefined`, so a
      // number is a type error only because the alias resolved to `src/Card.mx`.
      p.page(`import Card from "~/Card.mx"\n\n<Card a=(123)/>\n`);
      const typed = p.run();
      expect(typed.status).not.toBe(0);
      expect(typed.output).toContain(
        "page.mx(3,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      );
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);

it(
  "resolves a `paths` star alias with the .mx extension omitted",
  () => {
    const p = project({
      compilerOptions: {
        ...BASE_OPTIONS,
        baseUrl: ".",
        paths: { "~/*": ["src/*"] },
      },
      include: ["page.mx", "src"],
    });
    try {
      p.page(PAGE("~/Card"));
      const result = p.run();
      expect(result.output).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);

it(
  "resolves an exact `paths` alias",
  () => {
    const p = project({
      compilerOptions: {
        ...BASE_OPTIONS,
        baseUrl: ".",
        paths: { card: ["./src/Card.mx"] },
      },
      include: ["page.mx", "src"],
    });
    try {
      p.page(PAGE("card"));
      const result = p.run();
      expect(result.output).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);

it(
  "resolves a bare specifier through `baseUrl` alone",
  () => {
    const p = project({
      compilerOptions: { ...BASE_OPTIONS, baseUrl: "." },
      include: ["page.mx", "src"],
    });
    try {
      p.page(PAGE("src/Card.mx"));
      const result = p.run();
      expect(result.output).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
      expect(result.output).not.toContain("TS2307");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);

it(
  "resolves an alias an `extends` chain supplies",
  () => {
    const p = project(
      {
        compilerOptions: { ...BASE_OPTIONS },
        extends: "./base.json",
        include: ["page.mx", "src"],
      },
      {
        files: {
          "base.json": JSON.stringify({
            compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } },
          }),
        },
      },
    );
    try {
      p.page(PAGE("~/Card.mx"));
      const result = p.run();
      expect(result.output).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);

it(
  "leaves a non-.mx alias target to tsc, with no MX diagnostic",
  () => {
    const p = project(
      {
        compilerOptions: {
          ...BASE_OPTIONS,
          baseUrl: ".",
          paths: { "~/*": ["src/*"] },
        },
        include: ["page.mx", "src"],
      },
      {
        files: { "src/util.ts": "export const v = 1;\n" },
      },
    );
    try {
      p.page(
        'import { v } from "~/util";\nexport const u: string = v;\n<div/>\n',
      );
      const result = p.run();
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(
        "TS2322: Type 'number' is not assignable to type 'string'.",
      );
      expect(result.output).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
      expect(result.output).not.toContain("TS2307");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);

it(
  "still reports the existing error for an alias that does not resolve",
  () => {
    const p = project({
      compilerOptions: {
        ...BASE_OPTIONS,
        baseUrl: ".",
        paths: { "~/*": ["src/*"] },
      },
      include: ["page.mx", "src"],
    });
    try {
      p.page('import Card from "~/Missing.mx"\n\n<Card><@tab/></Card>\n');
      const result = p.run();
      expect(result.status).not.toBe(0);
      // tsc's own paths-aware TS2307, unchanged by this fix.
      expect(result.output).toContain("TS2307");
      // The same warning, code and position as before it.
      expect(result.output).toContain(
        "page.mx(3,2): warning MX_UNREADABLE_CALLEE_INPUT: couldn't read `<Card>`'s Input (`~/Missing.mx` not resolvable); attribute-tag shape inferred from this call",
      );
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);

it(
  "leaves relative .mx imports resolving as before",
  () => {
    const p = project({
      compilerOptions: { ...BASE_OPTIONS },
      include: ["page.mx", "src"],
    });
    try {
      p.page(PAGE("./src/Card.mx"));
      const result = p.run();
      expect(result.output).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
      expect(result.output).not.toContain("TS2307");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  },
  SPAWN_TIMEOUT_MS,
);
