import {
  mkdirSync,
  mkdtempSync,
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
    // Unresolved, TypeScript cannot find the module (TS2307); resolved, the
    // callee's Input types the call, which writes a `tab` it lacks (TS2353).
    expect(watcher.start()).toContain("TS2307");
    const resolved = await watcher.cycle(() => config("src"));
    expect(resolved).toContain("TS2353");
    expect(resolved).not.toContain("TS2307");
    const missing = await watcher.cycle(() => config("missing"));
    expect(missing).toContain("TS2307");
    expect(missing).not.toContain("TS2353");
  } finally {
    watcher?.stop();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
