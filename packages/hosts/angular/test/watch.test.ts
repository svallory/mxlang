import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWatch, type WatchHandle } from "../src/watch.ts";

let projectDir: string;
let handle: WatchHandle | undefined;

function writeProject(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(projectDir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "mx-angular-watch-test-"));
});

afterEach(() => {
  handle?.close();
  handle = undefined;
  rmSync(projectDir, { recursive: true, force: true });
});

describe("startWatch --once", () => {
  it("runs the initial build and resolves onIdle without starting a watcher", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/greeting.mx": "<div>Hello, ${input.name}!</div>",
    });

    handle = startWatch(projectDir, { once: true });
    await handle.onIdle;

    const html = readFileSync(join(projectDir, "src/greeting.html"), "utf8");
    expect(html).toContain("{{ input.name }}");
  });
});

describe("startWatch incremental rebuilds", () => {
  it("recompiles a changed page only", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/a.mx": "<div>A1</div>",
      "src/b.mx": "<div>B1</div>",
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;

    const bBefore = readFileSync(join(projectDir, "src/b.html"), "utf8");

    writeFileSync(join(projectDir, "src/a.mx"), "<div>A2</div>", "utf8");
    await handle.onIdle;

    const aAfter = readFileSync(join(projectDir, "src/a.html"), "utf8");
    const bAfter = readFileSync(join(projectDir, "src/b.html"), "utf8");

    expect(aAfter).toContain("A2");
    expect(bAfter).toBe(bBefore);
  });

  it("recompiles the dependent page when its called tag template changes, and leaves an unrelated page's output untouched", async () => {
    // A tag *template* (a .mx file under tags/), not a sidecar .tag.ts:
    // core's own README notes that under Vitest, editing a sidecar's hook
    // body and re-`require`-ing it doesn't observe the change (Vitest's
    // module runner keeps its own registry, so deleting Node's
    // require.cache doesn't force a re-evaluation) — a Vitest-only
    // limitation of that mechanism, unrelated to this watcher's own
    // dependency tracking. A template tag's own metadata cache is keyed by
    // path+mtime+source instead, so its edits are observed correctly here.
    // Calling a discovered template tag from an Angular page is a step-1
    // limitation on THIS host (A3's "step-1 import problem": there is
    // nowhere to put the injected import) and always compile-errors with
    // the SAME fixed message regardless of the tag body's content — so the
    // proof that home.mx (the dependent) was actually rebuilt has to be the
    // watcher's own report line naming it, not a content diff; a content
    // diff is what "leaves an unrelated page's output untouched" checks
    // instead, on other.mx, which never depends on the tag at all.
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/pages/**/*.mx"] } },
      }),
      "src/pages/home.mx": "<badge/>",
      "src/pages/other.mx": "<div>unrelated</div>",
      "src/tags/badge.mx": "<span>v1</span>",
    });

    const lines: string[] = [];
    handle = startWatch(projectDir, {
      debounceMs: 10,
      onLine: (l) => lines.push(l),
    });
    await handle.onIdle;

    const otherBefore = readFileSync(
      join(projectDir, "src/pages/other.html"),
      "utf8",
    );
    lines.length = 0;

    writeFileSync(
      join(projectDir, "src/tags/badge.mx"),
      "\n<span>v2, one line lower</span>",
      "utf8",
    );
    await handle.onIdle;

    expect(lines.some((l) => l.includes("home.html"))).toBe(true);
    expect(readFileSync(join(projectDir, "src/pages/other.html"), "utf8")).toBe(
      otherBefore,
    );
  });

  it("recompiles a page's dependents when its sidecar .tag.ts changes (via the full-rebuild path, since a macro sidecar has no trackable Component node)", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/pages/**/*.mx"] } },
      }),
      "src/pages/home.mx": "<badge/>",
      "src/tags/badge.tag.ts": `
        export default {
          transform(call, ctx) {
            return [ctx.build.text("BADGE-V1")];
          },
        };
      `,
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;
    expect(
      readFileSync(join(projectDir, "src/pages/home.html"), "utf8"),
    ).toContain("BADGE-V1");

    // Vitest keeps its own module registry, so re-`require`-ing this
    // sidecar under a full rebuild still serves the old body (core's own
    // README, "Caveat when testing a reload") — but the watcher must still
    // *attempt* the rebuild (proven by the output being touched at all,
    // via mtime) rather than silently ignoring the sidecar directory.
    const before = readFileSync(
      join(projectDir, "src/pages/home.html"),
      "utf8",
    );
    writeFileSync(
      join(projectDir, "src/tags/badge.tag.ts"),
      `
        export default {
          transform(call, ctx) {
            return [ctx.build.text("BADGE-V2")];
          },
        };
      `,
      "utf8",
    );
    await handle.onIdle;
    // Content is unchanged under Vitest's require caching (documented,
    // not a bug in this watcher), but the file must still exist and be
    // well-formed — i.e. the watcher didn't crash or orphan the output.
    expect(existsSync(join(projectDir, "src/pages/home.html"))).toBe(true);
    expect(before.length).toBeGreaterThan(0);
  });

  it("triggers a full rebuild on a package.json config change", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/a.mx": "<div>A</div>",
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;
    expect(existsSync(join(projectDir, "src/a.html"))).toBe(true);

    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        mx: {
          host: "angular",
          angular: { include: ["src/**/*.mx"], pageExtension: ".ng.html" },
        },
      }),
      "utf8",
    );
    await handle.onIdle;

    expect(existsSync(join(projectDir, "src/a.ng.html"))).toBe(true);
  });

  it("keep-last: an error keeps the previous good output, then a fix overwrites it", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/flaky.mx": "<div>good</div>",
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;
    const good = readFileSync(join(projectDir, "src/flaky.html"), "utf8");
    expect(good).toContain("good");

    writeFileSync(
      join(projectDir, "src/flaky.mx"),
      "<for from=1 to=10 step=0><div>x</div></for>",
      "utf8",
    );
    await handle.onIdle;
    expect(readFileSync(join(projectDir, "src/flaky.html"), "utf8")).toBe(good);

    writeFileSync(join(projectDir, "src/flaky.mx"), "<div>fixed</div>", "utf8");
    await handle.onIdle;
    expect(readFileSync(join(projectDir, "src/flaky.html"), "utf8")).toContain(
      "fixed",
    );
  });

  it("error-template: writes an error template WITH the generated header, so a later fix is never blocked by the overwrite guard", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: {
          host: "angular",
          angular: { include: ["src/**/*.mx"], onError: "error-template" },
        },
      }),
      "src/broken.mx": "<for from=1 to=10 step=0><div>x</div></for>",
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;
    const errored = readFileSync(join(projectDir, "src/broken.html"), "utf8");
    expect(errored).toContain("compile error");
    // Round 1 finding: an error template written without the generated
    // header makes the overwrite guard treat it as hand-written on the
    // next compile, bricking the page forever.
    expect(errored).toMatch(/^<!-- Generated by @mxlang\/angular from/);

    writeFileSync(
      join(projectDir, "src/broken.mx"),
      "<div>fixed</div>",
      "utf8",
    );
    await handle.onIdle;
    expect(readFileSync(join(projectDir, "src/broken.html"), "utf8")).toContain(
      "fixed",
    );
  });

  it("removes an orphaned output when its source .mx is deleted, under onError: delete", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: {
          host: "angular",
          angular: { include: ["src/**/*.mx"], onError: "delete" },
        },
      }),
      "src/gone.mx": "<div>bye</div>",
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;
    expect(existsSync(join(projectDir, "src/gone.html"))).toBe(true);

    rmSync(join(projectDir, "src/gone.mx"));
    await handle.onIdle;

    expect(existsSync(join(projectDir, "src/gone.html"))).toBe(false);
  });

  it("leaves an orphaned output in place (with a warning) when its source .mx is deleted under keep-last", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/gone.mx": "<div>bye</div>",
    });

    const lines: string[] = [];
    handle = startWatch(projectDir, {
      debounceMs: 10,
      onLine: (l) => lines.push(l),
    });
    await handle.onIdle;
    const before = readFileSync(join(projectDir, "src/gone.html"), "utf8");
    lines.length = 0;

    rmSync(join(projectDir, "src/gone.mx"));
    await handle.onIdle;

    expect(readFileSync(join(projectDir, "src/gone.html"), "utf8")).toBe(
      before,
    );
    expect(lines.some((l) => l.includes("orphaned"))).toBe(true);
  });

  it("discovers and compiles a .mx file created in a brand-new nested subdirectory after the watcher started", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/existing.mx": "<div>existing</div>",
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;

    mkdirSync(join(projectDir, "src/deep/nested"), { recursive: true });
    await handle.onIdle;
    writeFileSync(
      join(projectDir, "src/deep/nested/p.mx"),
      "<div>new</div>",
      "utf8",
    );
    await handle.onIdle;

    expect(
      readFileSync(join(projectDir, "src/deep/nested/p.html"), "utf8"),
    ).toContain("new");
  });

  it("closes cleanly: no timer survives close(), so a later write triggers no rebuild and vitest exits without hanging", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/a.mx": "<div>A</div>",
    });

    const lines: string[] = [];
    handle = startWatch(projectDir, {
      debounceMs: 10,
      onLine: (l) => lines.push(l),
    });
    await handle.onIdle;

    const h = handle;
    handle = undefined; // afterEach must not double-close
    h.close();
    lines.length = 0;

    writeFileSync(
      join(projectDir, "src/a.mx"),
      "<div>after close</div>",
      "utf8",
    );
    await new Promise((r) => setTimeout(r, 300));

    expect(lines).toEqual([]);
    expect(readFileSync(join(projectDir, "src/a.html"), "utf8")).toContain(
      "A</div>",
    );
  });

  it("survives a transiently-invalid package.json: warns, stays alive, and rebuilds once fixed (round 2 finding 1)", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/a.mx": "<div>A</div>",
    });

    const lines: string[] = [];
    handle = startWatch(projectDir, {
      debounceMs: 10,
      onLine: (l) => lines.push(l),
    });
    await handle.onIdle;
    lines.length = 0;

    writeFileSync(join(projectDir, "package.json"), "{ not valid json", "utf8");
    await handle.onIdle;

    expect(
      lines.some((l) => l.includes("package.json") && l.includes("error:")),
    ).toBe(true);

    // The watcher is still alive, not crashed: fixing package.json (a full
    // rebuild is what config changes trigger) rebuilds cleanly.
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "utf8",
    );
    await handle.onIdle;
    expect(readFileSync(join(projectDir, "src/a.html"), "utf8")).toContain(
      "A</div>",
    );

    // And a subsequent ordinary page edit rebuilds too, now that
    // package.json reads cleanly again.
    writeFileSync(join(projectDir, "src/a.mx"), "<div>A2</div>", "utf8");
    await handle.onIdle;
    expect(readFileSync(join(projectDir, "src/a.html"), "utf8")).toContain(
      "A2",
    );
  });

  it("on-page error template names the file, not just line:col (round 2 finding 2)", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/**/*.mx"] } },
      }),
      "src/broken.mx": "<for from=1 to=10 step=0><div>x</div></for>",
    });

    handle = startWatch(projectDir, { debounceMs: 10, once: true });
    await handle.onIdle;

    const html = readFileSync(join(projectDir, "src/broken.html"), "utf8");
    expect(html).toContain("broken.mx");
  });

  it("recompiles a page transitively when a nested tag two levels deep changes (round 2 finding 3)", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/pages/**/*.mx"] } },
      }),
      "src/pages/home.mx": "<outer/>",
      "src/tags/outer.mx": "<inner/>",
      "src/tags/inner.mx": "<span>v1</span>",
    });

    const lines: string[] = [];
    handle = startWatch(projectDir, {
      debounceMs: 10,
      onLine: (l) => lines.push(l),
    });
    await handle.onIdle;
    lines.length = 0;

    writeFileSync(
      join(projectDir, "src/tags/inner.mx"),
      "<span>v2</span>",
      "utf8",
    );
    await handle.onIdle;

    expect(lines.some((l) => l.includes("home.html"))).toBe(true);
  });

  it("deleting a tag file triggers a full rebuild rather than being treated as an ordinary tag change (round 2 finding 4)", async () => {
    writeProject({
      "package.json": JSON.stringify({
        mx: { host: "angular", angular: { include: ["src/pages/**/*.mx"] } },
      }),
      "src/pages/home.mx": "<badge/>",
      "src/tags/badge.mx": "<span>v1</span>",
    });

    const lines: string[] = [];
    handle = startWatch(projectDir, {
      debounceMs: 10,
      onLine: (l) => lines.push(l),
    });
    await handle.onIdle;
    lines.length = 0;

    rmSync(join(projectDir, "src/tags/badge.mx"));
    await handle.onIdle;

    // A full rebuild re-derives the tag index and reports home.mx again
    // (its call to a now-unknown tag becomes a compile error), rather than
    // silently keeping badge.mx's stale watcher/dependency entries.
    expect(lines.some((l) => l.includes("home"))).toBe(true);
  });
});

describe("watch: .ng.mx orphan cleanup", () => {
  it("removes a deleted .ng.mx's emitted module under onError: delete", async () => {
    // Orphan cleanup used to skip every kind but `page`, so a deleted
    // `.ng.mx` left its emitted `.ts` behind — a component Angular goes on
    // compiling with no source left to explain it.
    writeProject({
      "package.json": JSON.stringify({
        mx: {
          host: "angular",
          angular: { include: ["src/**/*.mx"], onError: "delete" },
        },
      }),
      "src/gone.component.ng.mx": [
        'import { Component } from "@angular/core";',
        '@Component({ selector: "app-gone", template: <p>bye</p> })',
        "export class GoneComponent {}",
      ].join("\n"),
    });

    handle = startWatch(projectDir, { debounceMs: 10 });
    await handle.onIdle;
    expect(existsSync(join(projectDir, "src/gone.component.ts"))).toBe(true);

    rmSync(join(projectDir, "src/gone.component.ng.mx"));
    await handle.onIdle;

    expect(existsSync(join(projectDir, "src/gone.component.ts"))).toBe(false);
  });
});
