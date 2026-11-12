import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import mx, { MX_SUFFIX } from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it.each(["bogus", "html", "@acme/target", "data"])(
  "%s fails every transform via this.error at package.json, with a frame",
  async (target) => {
    const root = mkdtempSync(join(tmpdir(), "mx-vite-target-"));
    roots.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ mx: { host: "solid", target } }, null, 2),
    );
    const plugin = mx() as unknown as {
      transform: (
        this: unknown,
        source: string,
        id: string,
      ) => Promise<unknown>;
    };
    const warn = vi.fn();
    const error = vi.fn((cause: Error) => {
      throw cause;
    });
    for (let i = 0; i < 2; i++) {
      await expect(
        plugin.transform.call(
          { warn, error },
          "<p>ok</p>",
          join(root, "page.mx") + MX_SUFFIX,
        ),
      ).rejects.toMatchObject({
        id: join(root, "package.json"),
        loc: { file: join(root, "package.json"), line: 4, column: 14 },
        frame: expect.stringContaining('"target"'),
      });
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  },
);

it("compiles strict under a loaded target whose descriptor declares strict: always", async () => {
  // The descriptor comes from a package specifier under `mx.target`, so it is
  // carried in the policy, not held by the built-in registry.
  const root = mkdtempSync(join(tmpdir(), "mx-vite-loaded-strict-"));
  roots.push(root);
  const pkg = join(root, "node_modules", "@fake", "mx-strict");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@fake/mx-strict", main: "index.cjs" }),
  );
  writeFileSync(
    join(pkg, "index.cjs"),
    `module.exports = {
  descriptorVersion: 0,
  name: "fake-strict",
  packageName: "@fake/mx-strict",
  defaultTag: "div",
  strict: "always",
  load: () => ({
    compileModule: (_s, _f, options) => ({
      code: "export default " + JSON.stringify({ strict: options.strict }) + ";",
      dependencies: [],
    }),
  }),
};
`,
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ mx: { target: "@fake/mx-strict" } }),
  );
  const plugin = mx() as unknown as {
    transform: (
      this: unknown,
      source: string,
      id: string,
    ) => Promise<{ code: string }>;
  };
  const result = await plugin.transform.call(
    { warn: vi.fn(), error: vi.fn() },
    "<p/>\n",
    join(root, "page.mx") + MX_SUFFIX,
  );
  expect(result.code).toContain('{"strict":true}');
});
