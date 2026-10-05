import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"),
);

describe("Manifest", () => {
  it("has correct engines", () => {
    expect(pkg.engines.vscode).toBeDefined();
  });

  it("has languages", () => {
    expect(pkg.contributes.languages.length).toBeGreaterThan(0);
    const mx = pkg.contributes.languages.find(
      (l: { id: string }) => l.id === "mx",
    );
    expect(mx.extensions).toContain(".mx");
    // MX only supports the MX 1.0 subset of Marko syntax, so a real .marko
    // file is not registered as this language's own extension.
    expect(mx.extensions).not.toContain(".marko");
  });

  it("orders solidmx before mx in language contributions", () => {
    // VS Code matches language extensions in contribution order.
    // solidmx must come before mx so that .solid.mx is not mistakenly matched as .mx
    const mxIndex = pkg.contributes.languages.findIndex(
      (l: { id: string }) => l.id === "mx",
    );
    const solidMxIndex = pkg.contributes.languages.findIndex(
      (l: { id: string }) => l.id === "solidmx",
    );
    expect(solidMxIndex).toBeLessThan(mxIndex);
  });

  it("orders reactmx before mx in language contributions", () => {
    // Same reasoning as solidmx: .react.mx must not be mistakenly matched as .mx
    const mxIndex = pkg.contributes.languages.findIndex(
      (l: { id: string }) => l.id === "mx",
    );
    const reactMxIndex = pkg.contributes.languages.findIndex(
      (l: { id: string }) => l.id === "reactmx",
    );
    expect(reactMxIndex).toBeGreaterThanOrEqual(0);
    expect(reactMxIndex).toBeLessThan(mxIndex);
  });

  it("gives reactmx a TSX grammar, activation and the language server", () => {
    const grammar = pkg.contributes.grammars.find(
      (g: { language: string }) => g.language === "reactmx",
    );
    const stub = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", grammar.path), "utf-8"),
    );
    expect(stub.scopeName).toBe("source.reactmx");
    expect(stub.patterns).toEqual([{ include: "source.tsx" }]);
    expect(pkg.activationEvents).toContain("onLanguage:reactmx");
    const source = fs.readFileSync(
      path.join(__dirname, "extension.ts"),
      "utf-8",
    );
    const selector = source.slice(source.indexOf("documentSelector"));
    expect(selector.slice(0, selector.indexOf("]"))).toContain(
      'language: "reactmx"',
    );
  });

  it("orders ngmx before mx in language contributions", () => {
    // Same reasoning as solidmx: .ng.mx must not be mistakenly matched as .mx
    const mxIndex = pkg.contributes.languages.findIndex(
      (l: { id: string }) => l.id === "mx",
    );
    const ngMxIndex = pkg.contributes.languages.findIndex(
      (l: { id: string }) => l.id === "ngmx",
    );
    expect(ngMxIndex).toBeLessThan(mxIndex);
  });

  it("references existing configuration", () => {
    for (const lang of pkg.contributes.languages) {
      if (lang.configuration) {
        const configPath = path.join(__dirname, "..", lang.configuration);
        expect(fs.existsSync(configPath)).toBe(true);
      }
    }
  });

  it("references existing grammars", () => {
    for (const grammar of pkg.contributes.grammars) {
      if (grammar.path) {
        const grammarPath = path.join(__dirname, "..", grammar.path);
        expect(fs.existsSync(grammarPath)).toBe(true);
      }
    }
  });

  it("contributes typescript plugin", () => {
    const tsPlugin = pkg.contributes.typescriptServerPlugins[0];
    expect(tsPlugin.name).toBe("@mxlang/typescript-plugin");
    expect(tsPlugin.languages).toContain("mx");
    expect(tsPlugin.languages).toContain("solidmx");
    expect(tsPlugin.languages).toContain("reactmx");
    expect(tsPlugin.languages).toContain("ngmx");
    expect(tsPlugin.languages).toContain("astromx");
  });

  it("keeps ngmx out of the language server client's document selector", () => {
    // The LS still throws "angular host not wired" for a .ng.mx (it routes it
    // as a page), so selecting ngmx would put that bogus error on every
    // .ng.mx. Drop this once the LS handles .ng.mx.
    const source = fs.readFileSync(
      path.join(__dirname, "extension.ts"),
      "utf-8",
    );
    const selector = source.slice(source.indexOf("documentSelector"));
    const block = selector.slice(0, selector.indexOf("]"));
    expect(block).toContain('language: "mx"');
    expect(block).not.toMatch(/language:\s*"ngmx"/);
  });
});
