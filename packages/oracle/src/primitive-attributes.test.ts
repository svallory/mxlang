/**
 * Primitive attribute values on native elements render as Marko 6.3.51's html
 * output does, on preact, react and hono (decision 149). Real renders of every
 * side in separate Bun processes (scripts/attribute-value-probe.ts --parity),
 * compared as parsed DOM, over 8 attributes x 4 forms x 7 values.
 *
 * Documented divergences, pinned here rather than skipped:
 *  - React prints a boolean property as presence only (`disabled=""` where
 *    Marko prints `disabled="0"`), so those cells compare presence.
 *  - React cannot render a string `style` (`true`/"x"): it throws its own error.
 *  - A direct `style=expr` with a non-object expression is a compile error on
 *    every JSX host (the object-literal rule), so those forms are not cells.
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
interface Node5 {
  nodeName: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node5[];
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
        "--parity",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
}

const BOOLEAN = new Set(["disabled", "checked", "hidden"]);

/** The rendered elements as canonical JSON; `presence` drops boolean values. */
function dom(row: Row | undefined, presence: boolean): string {
  if (!row) return "MISSING";
  if (row.error !== undefined) return `ERROR:${row.error}`;
  const out: string[] = [];
  const walk = (node: Node5): void => {
    if (!node.nodeName.startsWith("#") && node.nodeName !== "script") {
      const attrs = (node.attrs ?? []).map((a): [string, string] => [
        a.name,
        presence && BOOLEAN.has(a.name) ? "" : a.value,
      ]);
      out.push(
        `${node.nodeName}${JSON.stringify(Object.fromEntries(attrs.sort()))}`,
      );
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(
    parseFragment(
      (row.html ?? "").replace(/<!--M_\$[\s\S]*?<\/script>\s*/g, ""),
    ) as unknown as Node5,
  );
  return out.join("");
}

const attributes = [
  "title",
  "data-x",
  "aria-x",
  "class",
  "style",
  "disabled",
  "checked",
  "value",
];
const forms = ["direct", "spread", "merged", "mergedBefore"];
const values = ["null", "undefined", "false", "true", "zero", "empty", "x"];

let marko: Row[] = [];
const hosts: Record<string, Row[]> = {};
beforeAll(() => {
  marko = rows("marko");
  for (const host of ["preact", "react", "hono"]) hosts[host] = rows(host);
  expect(marko.length).toBe(attributes.length * forms.length * values.length);
}, 120_000); // Real compilers and renderers in separate Bun processes.

const find = (list: Row[], form: string, value: string) =>
  list.find((row) => row.form === form && row.value === value);

describe.each(["preact", "react", "hono"])(
  "%s primitive attribute values (real renders, Marko 6.3.51)",
  (host) => {
    for (const attribute of attributes)
      for (const form of forms)
        it.each(values)(`${attribute} ${form} %s`, (value) => {
          const key = `${attribute}/${form}`;
          const actual = find(hosts[host] ?? [], key, value);
          if (attribute === "style" && form !== "spread") {
            // The object-literal rule: refused at compile time, unchanged.
            expect(actual?.error).toContain("`style=` takes an object literal");
            return;
          }
          if (
            host === "react" &&
            attribute === "style" &&
            (value === "true" || value === "x")
          ) {
            expect(actual?.error).toContain(
              "The `style` prop expects a mapping from style properties to values, not a string",
            );
            return;
          }
          const presence = host === "react";
          expect(dom(actual, presence)).toBe(
            dom(find(marko, key, value), presence),
          );
        });
  },
);
