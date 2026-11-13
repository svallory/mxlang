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
import { afterEach, expect, it, vi } from "vitest";
import { repoRoot } from "./test-support.ts";
import { type MemoryWatch, watchInMemory } from "./watch-memory.ts";

/**
 * A project whose `page.mx` imports `~/Card.mx` through tsconfig `paths`.
 * Unresolved, TypeScript cannot find the module (TS2307); resolved, the
 * callee's Input types the call, which writes a `tab` it lacks (TS2353).
 */
const CARD = "export interface Input { a?: string }\n<div/>\n";

let root: string | undefined;
let watcher: MemoryWatch | undefined;

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  vi.useRealTimers();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** Builds the project with `~/*` aliased to `<target>/*`; returns its helpers. */
function project(target: string) {
  root = mkdtempSync(join(tmpdir(), "mx-tsc-watch-paths-"));
  const dir = join(root, "project");
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
  mkdirSync(join(dir, "src"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ mx: { host: "html" } }),
  );
  writeFileSync(
    join(dir, "page.mx"),
    'import Card from "~/Card.mx"\n<Card><@tab/></Card>\n',
  );
  const config = (aliased: string) =>
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
            "~/*": [join(dir, aliased, "*")],
            "@mxlang/target-html": [
              join(repoRoot, "packages/targets/html/src/index.ts"),
            ],
          },
        },
        include: ["page.mx", "src"],
      }),
    );
  config(target);
  const watch = () => {
    watcher = watchInMemory(dir, ["-w", "-p", "tsconfig.json"], {
      advance: (ms) => {
        vi.advanceTimersByTime(ms);
        return new Promise<void>((resolve) => realSetImmediate(resolve));
      },
      clear: () => vi.clearAllTimers(),
    });
    return watcher;
  };
  return { dir, config, watch };
}

it("mx-tsc watch re-resolves a whole-file .mx callee after paths edits without editing the caller", async () => {
  const { dir, config, watch } = project("missing");
  writeFileSync(join(dir, "src/Card.mx"), CARD);
  const running = watch();
  expect(running.start()).toContain("TS2307");
  const resolved = await running.cycle(() => config("src"));
  expect(resolved).toContain("TS2353");
  expect(resolved).not.toContain("TS2307");
  const missing = await running.cycle(() => config("missing"));
  expect(missing).toContain("TS2307");
  expect(missing).not.toContain("TS2353");
}, 120_000);

it("mx-tsc watch resolves an aliased .mx callee created after the first build", async () => {
  const { dir, watch } = project("src");
  const running = watch();
  expect(running.start()).toContain("TS2307");
  const created = await running.cycle(() =>
    writeFileSync(join(dir, "src/Card.mx"), CARD),
  );
  expect(created).toContain("TS2353");
  expect(created).not.toContain("TS2307");
}, 120_000);

it("mx-tsc watch resolves an aliased .mx callee moved to the aliased path", async () => {
  const { dir, watch } = project("src");
  mkdirSync(join(dir, "old"));
  writeFileSync(join(dir, "old/Card.mx"), CARD);
  const running = watch();
  expect(running.start()).toContain("TS2307");
  const moved = await running.cycle(() =>
    renameSync(join(dir, "old/Card.mx"), join(dir, "src/Card.mx")),
  );
  expect(moved).toContain("TS2353");
  expect(moved).not.toContain("TS2307");
}, 120_000);
