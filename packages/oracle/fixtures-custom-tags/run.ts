import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
function templateIcon(): Record<string, CustomTag> {
  const filename = join(here, "icon-template", "tags", "icon.mx");
  return {
    icon: {
      template: {
        filename,
        source: readFileSync(filename, "utf8"),
        mtimeMs: statSync(filename).mtimeMs,
      },
    } satisfies TemplateBackedTag,
  };
}

const FIXTURES: Fixture[] = [
  load("icon", { icon }),
  load("icon-template", templateIcon()),
  // P5's two dogfoods. `icon-sprite` is the same markup as `icon` through the
  // collecting pair — one `<symbol>` per distinct name, prepended once — and
  // `table-of` is L2 without that pair, showing `literalOnly` plus the
  // structural builders on their own.
  load("icon-sprite", { icon: spriteIcon }),
  load("table-of", { "table-of": tableOf }),
];

const HOSTS = 6;
const EXPECTED_ROWS = FIXTURES.length * HOSTS;

async function loadModule(
  code: string,
  extension: "ts" | "tsx" | "jsx",
  jsxImportSource?: string,
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
    const rewritten = code
      .replace(
        'from "@mxlang/html"',
        `from ${JSON.stringify(require.resolve("@mxlang/html"))}`,
      )
      .replace(
        '"@mxlang/preact/runtime"',
        JSON.stringify(require.resolve("@mxlang/preact/runtime")),
      );
    writeFileSync(entry, rewritten);
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

async function runHtml(fixture: Fixture, strict: boolean): Promise<string> {
  const { code } = compileHtml(fixture.source, fixture.filename, {
    customTags: fixture.customTags,
    strict,
  });
  const mod = await loadModule(code, "ts");
  return String(mod.default(fixture.input));
}

async function runPreact(fixture: Fixture): Promise<string> {
  const { code } = compilePreactMx(fixture.source, fixture.filename, {
    customTags: fixture.customTags,
  });
  const mod = await loadModule(code, "tsx", "preact");
  const { render } = (await import("preact-render-to-string")) as {
    render: (vnode: unknown) => string;
  };
  const { h } = (await import("preact")) as {
    h: (type: unknown, props: unknown) => unknown;
  };
  return render(h(mod.default, fixture.input));
}

async function runReact(fixture: Fixture): Promise<string> {
  const { code } = compileReactMx(fixture.source, fixture.filename, {
    customTags: fixture.customTags,
  });
  const mod = await loadModule(code, "tsx", "react");
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
  const { code } = compileHonoMx(fixture.source, fixture.filename, {
    customTags: fixture.customTags,
  });
  const mod = await loadModule(code, "tsx", "hono/jsx");
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
