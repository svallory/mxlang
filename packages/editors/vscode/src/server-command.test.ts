import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerCommand } from "./server-command.js";

vi.mock("fs");
vi.mock("child_process");

describe("getServerCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses configured path if provided", () => {
    const cmd = getServerCommand("/custom/path/bin", []);
    expect("command" in cmd && cmd.command).toBe("/custom/path/bin");
  });

  it("prefers the configured path over a present bundle", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const cmd = getServerCommand(
      "/custom/path/bin",
      ["/workspace"],
      "/ext/bin.cjs",
    );
    expect(cmd).toEqual({ command: "/custom/path/bin", args: ["--stdio"] });
  });

  it("runs the bundled server as a node module when present, with no bunx/npx/global lookup", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => p === "/ext/bin.cjs");
    const execSync = vi.spyOn(child_process, "execSync");
    const cmd = getServerCommand(undefined, ["/workspace"], "/ext/bin.cjs");
    expect(cmd).toEqual({ module: "/ext/bin.cjs" });
    expect(execSync).not.toHaveBeenCalled();
  });

  it("prefers the bundle over a workspace install", () => {
    // Every path exists, including the workspace marker: the bundle still wins.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const cmd = getServerCommand(undefined, ["/workspace"], "/ext/bin.cjs");
    expect(cmd).toEqual({ module: "/ext/bin.cjs" });
  });

  it("treats an empty configured path as unset", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => p === "/ext/bin.cjs");
    expect(getServerCommand("", [], "/ext/bin.cjs")).toEqual({
      module: "/ext/bin.cjs",
    });
  });

  it("falls back to the workspace install when the bundle file is missing", () => {
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(fs, "existsSync").mockImplementation((p: any) =>
      p.includes(path.join("@mxlang", "language-server", "package.json")),
    );
    const cmd = getServerCommand(undefined, ["/workspace"], "/ext/bin.cjs");
    expect("command" in cmd && cmd.command).toContain(
      path.join("/workspace", "node_modules", ".bin"),
    );
  });

  it("throws when nothing resolves, bundle path given but absent", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((_cmd: any) => {
      throw new Error();
    });
    expect(() => getServerCommand(undefined, [], "/ext/bin.cjs")).toThrow(
      "could not find mxlang-language-server",
    );
  });

  it("uses local install if marker exists", () => {
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      return p.includes(
        path.join("@mxlang", "language-server", "package.json"),
      );
    });
    const cmd = getServerCommand(undefined, ["/workspace"]);
    const expectedBinName =
      process.platform === "win32"
        ? "mxlang-language-server.cmd"
        : "mxlang-language-server";
    expect("command" in cmd && cmd.command).toBe(
      path.join("/workspace", "node_modules", ".bin", expectedBinName),
    );
  });

  it("uses global install if found", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((cmd: any) => {
      if (cmd.includes("mxlang-language-server"))
        return "/global/mxlang-language-server";
      throw new Error();
    });

    const cmd = getServerCommand(undefined, ["/workspace"]);
    expect("command" in cmd && cmd.command).toBe(
      "/global/mxlang-language-server",
    );
  });

  it("falls back to bunx", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((cmd: any) => {
      if (cmd.includes("bunx")) return "/usr/local/bin/bunx";
      throw new Error();
    });

    const cmd = getServerCommand(undefined, ["/workspace"]);
    expect("command" in cmd && cmd.command).toBe("/usr/local/bin/bunx");
    expect("args" in cmd && cmd.args).toEqual([
      "@mxlang/language-server",
      "--stdio",
    ]);
  });

  it("falls back to npx", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((cmd: any) => {
      if (cmd.includes("npx")) return "/usr/local/bin/npx";
      throw new Error();
    });

    const cmd = getServerCommand(undefined, ["/workspace"]);
    expect("command" in cmd && cmd.command).toBe("/usr/local/bin/npx");
    expect("args" in cmd && cmd.args).toEqual([
      "@mxlang/language-server",
      "--stdio",
    ]);
  });

  it("throws if resolution fails entirely", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    // biome-ignore lint/suspicious/noExplicitAny: reason
    vi.spyOn(child_process, "execSync").mockImplementation((_cmd: any) => {
      throw new Error();
    });

    expect(() => getServerCommand(undefined, [])).toThrow(
      "could not find mxlang-language-server",
    );
  });
});
