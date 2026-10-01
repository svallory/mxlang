import { describe, expect, it } from "vitest";
import { serverNode } from "./ls-smoke.mts";

describe("serverNode (which Node runs the server)", () => {
  it("defaults to node on PATH", () => {
    expect(serverNode({})).toBe("node");
  });

  it("uses MX_LS_NODE", () => {
    expect(serverNode({ MX_LS_NODE: "/opt/node20/bin/node" })).toBe(
      "/opt/node20/bin/node",
    );
  });

  it("fails closed on a set but empty MX_LS_NODE (an unset CI variable)", () => {
    expect(() => serverNode({ MX_LS_NODE: "" })).toThrow(/set but empty/);
  });

  it("fails when the Node is not the expected version", () => {
    expect(() =>
      serverNode(
        { MX_LS_NODE: "/n", MX_LS_NODE_EXPECT: "v20.9.0" },
        () => "v26.7.0",
      ),
    ).toThrow(/v26\.7\.0, expected v20\.9\.0/);
  });

  it("passes when the version matches", () => {
    expect(
      serverNode(
        { MX_LS_NODE: "/n", MX_LS_NODE_EXPECT: "v20.9.0" },
        () => "v20.9.0",
      ),
    ).toBe("/n");
  });
});
