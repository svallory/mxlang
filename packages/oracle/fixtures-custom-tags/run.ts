import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomTag, TemplateBackedTag } from "@mxlang/core";
import { compileHonoMx } from "@mxlang/hono";
import { compile as compileHtml } from "@mxlang/html";
import { compilePreactMx } from "@mxlang/preact";
import { compileReactMx } from "@mxlang/react";
import { compileSolidMx } from "@mxlang/solid";
import { transform as nativeTransform } from "@solidjs/compiler";
import { normalizeHtml } from "../src/normalize-html.ts";
import icon from "./icon/icon.tag.ts";
import spriteIcon from "./icon-sprite/icon.tag.ts";
import tableOf from "./table-of/table-of.tag.ts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export type CustomTagHost =
  | "html"
  | "astro"
  | "preact"
  | "react"
  | "hono"
  | "solid";

export interface CustomTagFixtureRow {
  fixture: string;
  host: CustomTagHost;
  status: "pass" | "fail" | "skipped";
  detail?: string;
}

/**
 * One fixture: an MX file, its input, its expected HTML, and its tag map.
 *
 * The two fixtures are the same markup and the same expected bytes through two
 * different definitions of `<icon>` — an L2 sidecar that builds IR, and an L1
 * template inlined from `tags/icon.mx`. That they produce identical output on
 * all six hosts is the point of the gate: a template tag reaches the host as
 * ordinary IR, so no host learns which layer authored it.
 */
interface Fixture {
  name: string;
  source: string;
  input: unknown;
  expected: string;
  customTags: Record<string, CustomTag>;
  /** The path compiled *as*, so a host resolves the fixture's own directory. */
  filename: string;
  /**
   * Hosts this fixture deliberately does not assert, with the reason.
   *
   * A recorded, reasoned skip rather than a silent omission or a weakened
   * expectation — the same contract `oracle:marko`'s `meta.json` uses. A row
   * listed here still runs and still counts toward the gate; it is only its
   * comparison that is withheld, and the reason is printed on every run so it
   * cannot quietly become permanent.
   */
  skip?: Partial<Record<CustomTagHost, string>>;
  /**
   * Template units this fixture's caller imports, by emitted specifier.
   *
   * Each is compiled through the same host as the caller and written beside it,
   * which is what makes this gate test the unit model rather than the harness:
   * the tag is a separate module on every host, exactly as it ships.
   */
  templates?: string[];
}

/** The specifier `lower.ts` mints for a discovered template, as a relative path. */
function unitSpecifier(callerFile: string, templateFile: string): string {
  const specifier = relative(dirname(callerFile), templateFile).replaceAll(
    "\\",
    "/",
  );
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function load(
  name: string,
  customTags: Record<string, CustomTag>,
  skip?: Partial<Record<CustomTagHost, string>>,
): Fixture {
  const directory = join(here, name);
  return {
    skip,
    name,
    source: readFileSync(join(directory, "input.mx"), "utf8"),
    input: JSON.parse(readFileSync(join(directory, "input.json"), "utf8")),
    expected: readFileSync(join(directory, "expected.html"), "utf8"),
    customTags,
    filename: join(directory, "input.mx"),
  };
}

/** The L1 tag: `tags/icon.mx`, registered by path as P2's scan later will. */
const ICON_TEMPLATE = join(here, "icon-template", "tags", "icon.mx");

function templateIcon(): Record<string, CustomTag> {
  return {
    icon: {
      template: {
        filename: ICON_TEMPLATE,
        source: readFileSync(ICON_TEMPLATE, "utf8"),
        mtimeMs: statSync(ICON_TEMPLATE).mtimeMs,
      },
    } satisfies TemplateBackedTag,
  };
}

const FIXTURES: Fixture[] = [
  load("icon", { icon }),
  {
    ...load("icon-template", templateIcon(), {
      solid:
        "a discovered template is imported by the caller (decision 95), but a `.solid.mx` MX region is an *expression* with no module scope to hold the import; the parser bridge writes it into the surrounding TypeScript module, which is tag-unit phase 2 (design §3.2, §10)",
    }),
    templates: [ICON_TEMPLATE],
  },
  // P5's two dogfoods. `icon-sprite` is the same markup as `icon` through the
  // collecting pair — one `<symbol>` per distinct name, prepended once — and
  // `table-of` is L2 without that pair, showing `literalOnly` plus the
  // structural builders on their own.
  load("icon-sprite", { icon: spriteIcon }),
  load("table-of", { "table-of": tableOf }),
];

const HOSTS = 6;
const EXPECTED_ROWS = FIXTURES.length * HOSTS;

/**
 * A module the entry imports, written beside it under the entry's own name.
 *
 * A template tag is a compilation unit (decision 95): the caller emits
 * `import $mx_Icon1 from "./tags/icon.mx"` rather than expanding the template
 * inline, so the tag's own compiled module has to exist on disk beside the
 * caller for that import to resolve.
 */
interface SiblingModule {
  /** The specifier the caller imports, exactly as emitted (`./tags/icon.mx`). */
  specifier: string;
  code: string;
}

async function loadModule(
  code: string,
  extension: "ts" | "tsx" | "jsx",
  jsxImportSource?: string,
  siblings: SiblingModule[] = [],
): Promise<{ default: (input: unknown) => unknown }> {
  const scratch = mkdtempSync(join(tmpdir(), "mx-custom-tags-"));
  try {
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ name: "mx-custom-tags-scratch", type: "module" }),
    );
    if (jsxImportSource) {
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", jsxImportSource },
        }),
      );
    }
    symlinkSync(
      join(here, "..", "node_modules"),
      join(scratch, "node_modules"),
      "dir",
    );
    const entry = join(scratch, `mod.${extension}`);
    const resolveRuntimes = (source: string): string =>
      source
        .replace(
          'from "@mxlang/html"',
          `from ${JSON.stringify(require.resolve("@mxlang/html"))}`,
        )
        .replace(
          '"@mxlang/preact/runtime"',
          JSON.stringify(require.resolve("@mxlang/preact/runtime")),
        );

    // A tag unit is written beside the caller at the path the caller imports,
    // but under a runnable extension: Bun resolves a bare `.mx` import to the
    // file's *path string*, not a module (that is what `@mxlang/html/bun`
    // exists to fix, and this harness loads compiled output directly rather
    // than through a loader). The caller's specifier is repointed to match, so
    // what is under test stays the emitted import, not the extension.
    let entryCode = code;
    for (const sibling of siblings) {
      const runnable = sibling.specifier.replace(/\.mx$/, `.${extension}`);
      const target = join(scratch, runnable);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, resolveRuntimes(sibling.code));
      entryCode = entryCode.replaceAll(
        `"${sibling.specifier}"`,
        `"${runnable}"`,
      );
    }
    writeFileSync(entry, resolveRuntimes(entryCode));
    return (await import(`${entry}?t=${Date.now()}`)) as {
      default: (input: unknown) => unknown;
    };
  } finally {
    // Bun completes the module load before the import promise settles.
    rmSync(scratch, { recursive: true, force: true });
  }
}

function compared(
  fixture: Fixture,
  host: CustomTagHost,
  html: string,
): CustomTagFixtureRow {
  return html.trimEnd() === fixture.expected.trimEnd()
    ? { fixture: fixture.name, host, status: "pass" }
    : {
        fixture: fixture.name,
        host,
        status: "fail",
        detail: `got ${normalizeHtml(html)}; want ${normalizeHtml(fixture.expected)}`,
      };
}

/**
 * Compiles each of a fixture's template units through the caller's own host.
 *
 * This is the unit model's whole claim in one function: a tag template goes
 * through the same per-file compiler a page does, on every host, and the
 * caller reaches it by an ordinary import.
 */
function unitsFor(
  fixture: Fixture,
  compileUnit: (source: string, filename: string) => string,
  callerCode: string,
): SiblingModule[] {
  return (fixture.templates ?? []).map((templateFile) => {
    const specifier = unitSpecifier(fixture.filename, templateFile);
    // `unitSpecifier` reimplements the compiler's own `importSpecifier`, so
    // assert the caller actually emitted that specifier. Without this the two
    // could drift into agreement by coincidence: the rewrite below simply
    // finds nothing, and the failure surfaces as an unrelated resolve error.
    if (!callerCode.includes(`from "${specifier}"`)) {
      throw new Error(
        `expected the caller to import the tag unit as "${specifier}", but it did not; emitted imports: ${
          callerCode.match(/^import .*$/gm)?.join(" | ") ?? "none"
        }`,
      );
    }
    return {
      specifier,
      code: compileUnit(readFileSync(templateFile, "utf8"), templateFile),
    };
  });
}

async function runHtml(fixture: Fixture, strict: boolean): Promise<string> {
  const compileUnit = (source: string, filename: string) =>
    compileHtml(source, filename, {
      customTags: fixture.customTags,
      strict,
    }).code;
  const code = compileUnit(fixture.source, fixture.filename);
  const mod = await loadModule(
    code,
    "ts",
    undefined,
    unitsFor(fixture, compileUnit, code),
  );
  return String(mod.default(fixture.input));
}

async function runPreact(fixture: Fixture): Promise<string> {
  const compileUnit = (source: string, filename: string) =>
    compilePreactMx(source, filename, { customTags: fixture.customTags }).code;
  const code = compileUnit(fixture.source, fixture.filename);
  const mod = await loadModule(
    code,
    "tsx",
    "preact",
    unitsFor(fixture, compileUnit, code),
  );
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const { h } = (await import("preact")) as {
    h: (type: unknown, props: unknown) => unknown;
  };
  return render(h(mod.default, fixture.input));
}

async function runReact(fixture: Fixture): Promise<string> {
  const compileUnit = (source: string, filename: string) =>
    compileReactMx(source, filename, { customTags: fixture.customTags }).code;
  const code = compileUnit(fixture.source, fixture.filename);
  const mod = await loadModule(
    code,
    "tsx",
    "react",
    unitsFor(fixture, compileUnit, code),
  );
  const { createElement } = (await import("react")) as {
    createElement: (type: unknown, props: unknown) => unknown;
  };
  const { renderToStaticMarkup } = (await import("react-dom/server")) as {
    renderToStaticMarkup: (node: unknown) => string;
  };
  return renderToStaticMarkup(
    createElement(mod.default as never, fixture.input as never),
  );
}

async function runHono(fixture: Fixture): Promise<string> {
  const compileUnit = (source: string, filename: string) =>
    compileHonoMx(source, filename, { customTags: fixture.customTags }).code;
  const code = compileUnit(fixture.source, fixture.filename);
  const mod = await loadModule(
    code,
    "tsx",
    "hono/jsx",
    unitsFor(fixture, compileUnit, code),
  );
  const { jsx } = (await import("hono/jsx")) as {
    jsx: (
      type: unknown,
      props: Record<string, unknown>,
    ) => { toString(): string | Promise<string> };
  };
  return String(
    await jsx(mod.default, fixture.input as Record<string, unknown>).toString(),
  );
}

/**
 * Renders the fixture through Solid, so this row compares real output like
 * every other host rather than counting tags in the emitted source.
 *
 * MX lowers to Solid JSX text, which is a list of roots rather than a module,
 * so it is wrapped in a component before `@solidjs/compiler` sees it — the
 * same `generate: "ssr"` path `src/compile.ts` uses, with `hydratable: false`
 * so Solid emits no hydration markers and the bytes can be compared directly
 * against `expected.html`.
 */
async function runSolid(fixture: Fixture): Promise<string> {
  const { code } = compileSolidMx(fixture.source, {
    filename: fixture.filename.replace(/\.mx$/, ".solid.mx"),
    customTags: fixture.customTags,
  });
  const wrapped = `import { For, Show } from "solid-js";
export default function Fixture(input) { return <>${code}</>; }`;
  const compiled = nativeTransform(wrapped, {
    filename: join(here, "fixture.tsx"),
    generate: "ssr",
    hydratable: false,
  });
  if (!compiled?.code) {
    throw new Error(
      "@solidjs/compiler produced no output for the icon fixture",
    );
  }

  // Solid's runtime is hoisted to the workspace root, which the scratch
  // directory's symlinked `node_modules` does not reach; resolve both from
  // here, exactly as the other hosts' imports are resolved.
  const mod = await loadModule(
    compiled.code
      .replaceAll(
        'from "@solidjs/web"',
        `from ${JSON.stringify(require.resolve("@solidjs/web"))}`,
      )
      .replaceAll(
        'from "solid-js"',
        `from ${JSON.stringify(require.resolve("solid-js"))}`,
      ),
    "jsx",
  );
  const { renderToString } = (await import("@solidjs/web")) as {
    renderToString: (fn: () => unknown) => string;
  };
  return renderToString(() => mod.default(fixture.input));
}

async function attempt(
  fixture: Fixture,
  host: CustomTagHost,
  run: () => string | Promise<string>,
): Promise<CustomTagFixtureRow> {
  const skipped = fixture.skip?.[host];
  if (skipped) {
    return { fixture: fixture.name, host, status: "skipped", detail: skipped };
  }
  try {
    return compared(fixture, host, await run());
  } catch (error) {
    return {
      fixture: fixture.name,
      host,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runCustomTagFixtures(): Promise<CustomTagFixtureRow[]> {
  const rows: CustomTagFixtureRow[] = [];
  for (const fixture of FIXTURES) {
    rows.push(
      await attempt(fixture, "html", () => runHtml(fixture, false)),
      await attempt(fixture, "astro", () => runHtml(fixture, true)),
      await attempt(fixture, "preact", () => runPreact(fixture)),
      await attempt(fixture, "react", () => runReact(fixture)),
      await attempt(fixture, "hono", () => runHono(fixture)),
      await attempt(fixture, "solid", () => runSolid(fixture)),
    );
  }

  // Decision 55: a gate must assert it did the work, not only that nothing
  // failed. A fixture that silently stopped running is a failure here.
  if (rows.length !== EXPECTED_ROWS) {
    throw new Error(
      `custom-tag count gate: ran ${rows.length} rows, expected ${EXPECTED_ROWS} (${FIXTURES.length} fixtures x ${HOSTS} hosts)`,
    );
  }
  return rows;
}

if (import.meta.main) {
  const rows = await runCustomTagFixtures();
  console.log("custom-tags: fixtures");
  for (const row of rows) {
    console.log(
      `${row.fixture.padEnd(14)} ${row.host.padEnd(8)} ${row.status}${row.detail ? ` — ${row.detail}` : ""}`,
    );
  }
  const passed = rows.filter((row) => row.status === "pass").length;
  const skipped = rows.filter((row) => row.status === "skipped").length;
  console.log(
    `${passed}/${EXPECTED_ROWS} rows passed, ${skipped} skipped(reason)`,
  );
  // A skip is a recorded decision, not a failure; anything else is.
  if (passed + skipped !== EXPECTED_ROWS) process.exitCode = 1;
}
