import {
  isIndentCode,
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

  parse(data, maxPos, line) {
    // `&a = 1`: whitespace before the `=` on the line, as for a concise
    // attribute (`div a = 1`).
    let at = this.pos;
    while (at < maxPos && isIndentCode(data.charCodeAt(at))) at++;
    if (data.charCodeAt(at) === CODE.EQUAL) {
      this.pos = at + 1; // skip =
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
    switch (child.state) {
      case STATE.JS_COMMENT_LINE:
        this.options.onComment?.(STATE.getJSCommentRange(child));
        this.exitState();
        return;
      case STATE.JS_COMMENT_BLOCK:
        this.options.onComment?.(STATE.getJSCommentRange(child));
        if (!this.consumeWhitespaceOnLine(0)) {
          return this.emitError(
            this.pos,
            ErrorCode.INVALID_CHARACTER,
            "In concise mode a javascript comment block can only be followed by whitespace characters and a newline.",
          );
        }
        this.exitState();
        return;
    }

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

/**
 * Ends the line: only whitespace may follow, or a line or block comment as
 * after a concise tag line (`div // c`), reported through `onComment` after
 * the trigger. (A comment after a value is the value's, as for a concise
 * attribute: `div a=1 // c`.)
 */
function finish(parser: Parser, line: LineTriggerMeta, value: Range | undefined) {
  const { trigger } = line;
  const { data } = parser;
  if (!parser.consumeWhitespaceOnLine(0)) {
    const next = data.charCodeAt(parser.pos + 1);
    if (
      data.charCodeAt(parser.pos) === CODE.FORWARD_SLASH &&
      (next === CODE.FORWARD_SLASH || next === CODE.ASTERISK)
    ) {
      announce(parser, line, value);
      parser.enterState(
        next === CODE.FORWARD_SLASH
          ? STATE.JS_COMMENT_LINE
          : STATE.JS_COMMENT_BLOCK,
      );
      parser.pos += 2; // skip // or /*
      return;
    }
    return parser.emitError(
      parser.pos,
      ErrorCode.INVALID_CHARACTER,
      `A "${trigger.id}" trigger line ends after its text${value ? " and its value" : ""}; only whitespace may follow it on the line.`,
    );
  }

  announce(parser, line, value);
  parser.exitState();
}

function announce(
  parser: Parser,
  line: LineTriggerMeta,
  value: Range | undefined,
) {
  const { trigger, text, fresh } = line;
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
}
