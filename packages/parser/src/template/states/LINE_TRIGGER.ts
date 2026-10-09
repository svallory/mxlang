import {
  type Meta,
  type Parser,
  type Range,
  STATE,
  type StateDefinition,
} from "../internal.ts";
import type { CompiledTrigger } from "../syntax.ts";
import * as CODE from "../util/codes.ts";
import * as ErrorCode from "../util/error-code.ts";
import { shouldTerminateConciseAttrValue } from "./ATTRIBUTE.ts";

export interface LineTriggerMeta extends Meta {
  trigger: CompiledTrigger;
  /** The matched text. */
  text: Range;
  /** Whether it is announced (false on a re-lex). */
  fresh: boolean;
}

/**
 * MX (decision 182 addendum 1): a line trigger at the start of a tagless
 * concise line, entered by `CONCISE_HTML_CONTENT` with `pos` after the
 * matched text. An optional `=value` follows, lexed as a concise attribute's
 * value; then only whitespace may remain on the line. Generalises the `$ `
 * line (`INLINE_SCRIPT`).
 */
export const LINE_TRIGGER: StateDefinition<LineTriggerMeta> = {
  name: "LINE_TRIGGER",

  enter(parent, start) {
    return {
      state: LINE_TRIGGER as StateDefinition,
      parent,
      start,
      end: start,
      trigger: undefined!,
      text: undefined!,
      fresh: false,
    };
  },

  exit() {},

  parse(data, _maxPos, line) {
    if (data.charCodeAt(this.pos) === CODE.EQUAL) {
      this.pos++; // skip =
      this.consumeWhitespace();
      const expr = this.enterState(STATE.EXPRESSION);
      expr.attrValue = true;
      expr.atoms = true;
      expr.operators = true;
      expr.terminatedByWhitespace = true;
      expr.shouldTerminate = shouldTerminateConciseAttrValue;
      return;
    }

    finish(this, line, undefined);
  },

  return(child, line) {
    if (child.start === child.end) {
      return this.emitError(
        child,
        ErrorCode.INVALID_ATTRIBUTE_VALUE,
        "Missing value for attribute",
      );
    }

    finish(this, line, { start: child.start, end: child.end });
  },
};

function finish(parser: Parser, line: LineTriggerMeta, value: Range | undefined) {
  const { trigger, text, fresh } = line;
  if (!parser.consumeWhitespaceOnLine(0)) {
    return parser.emitError(
      parser.pos,
      ErrorCode.INVALID_CHARACTER,
      `A "${trigger.id}" trigger line ends after its text${value ? " and its value" : ""}; only whitespace may follow it on the line.`,
    );
  }

  if (fresh) {
    parser.options.onTrigger?.({
      id: trigger.id,
      position: "line",
      standIn: trigger.standIn,
      start: text.start,
      end: value ? value.end : text.end,
      text,
      ...(value && { value }),
    });
  }
  parser.exitState();
}
