import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FunctionComponent, h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

interface DocSnippet {
  group: string;
  target: "both" | "preact";
  file: string;
  source: string;
}

const docsPath = fileURLToPath(
  new URL("../../../../apps/docs/docs/language/attr-tag.md", import.meta.url),
);

function snippets(): DocSnippet[] {
  const markdown = readFileSync(docsPath, "utf8");
  const found: DocSnippet[] = [];
  const pattern =
    /<!-- attr-tag-example: (\S+) (both|preact) (\S+) -->\s*```(?:mx|tsx)\n([\s\S]*?)\n```/g;
  for (const match of markdown.matchAll(pattern)) {
    found.push({
      group: match[1] as string,
      target: match[2] as DocSnippet["target"],
      file: match[3] as string,
      source: match[4] as string,
    });
  }
  return found;
}

async function renderGroup(
  group: string,
  input: Record<string, unknown>,
  typecheck = false,
): Promise<string> {
  const selected = snippets().filter(
    (snippet) =>
      snippet.group === group &&
      (snippet.target === "both" || snippet.target === "preact"),
  );
  const dir = mkdtempSync(join(tmpdir(), `mx-attr-docs-preact-${group}-`));
  try {
    const repoNodeModules = dirname(
      dirname(require.resolve("preact/package.json")),
    );
    symlinkSync(repoNodeModules, join(dir, "node_modules"), "dir");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          allowImportingTsExtensions: true,
          jsx: "react-jsx",
          jsxImportSource: "preact",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          paths: {
            "@mxlang/preact": [
              fileURLToPath(new URL("./index.ts", import.meta.url)),
            ],
          },
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
          typeRoots: [
            fileURLToPath(
              new URL("../../../../node_modules/@types", import.meta.url),
            ),
          ],
          types: ["node"],
        },
        include: ["*.tsx"],
      }),
    );
    for (const snippet of selected) {
      writeFileSync(join(dir, snippet.file), `${snippet.source}\n`);
    }
    for (const snippet of selected) {
      if (!snippet.file.endsWith(".mx")) continue;
      const sourcePath = join(dir, snippet.file);
      const code = compilePreactMx(
        `${snippet.source}\n`,
        sourcePath,
      ).code.replace(/(from\s+")(\.[^"]+)\.mx(")/g, "$1$2.tsx$3");
      writeFileSync(sourcePath.replace(/\.mx$/, ".tsx"), code);
    }
    if (typecheck) {
      try {
        execFileSync(
          fileURLToPath(
            new URL("../../../../node_modules/.bin/tsc", import.meta.url),
          ),
          ["--pretty", "false", "-p", join(dir, "tsconfig.json")],
          { cwd: dir, stdio: "pipe" },
        );
      } catch (error) {
        const failed = error as { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
          [failed.stdout?.toString(), failed.stderr?.toString()]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }
    const entry = join(dir, "App.tsx");
    const module = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FunctionComponent<Record<string, unknown>>;
    };
    return render(h(module.default, input));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AttrTag documentation snippets on the Preact host", () => {
  it("compiles, type-checks, and renders the hand-written TSX example", async () => {
    const html = await renderGroup("handwritten-preact", {}, true);
    expect(html).toContain("<h2>Account</h2>");
    expect(html).toContain("Profile: Edit");
    expect(html).toContain("Security: Review");
  });

  it("compiles and renders Tabs", async () => {
    const html = await renderGroup("tabs", {
      showSettings: true,
      projects: ["Roadmap", "Release"],
    });
    expect(html).toContain("Overview: Summary");
    expect(html).toContain("Settings: Preferences");
    expect(html).toContain("Roadmap: Roadmap");
    expect(html).toContain("Release: Release");
  });

  it("compiles and renders Layout", async () => {
    const html = await renderGroup("layout", {});
    expect(html).toContain("<h1>Dashboard</h1>");
    expect(html).toContain("<main><p>Welcome.</p></main>");
    expect(html).toContain("<footer>© MX</footer>");
  });

  it("compiles and renders a parameterized Table row", async () => {
    const html = await renderGroup("table", {
      rows: [{ name: "Ada" }, { name: "Lin" }],
    });
    expect(html).toContain("<td>0</td><td>Ada</td>");
    expect(html).toContain("<td>1</td><td>Lin</td>");
  });

  it("compiles and renders nested tabs and icons", async () => {
    const html = await renderGroup("nested", {});
    expect(html).toContain("📁 Files: Browse");
  });
});
