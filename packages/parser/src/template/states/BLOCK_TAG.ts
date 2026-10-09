import {
  type Meta,
  type Parser,
  type Range,
  STATE,
  type StateDefinition,
} from "../internal.ts";
import * as ErrorCode from "../util/error-code.ts";

export interface BlockTagMeta extends Meta {
  /** Where the body starts: after `blockTag.open`, or after a filter's head. */
  bodyStart: number;
  close: string;
  /** A filter's name; undefined for a block tag. */
  filterName: Range | undefined;
}

const FILTER_NAME = /[A-Za-z_][\w-]*/y;

/**
 * MX (decision 182): a syntax table's block tag (`{% … %}`) or filter
 * (`::name:: … ::`) in HTML content. The body is raw: it runs to the first
 * `close` after the opener, and is announced by `onBlockTag` or `onFilter`
 * with its spans. What it means is lowering's (`lowerBlockTag`,
 * `lowerFilter` in core); pairing `{% for %}` with `{% endfor %}` too.
 */
export const BLOCK_TAG: StateDefinition<BlockTagMeta> = {
  name: "BLOCK_TAG",

  enter(parent, start) {
    return {
      state: BLOCK_TAG as StateDefinition,
      parent,
      start,
      end: start,
      bodyStart: start,
      close: "",
      filterName: undefined,
    };
  },

  exit() {},

  parse(data, maxPos, block) {
    const closeStart = data.indexOf(block.close, this.pos);
    if (closeStart === -1 || closeStart + block.close.length > maxPos) {
      return this.emitError(
        { start: block.start, end: maxPos },
        ErrorCode.MALFORMED_PLACEHOLDER,
        `EOF reached while parsing a ${block.filterName ? "filter" : "block tag"}: "${block.close}" closes it`,
      );
    }

    const end = closeStart + block.close.length;
    const value = { start: block.bodyStart, end: closeStart };
    if (block.filterName) {
      this.options.onFilter?.({
        start: block.start,
        end,
        name: block.filterName,
        value,
      });
    } else {
      this.options.onBlockTag?.({ start: block.start, end, value });
    }
    this.pos = end;
    this.exitState();
  },

  /* node:coverage ignore next */ // a raw body has no child state
  return() {},
};

/**
 * MX (decision 182): in HTML content at `parser.pos`, enters `BLOCK_TAG` for
 * the table's block tag opener, or for a filter head (`open`, a name,
 * `close`). A filter opener without a name and `close` right after it is
 * text. Returns whether it entered.
 */
export function checkForBlockTag(parser: Parser) {
  const { data, pos, syntax } = parser;
  const { blockTag, filter } = syntax;
  if (blockTag && data.startsWith(blockTag.open, pos)) {
    parser.endText();
    const block = parser.enterState(STATE.BLOCK_TAG);
    block.close = blockTag.close;
    block.bodyStart = parser.pos = pos + blockTag.open.length;
    return true;
  }

  if (filter && data.startsWith(filter.open, pos)) {
    const nameStart = pos + filter.open.length;
    FILTER_NAME.lastIndex = nameStart;
    const name = FILTER_NAME.exec(data);
    if (!name) return false;
    const nameEnd = nameStart + name[0].length;
    if (!data.startsWith(filter.close, nameEnd)) return false;
    parser.endText();
    const block = parser.enterState(STATE.BLOCK_TAG);
    block.close = filter.close;
    block.filterName = { start: nameStart, end: nameEnd };
    block.bodyStart = parser.pos = nameEnd + filter.close.length;
    return true;
  }

  return false;
}
