import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import mx, { relabelBuildErrors } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package tree, like the other build tests: a compiled page
// imports its host package (`@mxlang/host-preact`) by bare specifier.
const root = mkdtempSync(join(here, "..", ".tmp-build-error-header-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Error text is asserted ANSI-stripped: CI may colorize the code frame.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text: string): string => text.replace(ANSI, "");

function write(project: string, rel: string, source: string): void {
  const path = join(root, project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

/** A project whose `page.mx` fails to compile, built for real. */
async function buildError(
  project: string,
  page: string,
  host = "preact",
  strict = false,
): Promise<Error> {
  write(
    project,
    "package.json",
    JSON.stringify({ name: project, type: "module", mx: { host } }),
  );
  write(project, "page.mx", page);
  write(
    project,
    "entry.ts",
    'import page from "./page.mx";\nexport default page;\n',
  );
  const projectRoot = join(root, project);
  return build({
    root: projectRoot,
    configFile: false,
    logLevel: "silent",
    plugins: [mx({ strict })],
    build: {
      ssr: join(projectRoot, "entry.ts"),
      outDir: join(projectRoot, "dist"),
      emptyOutDir: true,
      minify: false,
    },
  }).then(
    () => {
      throw new Error("expected the build to fail");
    },
    (err: unknown) => err as Error,
  );
}

/** The authored page's own path, which is what the header must name. */
function authored(project: string): string {
  return join(root, project, "page.mx");
}

/**
 * The one line a build prints above the message: `[plugin mx] <id>:<line>:<col>`,
 * with printed positions 1-based (#227). The dev overlay's `loc` stays 0-based.
 */
function header(message: string): string {
  const line = plain(message)
    .split("\n")
    .find((entry) => entry.includes("[plugin mx]"));
  expect(line).toBeDefined();
  return (line as string).trim();
}

describe("a failing vite build names the authored file, not the virtual id", () => {
  it.each([
    // One parser error: its single caret reason, which the header points at.
    ["<p>ok</p>\n\n<div>\n", 3, 0, ['Missing ending "div" tag']],
    // Two parser errors arrive as one error carrying one frame each. The
    // header names the first position, but every caret reason survives.
    [
      "<div a=(x +)/>\n<span>",
      1,
      11,
      ["Unexpected token", 'Missing ending "span" tag'],
    ],
  ] as const)(
    "locates a child template syntax error in the child, including the build header",
    async (source, line, column, reasons) => {
      write("callee-parse", "tags/broken.mx", source);
      const error = await buildError(
        "callee-parse",
        "<main>\n  <broken/>\n</main>\n",
        "html",
      );
      expect(header(error.message)).toBe(
        `[plugin mx] ${join(root, "callee-parse/tags/broken.mx")}:${line}:${column + 1}`,
      );
      for (const reason of reasons)
        expect(plain(error.message)).toContain(reason);
      expect(plain(error.message)).not.toContain("page.mx");
      expect(plain(error.message)).not.toContain("at ../");
    },
  );
  it("for a Marko CompileError in a JSX-host .mx", async () => {
    const error = await buildError("compile", "<div>hello\n");
    // Exact: the header is the authored absolute path and printed coordinates
    // are 1-based (Marko reports the unclosed tag's opener).
    expect(header(error.message)).toBe(
      `[plugin mx] ${authored("compile")}:1:1`,
    );
    // The virtual id is what rolldown stamps on a plugin error; the authored
    // path is what a reader (or an agent following the header) needs.
    expect(plain(error.message)).not.toContain(".mx.tsx");
    // The rest of the diagnostic is unchanged: same reason, same frame.
    expect(plain(error.message)).toContain('Missing ending "div" tag');
    expect(plain(error.message)).toContain("1 | <div>hello");
  });

  it("for a TranslateError, and on the html host too", async () => {
    const error = await buildError(
      "translate",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored MX source
      "<let/count=0/>\n<div>${count}</div>\n",
      "html",
      true,
    );
    expect(header(error.message)).toBe(
      `[plugin mx] ${authored("translate")}:1:1`,
    );
    expect(plain(error.message)).not.toContain(".mx.tsx");
    expect(plain(error.message)).toContain("`<let>` is reactive state");
  });

  it("carries every other error of the file in the message (decision 162)", async () => {
    // Three independent errors: a scriptlet, an `<if>` without a condition,
    // CDATA. A build throws one error; the other two ride in its message.
    const error = await buildError(
      "recovery",
      "<div>ok</div>\n$ const a = 1\n<p>fine</p>\n<if></if>\n<![CDATA[raw]]>\n",
      "html",
    );
    const text = plain(error.message);
    expect(header(error.message)).toBe(
      `[plugin mx] ${authored("recovery")}:2:1`,
    );
    expect(text).toContain("scriptlets");
    expect(text).toContain("2 more errors in this file");
    expect(text).toContain("4:1: `<if>` without a condition");
    expect(text).toContain("5:1: `<![CDATA[");
  });

  /**
   * The dev server needs no hook for this: the plugin's own error reaches it
   * with the authored `id` (Vite's plugin context keeps `id` and drops the
   * `loc` it did not set), so the overlay's file is the authored one. Pinned
   * here because the build-side fix is a `buildEnd` rewrite, and a change that
   * broke the dev path would otherwise pass this suite.
   */
  it("and the dev server still names the authored file", async () => {
    write(
      "dev",
      "package.json",
      JSON.stringify({ name: "dev", type: "module", mx: { host: "html" } }),
    );
    write("dev", "page.mx", "<div>hello\n");
    const projectRoot = join(root, "dev");
    const server = await createServer({
      root: projectRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [mx()],
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: "custom",
    });
    try {
      const error = await server
        .ssrLoadModule(join(projectRoot, "page.mx"))
        .then(
          () => undefined,
          (err: Error) => err,
        );
      expect(error).toBeInstanceOf(Error);
      const located = error as Error & { id?: string };
      expect(located.id).toMatch(/[/\\]page\.mx$/);
      expect((error as { plugin?: string }).plugin).toBe("mx");
      expect(plain(String(error?.stack))).not.toContain(".mx.tsx");
    } finally {
      await server.close();
    }
  });
});

describe("relabelBuildErrors", () => {
  // The same shape as the plugin's own `authoredId`: strip the virtual
  // `.tsx` and carry any `?query` across.
  const authored = (id: string): string | undefined => {
    const query = id.search(/[?#]/);
    const path = query === -1 ? id : id.slice(0, query);
    const rest = query === -1 ? "" : id.slice(query);
    return path.endsWith(".mx.tsx")
      ? `${path.slice(0, -".tsx".length)}${rest}`
      : undefined;
  };

  it("re-labels this plugin's own error and counts it", () => {
    const diagnostic = {
      id: "/root/src/page.mx.tsx",
      loc: { file: "/root/src/page.mx", line: 1, column: 0 },
      plugin: "mx",
    };
    const error = { errors: [diagnostic] };
    expect(relabelBuildErrors(error, authored)).toBe(1);
    expect(diagnostic.id).toBe("/root/src/page.mx");
    expect(diagnostic.loc.file).toBe("/root/src/page.mx");
    expect(diagnostic.loc.column).toBe(1);
  });

  it("keeps a callee locator paired with its coordinates", () => {
    const diagnostic = {
      id: "/root/src/page.mx.tsx",
      loc: { file: "/root/src/tags/broken.mx", line: 3, column: 0 },
      plugin: "mx",
    };
    expect(relabelBuildErrors({ errors: [diagnostic] }, authored)).toBe(1);
    expect(diagnostic.id).toBe("/root/src/tags/broken.mx");
    expect(diagnostic.loc).toEqual({
      file: "/root/src/tags/broken.mx",
      line: 3,
      column: 1,
    });
    // A second pass must not convert the column again.
    expect(relabelBuildErrors({ errors: [diagnostic] }, authored)).toBe(0);
    expect(diagnostic.loc.column).toBe(1);
  });

  it("leaves another plugin's error alone", () => {
    const other = { id: "/root/src/page.mx.tsx", plugin: "someone-else" };
    expect(relabelBuildErrors({ errors: [other] }, authored)).toBe(0);
    expect(other.id).toBe("/root/src/page.mx.tsx");
  });

  it("leaves a diagnostic rolldown rendered itself alone", () => {
    // `kind` marks a message rolldown already formatted, with the generated
    // path baked in and a position in generated text: there is no authored
    // line to point at, so renaming the file alone would be a lie.
    const rendered = {
      kind: "PLUGIN_ERROR",
      message: "[builtin:vite-transform] Unexpected token (page.mx.tsx:18:24)",
      plugin: "mx",
      id: undefined,
    };
    expect(relabelBuildErrors({ errors: [rendered] }, authored)).toBe(0);
    expect(rendered.message).toContain("page.mx.tsx:18:24");
  });

  it("keeps a query suffix, and ignores an id this plugin did not mint", () => {
    const diagnostic = { id: "/root/src/page.mx.tsx?t=1", plugin: "mx" };
    expect(relabelBuildErrors({ errors: [diagnostic] }, authored)).toBe(1);
    expect(diagnostic.id).toBe("/root/src/page.mx?t=1");
    const foreign = { id: "/root/src/other.tsx", plugin: "mx" };
    expect(relabelBuildErrors({ errors: [foreign] }, authored)).toBe(0);
    expect(foreign.id).toBe("/root/src/other.tsx");
  });

  it("survives an aggregate that is not a build failure's shape", () => {
    expect(relabelBuildErrors(undefined, authored)).toBe(0);
    expect(relabelBuildErrors(new Error("no errors"), authored)).toBe(0);
    expect(relabelBuildErrors({ errors: [] }, authored)).toBe(0);
    expect(relabelBuildErrors({ errors: [null, "x"] }, authored)).toBe(0);
  });

  it("never turns a frozen diagnostic into a crash", () => {
    const diagnostic = Object.freeze({
      id: "/root/src/page.mx.tsx",
      plugin: "mx",
    });
    expect(relabelBuildErrors({ errors: [diagnostic] }, authored)).toBe(0);
  });
});
