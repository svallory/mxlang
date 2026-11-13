import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

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

async function renderGroup(group: string, input: unknown): Promise<string> {
  const selected = snippets().filter(
    (snippet) => snippet.group === group && snippet.target === "both",
  );
  const dir = mkdtempSync(join(tmpdir(), `mx-attr-docs-${group}-`));
  try {
    for (const snippet of selected) {
      writeFileSync(join(dir, snippet.file), `${snippet.source}\n`);
    }
    writeFileSync(
      join(dir, "runtime.ts"),
      [
        `export { escape } from ${JSON.stringify(fileURLToPath(new URL("../../../core/src/escape.ts", import.meta.url)))};`,
        `export { createBufferedOut, createOut } from ${JSON.stringify(fileURLToPath(new URL("./runtime.ts", import.meta.url)))};`,
        `export type { AttrTag } from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))};`,
      ].join("\n"),
    );
    for (const snippet of selected) {
      if (!snippet.file.endsWith(".mx")) continue;
      const sourcePath = join(dir, snippet.file);
      const code = compile(`${snippet.source}\n`, sourcePath)
        .code.replaceAll('from "@mxlang/target-html"', 'from "./runtime.ts"')
        .replace(/(from\s+")(\.[^"]+)\.mx(")/g, "$1$2.ts$3");
      writeFileSync(sourcePath.replace(/\.mx$/, ".ts"), code);
    }
    const entry = join(dir, "App.ts");
    const module = (await import(
      `${pathToFileURL(entry).href}?t=${Date.now()}`
    )) as {
      default: (value: unknown) => string;
    };
    return module.default(input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let diagnosticSerial = 0;
function documentedError(callee: string | undefined, caller: string): string {
  const dir = mkdtempSync(
    join(tmpdir(), `mx-attr-doc-error-${diagnosticSerial++}-`),
  );
  try {
    const callerFile = join(dir, "Caller.mx");
    const source = callee
      ? `import Card from "./Card.mx"\n${caller}\n`
      : `${caller}\n`;
    if (callee) writeFileSync(join(dir, "Card.mx"), `${callee}\n`);
    try {
      compile(source, callerFile);
    } catch (error) {
      const message = (error as Error).message;
      const prefix = `${callerFile}: `;
      return message.startsWith(prefix)
        ? message.slice(prefix.length)
        : message;
    }
    throw new Error("expected the documented example to fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AttrTag documentation snippets on the HTML host", () => {
  it("extracts every marked example from the page", () => {
    const markdown = readFileSync(docsPath, "utf8");
    const exampleFences = [...markdown.matchAll(/^```(?:mx|tsx)$/gm)];
    expect(snippets()).toHaveLength(10);
    expect(snippets()).toHaveLength(exampleFences.length);
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

  it.each([
    [
      "control-flow mixing",
      "export interface Input { head?: AttrTag }\n<section/>",
      "<Card><if=input.ok><@head/> <p>x</p></if></Card>",
      "Cannot have attribute tags and body content under a control flow tag.",
    ],
    [
      "reserved content",
      "export interface Input { head?: AttrTag }\n<section/>",
      '<Card><@head content="x">H</@head></Card>',
      "`content` is reserved on an attribute tag; it names the body",
    ],
  ])("asserts the exact %s diagnostic", (_name, callee, caller, message) => {
    expect(documentedError(callee, caller)).toBe(message);
  });
});
