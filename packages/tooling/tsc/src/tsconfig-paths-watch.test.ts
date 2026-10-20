import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as realSetImmediate } from "node:timers";
import { expect, it, vi } from "vitest";
import { repoRoot } from "./test-support.ts";
import { type MemoryWatch, watchInMemory } from "./watch-memory.ts";

it("mx-tsc watch re-resolves a whole-file .mx callee after paths edits without editing the caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "mx-tsc-watch-paths-"));
  const dir = join(root, "project");
  let watcher: MemoryWatch | undefined;
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
    ],
  });
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ mx: { host: "html" } }),
    );
    writeFileSync(
      join(dir, "src/Card.mx"),
      "export interface Input { a?: string }\n<div/>\n",
    );
    writeFileSync(
      join(dir, "page.mx"),
      'import Card from "~/Card.mx"\n<Card><@tab/></Card>\n',
    );
    const config = (target: string) =>
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: "esnext",
            module: "esnext",
            moduleResolution: "bundler",
            jsx: "preserve",
            types: [],
            allowImportingTsExtensions: true,
            paths: {
              "~/*": [join(dir, target, "*")],
              "@mxlang/target-html": [
                join(repoRoot, "packages/targets/html/src/index.ts"),
              ],
            },
          },
          include: ["page.mx", "src"],
        }),
      );
    config("missing");
    watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], {
      advance: (ms) => {
        vi.advanceTimersByTime(ms);
        return new Promise<void>((resolve) => realSetImmediate(resolve));
      },
      clear: () => vi.clearAllTimers(),
    });
    expect(watcher.start()).toContain("MX_UNREADABLE_CALLEE_INPUT");
    const resolved = await watcher.cycle(() => config("src"));
    expect(resolved).toContain("MX_UNKNOWN_ATTRIBUTE_TAG");
    expect(resolved).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
    const missing = await watcher.cycle(() => config("missing"));
    expect(missing).toContain("MX_UNREADABLE_CALLEE_INPUT");
    expect(missing).not.toContain("MX_UNKNOWN_ATTRIBUTE_TAG");
  } finally {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it.each([
  { specifier: "~/Card.mx", change: "create-after-miss" },
  { specifier: "~/Card", change: "create-after-miss" },
  { specifier: "~/Card.mx", change: "move-after-hit" },
  { specifier: "~/Card", change: "move-after-hit" },
])(
  "mx-tsc watch refreshes $specifier after $change with unchanged root names and options",
  async ({ specifier, change }) => {
    const dir = mkdtempSync(join(tmpdir(), "mx-tsc-watch-files-"));
    let watcher: MemoryWatch | undefined;
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
      ],
    });
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "lib"));
      symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ mx: { host: "html" } }),
      );
      const callee = join(dir, "src/Card.mx");
      const source = "export interface Input { a?: string }\n<div/>\n";
      if (change === "move-after-hit") writeFileSync(callee, source);
      const page = join(dir, "page.mx");
      const text = `import Card from "${specifier}"\n<Card><@tab/></Card>\n`;
      writeFileSync(page, text);
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: "esnext",
            module: "esnext",
            moduleResolution: "bundler",
            jsx: "preserve",
            types: [],
            allowImportingTsExtensions: true,
            paths: {
              "~/*": [join(dir, "src/*"), join(dir, "lib/*")],
              "@mxlang/target-html": [
                join(repoRoot, "packages/targets/html/src/index.ts"),
              ],
            },
          },
          // Creating a callee must not replace programOptions by changing roots.
          files: ["page.mx"],
        }),
      );
      watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], {
        advance: (ms) => {
          vi.advanceTimersByTime(ms);
          return new Promise<void>((resolve) => realSetImmediate(resolve));
        },
        clear: () => vi.clearAllTimers(),
      });
      const before = watcher.start();
      expect(before).toContain(
        change === "create-after-miss"
          ? "MX_UNREADABLE_CALLEE_INPUT"
          : "MX_UNKNOWN_ATTRIBUTE_TAG",
      );
      const after = await watcher.cycle(() => {
        if (change === "create-after-miss") writeFileSync(callee, source);
        else renameSync(callee, join(dir, "lib/Card.mx"));
        writeFileSync(page, `${text}\n`);
      });
      expect(after).toContain("MX_UNKNOWN_ATTRIBUTE_TAG");
      expect(after).not.toContain("MX_UNREADABLE_CALLEE_INPUT");
      // Volar's failed TypeScript-module lookup can retain TS2307 after a
      // create; this test checks core's callee Input read, not that cache.
    } finally {
      watcher?.stop();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
