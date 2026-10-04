import { reservedBindingMessage } from "@mxlang/core";
import ts from "typescript";
import { expect, it } from "vitest";
import { createAmxLanguagePlugin } from "./amx-language.ts";
import {
  createNgMxLanguagePlugin,
  createSolidMxLanguagePlugin,
} from "./language.ts";
import { createMxLanguagePlugin } from "./mx-language.ts";

it.each([
  ["mx", "\n<const/__mxX=1/>", createMxLanguagePlugin],
  [
    "solid.mx",
    "\nconst __mxX = 1;\nconst view = <p/>;",
    createSolidMxLanguagePlugin,
  ],
  ["ng.mx", "\nconst __mxX = 1;", createNgMxLanguagePlugin],
  ["astro.mx", "---\nconst __mxX = 1;\n---\n<p/>", createAmxLanguagePlugin],
] as const)(
  "%s virtual code records the shared error at the source offset",
  (suffix, source, create) => {
    const plugin = create(ts);
    const filename = `/tmp/reserved.${suffix}`;
    const language = plugin.getLanguageId?.(filename);
    if (!language) throw new Error(`missing language for ${filename}`);
    const virtual = plugin.createVirtualCode?.(
      filename,
      language,
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    expect(virtual?.mappings).toEqual([]);
    expect(plugin.getSyntaxError(filename)).toMatchObject({
      message: reservedBindingMessage("__mxX"),
      offset: source.indexOf("__mxX"),
    });
  },
);
