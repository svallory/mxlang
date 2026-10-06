import type { Parser } from "../internal.ts";
import * as CODE from "../util/codes.ts";
import type { Location, Position } from "./constants.ts";
import * as ErrorCode from "./error-code.ts";

export function isWhitespaceCode(code: number) {
  // For all practical purposes, the space character (32) and all the
  // control characters below it are whitespace. We simplify this
  // condition for performance reasons.
  // NOTE: This might be slightly non-conforming.
  return code <= CODE.SPACE;
}

export function isLineCode(code: number) {
  switch (code) {
    case CODE.NEWLINE:
    case CODE.CARRIAGE_RETURN:
      return true;
    default:
      return false;
  }
}

export function isIndentCode(code: number) {
  return code === CODE.TAB || code === CODE.SPACE;
}

/**
 * Given a source code line offsets, a start offset and an end offset, returns a Location object with line & character information for the start and end offsets.
 */
export function getLocation(
  lines: number[],
  startOffset: number,
  endOffset: number,
): Location {
  const start = getPosition(lines, startOffset);
  const end =
    startOffset === endOffset
      ? start
      : getPosAfterLine(lines, start.line, endOffset);
  return { start, end };
}

/**
 * Given a source code line offsets and an offset, returns a Position object with line & character information.
 */
export function getPosition(lines: number[], offset: number): Position {
  return getPosAfterLine(lines, 0, offset);
}

/**
 * Scan through some source code and generate an array of offsets for each newline.
 * Useful for generating line/column information for source code.
 */
export function getLines(src: string) {
  const lines = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === CODE.NEWLINE) {
      lines.push(i + 1);
    }
  }

  return lines;
}

export function htmlEOF(this: Parser) {
  if (!this.activeTag || this.activeTag.concise) {
    const pos = this.pos;
    let cur = this.pos;
    while (cur && isLineCode(this.data.charCodeAt(cur - 1))) {
      cur--;
    }

    this.pos = cur;
    this.endText();
    this.pos = pos;
  } else {
    this.endText();
  }

  while (this.activeTag) {
    if (this.activeTag.concise) {
      this.closeTagEnd(this.pos, this.pos, undefined);
    } else {
      // We found an unclosed tag on the stack that is not for a concise tag. That means
      // there is a problem with the template because all open tags should have a closing
      // tag
      //
      // NOTE: We have already closed tags that are open tag only or self-closed
      return this.emitError(
        this.activeTag,
        ErrorCode.MISSING_END_TAG,
        'Missing ending "' + this.read(this.activeTag.tagName) + '" tag',
      );
    }
  }
}

export function isWordCode(code: number) {
  return (
    (code >= CODE.UPPER_A && code <= CODE.UPPER_Z) ||
    (code >= CODE.LOWER_A && code <= CODE.LOWER_Z) ||
    (code >= CODE.NUMBER_0 && code <= CODE.NUMBER_9) ||
    code == CODE.DOLLAR ||
    code === CODE.UNDERSCORE
  );
}

const ID_CONTINUE = /^\p{ID_Continue}$/u;

/**
 * MX (decision 156 addendum 13): a word character wherever the parser looks
 * behind or ahead to decide whether a word starts or ends. `code` is a code
 * point. At or above U+0080 it is a word character when it is `ID_Continue`
 * or U+200C or U+200D (ECMAScript's IdentifierPart), so `é`, `名` and `𝑥`
 * are words (`x=é / 2` divides, `énew` is no keyword, `é!` is postfix) and
 * `©`, `×`, `…`, emoji and a lone surrogate are not, as in stock
 * htmljs-parser. The ASCII test stays a comparison and the regex runs only
 * above it. Use `wordWidthBefore` and `wordWidthAt` on a string, which read
 * a surrogate pair as one code point. `isWordCode` stays ASCII for the
 * callers that only skip ahead over a word.
 */
export function isUnicodeWordCode(code: number) {
  return code >= 0x80 ? isNonAsciiWordCode(code) : isWordCode(code);
}

function isNonAsciiWordCode(code: number) {
  if (code === 0x200c || code === 0x200d) return true;
  // A lone surrogate is no code point.
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return ID_CONTINUE.test(String.fromCodePoint(code));
}

/**
 * The width in UTF-16 units (1 or 2, 0 for none) of the word character that
 * ends at index `i` of `data`: a low surrogate is combined with the high
 * surrogate before it.
 */
export function wordWidthBefore(data: string, i: number) {
  const code = data.charCodeAt(i);
  if (!(code >= 0x80)) return isWordCode(code) ? 1 : 0;
  if (code >= 0xdc00 && code <= 0xdfff) {
    const high = data.charCodeAt(i - 1);
    if (high >= 0xd800 && high <= 0xdbff) {
      return isNonAsciiWordCode(
        ((high - 0xd800) << 10) + (code - 0xdc00) + 0x10000,
      )
        ? 2
        : 0;
    }
  }
  return isNonAsciiWordCode(code) ? 1 : 0;
}

/**
 * The width in UTF-16 units (1 or 2, 0 for none) of the word character that
 * starts at index `i` of `data`: a high surrogate is combined with the low
 * surrogate after it.
 */
export function wordWidthAt(data: string, i: number) {
  const code = data.charCodeAt(i);
  if (!(code >= 0x80)) return isWordCode(code) ? 1 : 0;
  const point = data.codePointAt(i) as number;
  return isNonAsciiWordCode(point) ? (point > 0xffff ? 2 : 1) : 0;
}

/**
 * MX (decision 156 addenda 10 and 11): whitespace wherever the parser looks
 * behind (the atom look-behind, division or regex, the keyword and operator
 * look-behinds, ` --` and ` >=`): ASCII whitespace and the Unicode
 * whitespace and line terminators of `isUnicodeSpaceCode`, which behave
 * exactly as ASCII whitespace there. Look-aheads and the tag grammar keep
 * `isWhitespaceCode`.
 */
export function isUnicodeWhitespaceCode(code: number) {
  return isWhitespaceCode(code) || isUnicodeSpaceCode(code);
}

/**
 * The characters at or above U+0080 that TypeScript reads as whitespace
 * (`Zs`, U+FEFF) or as a line terminator (U+2028, U+2029). U+0085 and U+200B,
 * which TypeScript also skips, are left out: Babel rejects both.
 */
export function isUnicodeSpaceCode(code: number) {
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

export function matchesCloseAngleBracket(code: number) {
  return code === CODE.CLOSE_ANGLE_BRACKET;
}

export function matchesCloseParen(code: number) {
  return code === CODE.CLOSE_PAREN;
}

export function matchesCloseCurlyBrace(code: number) {
  return code === CODE.CLOSE_CURLY_BRACE;
}

export function matchesPipe(code: number) {
  return code === CODE.PIPE;
}

function getPosAfterLine(
  lines: number[],
  startLine: number,
  index: number,
): Position {
  let max = lines.length - 1;
  let line = startLine;

  while (line < max) {
    const mid = (1 + line + max) >>> 1;

    if (lines[mid] <= index) {
      line = mid;
    } else {
      max = mid - 1;
    }
  }

  return {
    line,
    character: index - lines[line],
  };
}
