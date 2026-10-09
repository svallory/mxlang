/**
 * A parser module that parses through the atoms-and-sugars rows
 * (`sugar-rows.ts`) and reports what their triggers stand for in the
 * built-in event vocabulary, so the atom and after-value corpora's
 * expectations are shared between the built-in path and the module path
 * (`lang-ext-move-sugars-to-mesh`, slice a1). It renders what core's hook
 * builds from each trigger, at the parser level:
 *
 * - an `atom` trigger is `onAtom` (`{ start, end, value }`, the name after
 *   the `:`); `::name` is the reserved-token error with today's text, and,
 *   as the built-in error does, it ends the parse (no later event is
 *   delivered);
 * - a `name`, `id` or `class` trigger is `onAttrName` over its text, then
 *   its value's `onAttrValue` or `onAttrMethod`; a `::` in its text is the
 *   reserved-token error `rejectReservedName` gives today, and ends the
 *   parse;
 * - any other trigger (the member row) is passed to `onTrigger`.
 *
 * Events are otherwise forwarded unchanged. `onAtom` is held back until the
 * next other event, so a sugar's name precedes the atoms of its value, as
 * the built-in path announces them.
 */

import type { SyntaxTable } from "../index.ts";
import * as template from "../index.ts";
import { reservedMessage } from "../states/EXPRESSION.ts";

type Handlers = Record<string, ((event: never) => unknown) | undefined>;

interface Range {
  start: number;
  end: number;
}

interface TriggerEvent extends Range {
  id: string;
  position: "expression" | "attribute" | "line";
  text: Range;
  value?: Range;
  method?: Range;
}

const SUGARS = new Set(["name", "id", "class"]);

/** The structural module the corpora drive (`AtomParserModule` and `typeof template`). */
export type SugarBuild = typeof template;

/** A parser module whose `createParser` parses with `syntax` and renders sugar triggers as built-in events. */
export function sugarBuild(syntax: SyntaxTable): SugarBuild {
  const createParser = ((handlers: Handlers) => {
    let stopped = false;
    let code = "";
    let held: Range[] = [];
    const call = (name: string, event: unknown) => {
      const handler = handlers[name] as ((e: unknown) => unknown) | undefined;
      return handler?.(event);
    };
    const flush = () => {
      const atoms = held;
      held = [];
      for (const atom of atoms) {
        call("onAtom", {
          start: atom.start,
          end: atom.end,
          value: { start: atom.start + 1, end: atom.end },
        });
      }
    };
    const reserved = (at: number, end: number) => {
      flush();
      call("onError", {
        start: at,
        end,
        code: template.ErrorCode.INVALID_EXPRESSION,
        message: reservedMessage(code.slice(at + 2, end)),
      });
      stopped = true;
    };
    const wrapped: Handlers = {};
    for (const [name, handler] of Object.entries(handlers)) {
      if (typeof handler !== "function") continue;
      wrapped[name] = ((event: unknown) => {
        if (stopped) return undefined;
        flush();
        return (handler as (e: unknown) => unknown)(event);
      }) as never;
    }
    wrapped.onTrigger = ((event: TriggerEvent) => {
      if (stopped) return;
      const text = code.slice(event.text.start, event.text.end);
      if (event.position === "expression" && event.id === "atom") {
        if (text.startsWith("::")) reserved(event.start, event.end);
        else held.push({ start: event.start, end: event.end });
        return;
      }
      if (event.position === "attribute" && SUGARS.has(event.id)) {
        // `rejectReservedName`'s reading of the name's text.
        const colons = text.indexOf("::");
        if (colons >= 0) {
          const at = event.text.start + colons;
          const name = /^(?:[A-Za-z_$][\w$]*(?:-[\w$]+)*)?/.exec(
            code.slice(at + 2),
          ) as RegExpExecArray;
          reserved(at, Math.min(at + 2 + name[0].length, event.text.end));
          return;
        }
        // The value's atoms were held: the name comes first, as built in.
        const atoms = held;
        held = [];
        call("onAttrName", { start: event.text.start, end: event.text.end });
        held = atoms;
        flush();
        if (event.method) call("onAttrMethod", event.method);
        else if (event.value) {
          call("onAttrValue", {
            start: event.text.end,
            end: event.end,
            bound: false,
            value: event.value,
          });
        }
        return;
      }
      flush();
      call("onTrigger", event);
    }) as never;
    const parser = template.createParser(wrapped as never, { syntax });
    return {
      parse(source: string) {
        stopped = false;
        held = [];
        code = source;
        parser.parse(source);
        if (!stopped) flush();
      },
      read: (range: Range) => parser.read(range),
    };
  }) as unknown as SugarBuild["createParser"];
  return { ...template, createParser };
}
