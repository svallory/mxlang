/**
 * Attribute values on native elements, diffed live against Marko. One probe
 * subprocess per side (scripts/attribute-value-probe.ts), all started
 * concurrently, then the same checks run for Marko and for each host. Every
 * check is nested under its host's name, so a failure names the host.
 *
 * Two kinds of check per host:
 *  - the shared assertions on the host's own rows (Marko's pin, applied to
 *    Marko itself too), and
 *  - a diff of every host row against the Marko row of the same form and
 *    value, so the error text is Marko's by construction, not by restatement.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

interface RenderResult {
  form: string;
  value: string;
  html?: string;
  error?: string;
}

const execFileAsync = promisify(execFile);
const HOSTS = ["preact", "react", "hono", "solid", "astro"];
const rowsByHost: Record<string, RenderResult[]> = {};

beforeAll(async () => {
  const script = fileURLToPath(
    new URL("../../../scripts/attribute-value-probe.ts", import.meta.url),
  );
  await Promise.all(
    ["marko", ...HOSTS].map(async (host) => {
      const { stdout } = await execFileAsync("bun", [script, host], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      rowsByHost[host] = JSON.parse(stdout);
    }),
  );
  for (const host of Object.keys(rowsByHost))
    expect(rowsByHost[host]?.length, host).toBeGreaterThan(50);
}, 60_000); // Real host compilers/renderers in separate Bun processes.

function find(host: string, form: string, value: string): RenderResult {
  const row = rowsByHost[host]?.find(
    (entry) => entry.form === form && entry.value === value,
  );
  if (!row)
    throw new Error(`Missing real-render evidence: ${host}/${form}/${value}`);
  return row;
}

/** The Marko row a host row is diffed against. Marko has no `${input.tag}` forms; they diff against the same attribute written directly. */
const MARKO_FORM: Record<string, string> = {
  dynamic: "direct",
  dynamicArgs: "spread",
};

describe.each(["marko", ...HOSTS])("%s native attribute values", (host) => {
  const result = (form: string, value: string) => find(host, form, value);
  const jsx = host !== "marko" && host !== "astro";

  it("rejects functions and symbols with Marko's debug text", () => {
    const forms = [
      "direct",
      "spread",
      "folded",
      "colon",
      "foldedColon",
      "survivingSpread",
      ...(jsx ? ["dynamic", "dynamicArgs"] : []),
    ];
    for (const form of forms)
      for (const value of ["function", "symbol"]) {
        const name =
          form.includes("Colon") || form === "colon" ? "is:raw" : "data-x";
        expect(result(form, value).error, `${form}/${value}`).toBe(
          `The \`${name}\` attribute cannot be a ${value}.`,
        );
      }
  });
  it("rejects unrenderable objects with Marko's exact error on every native path", () => {
    const forms = [
      "direct",
      "spread",
      "folded",
      "colon",
      "foldedColon",
      "inputSpread",
      "survivingSpread",
      ...(jsx ? ["dynamic", "dynamicArgs"] : []),
    ];
    for (const form of forms)
      for (const value of ["plain", "nullproto"]) {
        const name =
          form === "colon" || form === "foldedColon" ? "is:raw" : "data-x";
        expect(result(form, value).error, `${form}/${value}`).toBe(
          `The \`${name}\` attribute cannot be a plain object (it would render as \`[object Object]\`).`,
        );
      }
  });
  it("accepts arrays, meaningful toString values, Dates, zero and null", () => {
    for (const form of ["direct", "spread", "folded"]) {
      for (const [value, expected] of [
        ["array", "1,2"],
        ["custom", "custom"],
        ["date", new Date("2020-01-01T00:00:00Z").toString()],
        ["zero", "0"],
      ] as const) {
        const row = result(form, value);
        expect(row.error, `${form}/${value}`).toBeUndefined();
        expect(row.html, `${form}/${value}`).toContain(expected);
      }
      expect(result(form, "null").error, `${form}/null`).toBeUndefined();
    }
  });
  it("validates only surviving merged values, evaluating authored getters once", () => {
    for (const form of ["overwritten", "overwrittenSpread", "overwrittenColon"])
      for (const value of ["plain", "nullproto"]) {
        expect(result(form, value).error, `${form}/${value}`).toBeUndefined();
        expect(result(form, value).html, `${form}/${value}`).toContain("safe");
      }
    expect(result("once", "getter").html).toContain("once");
    expect(result("reads", "getter").html).toBe("1");
    // React's development renderer performs its own extra coercion check.
    const count = host === "react" ? "3" : "2";
    for (const form of ["coercion", "coercionSpread"]) {
      expect(result(form, "custom").html, form).toContain("second");
      expect(result(`${form}Count`, "custom").html, form).toBe(count);
    }
  });
  it("does not reject class/style objects or controlled values", () => {
    const structured = result("structured", "plain");
    expect(structured.error).toBeUndefined();
    const cls = /class=(?:"([^"]*)"|([^\s>]+))/.exec(structured.html ?? "");
    expect((cls?.[1] ?? cls?.[2])?.trim()).toBe("a");
    expect(structured.html).toContain("color:red");
    for (const form of [
      "classAcrossSpread",
      "spreadStructured",
      "checked",
      "open",
      "selectValue",
    ])
      expect(result(form, "plain").error, form).toBeUndefined();
  });
  if (host !== "astro")
    it("guards attribute-tag fields when a dynamic target is native", () => {
      expect(result("dynamicDataTag", "plain").error).toBe(
        "The `meta` attribute cannot be a plain object (it would render as `[object Object]`).",
      );
    });
  if (jsx)
    it("keeps object-valued component props out of the native attribute guard", () => {
      expect(result("component", "plain").error).toBeUndefined();
      expect(result("component", "plain").html).toContain("1");
    });

  if (host !== "marko")
    it("matches Marko row for row", () => {
      for (const row of rowsByHost[host] ?? []) {
        const marko = rowsByHost.marko?.find(
          (entry) =>
            entry.form === (MARKO_FORM[row.form] ?? row.form) &&
            entry.value === row.value,
        );
        // Host-only forms (`component`) and counts are asserted above.
        if (!marko || row.form.endsWith("Count") || row.form === "reads")
          continue;
        expect(row.error, `${row.form}/${row.value}`).toBe(marko.error);
      }
    });
});
