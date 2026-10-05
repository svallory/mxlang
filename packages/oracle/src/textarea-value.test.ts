/**
 * `<textarea value=x/>` renders the value as escaped content, as Marko 6.3.51
 * does (decision 149). Real renders of both sides in separate Bun processes
 * (scripts/attribute-value-probe.ts --textarea), compared as parsed DOM: the
 * html target's text escaping is broader than Marko's (`&gt;`, `&quot;`), and
 * the HTML parser drops a textarea's first newline, so the DOM is the contract.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFragment } from "parse5";
import { beforeAll, describe, expect, it } from "vitest";

interface Row {
  form: string;
  value: string;
  html?: string;
  error?: string;
}

function rows(host: string): Row[] {
  return JSON.parse(
    execFileSync(
      "bun",
      [
        fileURLToPath(
          new URL("../../../scripts/attribute-value-probe.ts", import.meta.url),
        ),
        host,
        "--textarea",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
}

interface Node5 {
  nodeName: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node5[];
  value?: string;
}

/** Every `<textarea>` in the markup as `{ attrs, text }` JSON, or the error. */
function textareas(row: Row | undefined): string {
  if (!row) return "MISSING";
  if (row.error !== undefined) return "ERROR";
  const found: string[] = [];
  const walk = (node: Node5): void => {
    if (node.nodeName === "textarea") {
      found.push(
        JSON.stringify({
          attrs: Object.fromEntries(
            (node.attrs ?? []).map((a) => [a.name, a.value]).sort(),
          ),
          text: (node.childNodes ?? []).map((c) => c.value ?? "").join(""),
        }),
      );
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parseFragment(row.html ?? "") as unknown as Node5);
  return found.join("|") || "NO-TEXTAREA";
}

let marko: Row[] = [];
let html: Row[] = [];
beforeAll(() => {
  marko = rows("marko");
  html = rows("html");
  expect(marko.length).toBeGreaterThan(100);
}, 60_000); // Real compiler/renderer startup in separate Bun processes.

const find = (list: Row[], form: string, value: string) =>
  list.find((r) => r.form === form && r.value === value);

describe("html target <textarea value> (real renders, Marko 6.3.51)", () => {
  // Marko 6.3.51, measured: value as escaped content, nothing for
  // null/undefined/false/true, `0` kept, a leading newline doubled.
  it.each([
    ["dynamic", "zero", "0"],
    ["dynamic", "empty", ""],
    ["dynamic", "null", ""],
    ["dynamic", "undefined", ""],
    ["dynamic", "false", ""],
    ["dynamic", "true", ""],
    ["dynamic", "str", "hello"],
    ["dynamic", "special", "a<b>&\"'c"],
    ["dynamic", "newline", "\nx"],
    ["static", "str", "abc"],
    ["dynamicOthers", "str", "hello"],
    ["spread", "zero", "0"],
    ["spread", "null", ""],
    ["spreadBody", "str", "x"],
    ["bodyOnly", "str", "hi & <b>"],
    ["spreadThenValue", "str", "hello"],
    ["valueThenSpread", "str", "hello"],
    ["valueBetweenSpreads", "str", "hello"],
    ["dynamicTag", "zero", "0"],
    ["dynamicTag", "null", ""],
    ["dynamicTagArgs", "special", "a<b>&\"'c"],
  ])("%s / %s renders content %j on html", (form, value, text) => {
    const dom = JSON.parse(
      textareas(find(html, form, value)).split("|")[0] ?? "",
    );
    expect(dom.text).toBe(text);
    expect(dom.attrs.value).toBeUndefined();
  });

  it("matches Marko's parsed DOM for every measured case", () => {
    const diffs = marko
      .filter((m) => m.form !== "valueAndBody")
      .filter((m) => textareas(m) !== textareas(find(html, m.form, m.value)))
      .map((m) => `${m.form}/${m.value}`);
    expect(diffs).toEqual([]);
  });

  it("refuses a value together with body content, as Marko does", () => {
    for (const row of marko.filter((r) => r.form === "valueAndBody"))
      expect(row.error, `marko ${row.value}`).toBeDefined();
    for (const row of html.filter((r) => r.form === "valueAndBody"))
      expect(row.error, `html ${row.value}`).toContain(
        "A textarea cannot have both a value attribute and body content.",
      );
  });

  it("a spread's value yields to the body, as in Marko", () => {
    for (const value of ["zero", "str", "special"]) {
      expect(textareas(find(html, "spreadBody", value))).toBe(
        textareas(find(marko, "spreadBody", value)),
      );
    }
  });
});
