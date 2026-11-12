import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtinTargets } from "./index.ts";

/**
 * `@mxlang/target-html`'s Bun loader cannot import this registry, so it keeps
 * a hand list of the hosts whose target is always strict. Every such host
 * outside html itself must be on it, or the loader and the other tools
 * disagree on that host's projects.
 */
it("the html Bun loader lists every built-in host whose target is always strict", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../targets/html/src/bun.ts"),
    "utf8",
  );
  const listed = /FOREIGN_STRICT_HOSTS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1];
  const hosts = [...(listed ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const strictHosts = builtinTargets
    .filter((t) => t.strict === "always" && t.host && t.name !== "html")
    .map((t) => t.host?.name);
  expect(strictHosts.length).toBeGreaterThan(0);
  expect(hosts.sort()).toEqual([...new Set(strictHosts)].sort());
});
