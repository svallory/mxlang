import {
  isIndentCode,
  isWhitespaceCode,
  isWordCode,
  type Meta,
  Parser,
  type Range,
  STATE,
  type StateDefinition,
} from "../internal.ts";
import * as CODE from "../util/codes.ts";
import * as ErrorCode from "../util/error-code.ts";

export interface ExpressionMeta extends Meta {
  groupStack: number[];
  operators: boolean;
  /** MX: the expression is a named attribute's (or spread's) value. */
  attrValue: boolean;
  /**
   * MX (decision 146 addendum 5): the expression is a default attribute's
   * value, which is exempt from the after-value rule unless it is one single
   * atom: an atom takes no member access, so ` :name` after it is sugar.
   */
  defaultAtom: boolean;
  /**
   * MX (decision 156): `:name` here is an atom where an expression is
   * expected. Set for attribute values, spreads and arguments, tag
   * arguments, placeholders, method-shorthand bodies (an attribute value,
   * lead ruling 2026-10-05) and the `${}` of a template inside one of those;
   * never for statement tags or scriptlets.
   */
  atoms: boolean;
  /** MX: where the last atom lexed in this expression ends (-1: none). */
  atomEnd: number;
  /** MX: the comments read so far, which atom lexing looks behind past. */
  comments: Meta[] | undefined;
  /** MX: where the last regular expression literal ended. */
  regexEnd: number;
  wasComment: boolean;
  hadUnguardedNewline: boolean;
  inType: boolean;
  forceType: boolean;
  ternaryDepth: number;
  terminatedByEOL: boolean;
  terminatedByWhitespace: boolean;
  consumeIndentedContent: boolean;
  shouldTerminate(
    code: number,
    data: string,
    pos: number,
    expression: ExpressionMeta,
  ): boolean;
}

// Never terminate early by default.
const shouldTerminate = () => false;

const unaryKeywords = [
  "async",
  "await",
  "class",
  "function",
  "new",
  "typeof",
] as const;

// Only JavaScript has `delete` and `void` operators; in a type `void` is the
// `void` type. `return`, `throw` and `yield` are left out: JavaScript allows
// no line break after them, so they never continue an expression.
const jsUnaryKeywords = [...unaryKeywords, "delete", "void"] as const;

const tsUnaryKeywords = [
  ...unaryKeywords,
  "asserts",
  "infer",
  "is",
  "keyof",
  "readonly",
  "unique",
] as const;

export const binaryKeywords = [
  "as",
  "extends",
  "instanceof", // Note: instanceof must be checked before `in`
  "in",
  "satisfies",
] as const;

const relationalKeywords = ["in", "instanceof"] as const;

export const EXPRESSION: StateDefinition<ExpressionMeta> = {
  name: "EXPRESSION",

  enter(parent, start) {
    return {
      state: EXPRESSION as StateDefinition,
      parent,
      start,
      end: start,
      groupStack: [],
      shouldTerminate,
      operators: false,
      attrValue: false,
      defaultAtom: false,
      atoms: false,
      atomEnd: -1,
      comments: undefined,
      regexEnd: -1,
      wasComment: false,
      hadUnguardedNewline: false,
      inType: false,
      forceType: false,
      ternaryDepth: 0,
      terminatedByEOL: false,
      terminatedByWhitespace: false,
      consumeIndentedContent: false,
    };
  },

  exit() {},

  parse(data, maxPos, expression) {
    while (this.pos < maxPos) {
      const code = data.charCodeAt(this.pos);

      // EOL handling
      if (code === CODE.NEWLINE || code === CODE.CARRIAGE_RETURN) {
        const len =
          code === CODE.CARRIAGE_RETURN &&
          data.charCodeAt(this.pos + 1) === CODE.NEWLINE
            ? 2
            : 1;

        const prevPos = this.pos;
        if (
          !expression.groupStack.length &&
          (expression.terminatedByEOL || expression.terminatedByWhitespace) &&
          (expression.wasComment ||
            !checkForOperators(this, expression, true)) &&
          !(
            expression.consumeIndentedContent &&
            isIndentCode(data.charCodeAt(prevPos + len))
          )
        ) {
          // Don't advance past the newline.
          this.exitState();
          return;
        }

        expression.wasComment = false;
        if (!expression.groupStack.length)
          expression.hadUnguardedNewline = true;
        // checkForOperators may have advanced pos; only advance by len if it didn't
        if (this.pos === prevPos) this.pos += len;
        continue;
      }

      // Fast path: an identifier/number character is never whitespace, never
      // a terminator (no `shouldTerminate` implementation matches a word
      // character), and is not handled by the switch below, so it just
      // advances. Short-circuiting here skips the termination checks and the
      // switch dispatch for the bulk of expression content.
      if (isWordCode(code)) {
        this.pos++;
        continue;
      }

      // Termination checks (no groupStack)
      if (!expression.groupStack.length) {
        if (expression.terminatedByWhitespace && isWhitespaceCode(code)) {
          if (!checkForOperators(this, expression, false)) {
            this.exitState();
            return;
          }
          // checkForOperators already advanced this.pos
          continue;
        }

        if (expression.shouldTerminate(code, data, this.pos, expression)) {
          let wasExpression = false;
          if (expression.operators) {
            const prevNonWhitespacePos = lookBehindWhile(
              isWhitespaceCode,
              data,
              this.pos - 1,
            );
            if (prevNonWhitespacePos > expression.start) {
              wasExpression =
                lookBehindForOperator(
                  expression,
                  data,
                  prevNonWhitespacePos,
                ) !== -1;
            }
          }

          if (!wasExpression) {
            this.exitState();
            return;
          }
        }
      }

      switch (code) {
        case CODE.DOUBLE_QUOTE:
          this.enterState(STATE.STRING);
          this.pos++; // skip "
          return;
        case CODE.SINGLE_QUOTE:
          this.enterState(STATE.STRING).quoteCharCode = code;
          this.pos++; // skip '
          return;
        case CODE.BACKTICK:
          this.enterState(STATE.TEMPLATE_STRING);
          this.pos++; // skip `
          return;
        case CODE.QUESTION:
          if (expression.operators && !expression.groupStack.length) {
            if (expression.attrValue) {
              // `??` and `?.` are operators, not a ternary; `?.5` is a ternary.
              const nextCode = data.charCodeAt(this.pos + 1);
              if (
                nextCode === CODE.QUESTION ||
                (nextCode === CODE.PERIOD &&
                  !isDigitCode(data.charCodeAt(this.pos + 2)))
              ) {
                this.pos += 2;
                continue;
              }
            }
            expression.ternaryDepth++;
            this.pos++; // skip ?
            this.consumeWhitespace();
            continue;
          }
          this.pos++;
          break;
        case CODE.COLON:
          // MX: an atom's `:` is not a ternary's, so it is consumed first.
          if (expression.atoms && lexAtom(this, expression, data)) {
            if (this.pos > maxPos) return; // `::` was reported
            continue;
          }
          if (expression.operators && !expression.groupStack.length) {
            if (expression.ternaryDepth) {
              expression.ternaryDepth--;
            } else {
              expression.inType = true;
            }
            this.pos++; // skip :
            this.consumeWhitespace();
            continue;
          }
          this.pos++;
          break;
        case CODE.EQUAL:
          if (expression.operators) {
            if (data.charCodeAt(this.pos + 1) === CODE.CLOSE_ANGLE_BRACKET) {
              if (
                expression.inType &&
                !expression.forceType &&
                this.getPreviousNonWhitespaceCharCode() !== CODE.CLOSE_PAREN
              ) {
                expression.inType = false;
              }
              this.pos++; // skip =, outer iteration handles >
            } else if (
              !(expression.forceType || expression.groupStack.length)
            ) {
              expression.inType = false;
            }
            this.pos++; // skip = (or the char after =>)
            this.consumeWhitespace();
            continue;
          }
          this.pos++;
          break;
        case CODE.FORWARD_SLASH:
          switch (data.charCodeAt(this.pos + 1)) {
            case CODE.FORWARD_SLASH:
              this.enterState(STATE.JS_COMMENT_LINE);
              this.pos += 2; // skip //
              return;
            case CODE.ASTERISK:
              this.enterState(STATE.JS_COMMENT_BLOCK);
              this.pos += 2; // skip /*
              return;
            default:
              if (canFollowDivision(this.getPreviousNonWhitespaceCharCode())) {
                this.pos++;
                this.consumeWhitespace();
                continue;
              } else {
                this.enterState(STATE.REGULAR_EXPRESSION);
                this.pos++; // skip /, REGULAR_EXPRESSION starts after
                return;
              }
          }
        case CODE.OPEN_PAREN:
          expression.groupStack.push(CODE.CLOSE_PAREN);
          this.pos++;
          break;
        case CODE.OPEN_SQUARE_BRACKET:
          expression.groupStack.push(CODE.CLOSE_SQUARE_BRACKET);
          this.pos++;
          break;
        case CODE.OPEN_CURLY_BRACE:
          if (expression.inType && !expression.forceType) {
            const prevPos = lookBehindWhile(
              isWhitespaceCode,
              data,
              this.pos - 1,
            );
            if (lookBehindForOperator(expression, data, prevPos) === -1) {
              expression.inType = false;
            }
          }
          expression.groupStack.push(CODE.CLOSE_CURLY_BRACE);
          this.pos++;
          break;
        case CODE.OPEN_ANGLE_BRACKET:
          if (expression.inType) {
            expression.groupStack.push(CODE.CLOSE_ANGLE_BRACKET);
            this.pos++;
          } else if (expression.operators && !expression.groupStack.length) {
            this.pos++;
            this.consumeWhitespace();
            continue;
          } else {
            this.pos++;
          }
          break;

        case CODE.CLOSE_PAREN:
        case CODE.CLOSE_SQUARE_BRACKET:
        case CODE.CLOSE_CURLY_BRACE:
        case CODE.CLOSE_ANGLE_BRACKET: {
          if (code === CODE.CLOSE_ANGLE_BRACKET) {
            if (
              !expression.inType ||
              data.charCodeAt(this.pos - 1) === CODE.EQUAL
            ) {
              this.pos++;
              break;
            }
          }

          if (!expression.groupStack.length) {
            return this.emitError(
              expression,
              ErrorCode.INVALID_EXPRESSION,
              'Mismatched group. A closing "' +
                String.fromCharCode(code) +
                '" character was found but it is not matched with a corresponding opening character.',
            );
          }

          const expectedCode = expression.groupStack.pop()!;
          if (expectedCode !== code) {
            return this.emitError(
              expression,
              ErrorCode.INVALID_EXPRESSION,
              'Mismatched group. A "' +
                String.fromCharCode(code) +
                '" character was found when "' +
                String.fromCharCode(expectedCode) +
                '" was expected.',
            );
          }

          this.pos++;
          break;
        }

        default:
          this.pos++;
          break;
      }
    }

    // EOF
    if (
      !expression.groupStack.length &&
      (this.isConcise || expression.terminatedByEOL)
    ) {
      this.exitState();
      return;
    }

    const { parent } = expression;

    switch (parent.state) {
      case STATE.ATTRIBUTE: {
        const attr = parent as STATE.AttrMeta;
        if (!attr.spread && !attr.name) {
          return this.emitError(
            expression,
            ErrorCode.MALFORMED_OPEN_TAG,
            'EOF reached while parsing attribute name for the "' +
              this.read(this.activeTag!.tagName) +
              '" tag',
          );
        }

        return this.emitError(
          expression,
          ErrorCode.MALFORMED_OPEN_TAG,
          `EOF reached while parsing attribute value for the ${
            // A missing name was reported above, so this is a spread or named attribute.
            attr.spread ? "..." : `"${this.read(attr.name!)}"`
          } attribute`,
        );
      }

      case STATE.TAG_NAME:
        return this.emitError(
          expression,
          ErrorCode.MALFORMED_OPEN_TAG,
          "EOF reached while parsing tag name",
        );

      case STATE.PLACEHOLDER:
        return this.emitError(
          expression,
          ErrorCode.MALFORMED_PLACEHOLDER,
          "EOF reached while parsing placeholder",
        );
    }

    return this.emitError(
      expression,
      ErrorCode.INVALID_EXPRESSION,
      "EOF reached while parsing expression",
    );
  },

  return(child, expression) {
    if (expression.atoms) {
      if (child.state === STATE.REGULAR_EXPRESSION) {
        expression.regexEnd = child.end;
      } else if (
        child.state === STATE.JS_COMMENT_LINE ||
        child.state === STATE.JS_COMMENT_BLOCK
      ) {
        (expression.comments ||= []).push(child);
      }
    }
    if (child.state === STATE.JS_COMMENT_LINE) {
      expression.wasComment = true;
      // A line comment that runs to the end of the input (rather than being
      // terminated by a newline or a closing tag) consumes everything that
      // would follow it on the line, exactly like an unguarded newline. Flag
      // it as unguarded so the value is not classified as `enclosed` (safe to
      // inline verbatim) by the validation helpers — otherwise emitting it
      // bare would comment out whatever comes next.
      if (this.pos === this.maxPos && !expression.groupStack.length) {
        expression.hadUnguardedNewline = true;
      }
    }
  },
};

function checkForOperators(
  parser: Parser,
  expression: ExpressionMeta,
  eol: boolean,
) {
  if (!expression.operators) return false;

  const { pos, data } = parser;
  if (lookBehindForOperator(expression, data, pos) !== -1) {
    parser.consumeWhitespace();
    return true;
  }

  const terminatedByEOL = expression.terminatedByEOL || parser.isConcise;
  if (!(terminatedByEOL && eol)) {
    const nextNonSpace = lookAheadWhile(
      terminatedByEOL ? isIndentCode : isWhitespaceCode,
      data,
      pos + 1,
    );

    // A "</" close tag (html mode) or a "<!--" html comment is markup rather
    // than a less-than operator, which lookAheadForOperator would otherwise
    // continue across.
    if (data.charCodeAt(nextNonSpace) === CODE.OPEN_ANGLE_BRACKET) {
      if (
        !parser.isConcise &&
        data.charCodeAt(nextNonSpace + 1) === CODE.FORWARD_SLASH
      ) {
        return false;
      }

      if (parser.lookAheadFor("!--", nextNonSpace + 1)) {
        return false;
      }
    }

    if (
      !expression.shouldTerminate(
        data.charCodeAt(nextNonSpace),
        data,
        nextNonSpace,
        expression,
      )
    ) {
      const lookAheadPos = lookAheadForOperator(expression, data, nextNonSpace);
      if (lookAheadPos !== -1) {
        parser.pos = lookAheadPos;
        return true;
      }
    }
  }

  return false;
}

function lookBehindForOperator(
  expression: ExpressionMeta,
  data: string,
  pos: number,
): number {
  const curPos = pos - 1;
  const code = data.charCodeAt(curPos);

  switch (code) {
    case CODE.AMPERSAND:
    case CODE.ASTERISK:
    case CODE.CARET:
    case CODE.COLON:
    case CODE.EQUAL:
    case CODE.OPEN_ANGLE_BRACKET:
    case CODE.PERCENT:
    case CODE.PIPE:
    case CODE.QUESTION:
    case CODE.TILDE:
      return curPos;

    case CODE.EXCLAMATION: {
      // After an operand, `!` is a TypeScript non-null assertion (postfix),
      // as is each `!` of a run after one (`x!!`); after a keyword operator
      // (`typeof!a`, `a in!b`) it is the prefix `!`.
      let operandEnd = curPos - 1;
      while (data.charCodeAt(operandEnd) === CODE.EXCLAMATION) operandEnd--;
      const operandCode = data.charCodeAt(operandEnd);
      switch (operandCode) {
        case CODE.CLOSE_PAREN:
        case CODE.CLOSE_SQUARE_BRACKET:
        case CODE.DOUBLE_QUOTE:
        case CODE.SINGLE_QUOTE:
        case CODE.BACKTICK:
          return -1;
        default:
          return isWordCode(operandCode) &&
            lookBehindForOperator(expression, data, operandEnd + 1) === -1 &&
            lookBehindForKeyword(
              expression,
              data,
              operandEnd,
              relationalKeywords,
            ) === -1
            ? -1
            : curPos;
      }
    }

    case CODE.CLOSE_ANGLE_BRACKET:
      return data.charCodeAt(curPos - 1) === CODE.EQUAL
        ? curPos - 1
        : expression.inType
          ? -1
          : curPos;

    case CODE.PERIOD: {
      // Only matches `.` followed by something that could be an identifier.
      const nextPos = lookAheadWhile(isWhitespaceCode, data, pos);
      return isWordCode(data.charCodeAt(nextPos)) ? nextPos : -1;
    }

    // special case -- and ++
    case CODE.PLUS:
    case CODE.HYPHEN: {
      if (data.charCodeAt(curPos - 1) === code) {
        // Check if we should continue for another reason.
        // eg "typeof++ x"
        return lookBehindForOperator(
          expression,
          data,
          lookBehindWhile(isWhitespaceCode, data, curPos - 2),
        );
      }

      return curPos;
    }

    default: {
      // Every unary keyword ends in a lowercase letter; if the character
      // before `pos` is not one, no keyword can match.
      if (code < CODE.LOWER_A || code > CODE.LOWER_Z) return -1;

      return lookBehindForKeyword(
        expression,
        data,
        curPos,
        expression.inType ? tsUnaryKeywords : jsUnaryKeywords,
      );
    }
  }
}

/**
 * MX (decision 146 addendum 5): a default attribute's value that is exactly
 * one atom so far (`=:Customer`, not `=:a + :b` or `=:a.b`), with only
 * whitespace between it and `pos`.
 */
function isSingleAtomDefault(
  expression: ExpressionMeta,
  data: string,
  pos: number,
): boolean {
  return (
    expression.defaultAtom &&
    data.charCodeAt(expression.start) === CODE.COLON &&
    expression.atomEnd === atomNameEnd(data, expression.start + 1) &&
    lookAheadWhile(isWhitespaceCode, data, expression.atomEnd) === pos
  );
}

function lookAheadForOperator(
  expression: ExpressionMeta,
  data: string,
  pos: number,
): number {
  switch (data.charCodeAt(pos)) {
    case CODE.AMPERSAND:
    case CODE.ASTERISK:
    case CODE.CARET:
    case CODE.EXCLAMATION:
    case CODE.OPEN_ANGLE_BRACKET:
    case CODE.PERCENT:
    case CODE.PIPE:
    case CODE.TILDE:
    case CODE.PLUS:
    case CODE.HYPHEN:
      return pos + 1;

    case CODE.FORWARD_SLASH:
    case CODE.OPEN_CURLY_BRACE:
    case CODE.OPEN_PAREN:
    case CODE.CLOSE_ANGLE_BRACKET:
    case CODE.QUESTION:
    case CODE.EQUAL:
      return pos; // defers to base expression state to track block groups.

    case CODE.COLON:
      // MX: in an attribute value, ` :name` (no open `?`) or a bare `:` before
      // the end of the tag or line starts a new attribute.
      return (expression.attrValue ||
        isSingleAtomDefault(expression, data, pos)) &&
        !expression.ternaryDepth &&
        (isIdentStartCode(data.charCodeAt(pos + 1)) ||
          isBareColonEnd(data, pos + 1))
        ? -1
        : pos;

    case CODE.PERIOD: {
      // MX: in an attribute value, ` .name` starts a new attribute.
      if (expression.attrValue && isIdentStartCode(data.charCodeAt(pos + 1))) {
        return -1;
      }
      // Only matches `.` followed by something that could be an identifier.
      const nextPos = lookAheadWhile(isWhitespaceCode, data, pos + 1);
      return isWordCode(data.charCodeAt(nextPos)) ? nextPos : -1;
    }

    default: {
      // Every binary keyword starts with a lowercase letter; if the character
      // at `pos` is not one, no keyword can match.
      const startCode = data.charCodeAt(pos);
      if (startCode < CODE.LOWER_A || startCode > CODE.LOWER_Z) return -1;

      for (const keyword of binaryKeywords) {
        const keywordPos = lookAheadFor(data, pos, keyword);
        if (keywordPos === -1) continue;
        if (!isWhitespaceCode(data.charCodeAt(keywordPos + 1))) break;

        // skip any whitespace after the operator;
        // there must be an operand before the end of the input.
        const nextPos = lookAheadWhile(isWhitespaceCode, data, keywordPos + 2);
        if (nextPos === data.length) break;

        // finally check that this is not followed by a terminator.
        switch (data.charCodeAt(nextPos)) {
          case CODE.COLON:
          case CODE.COMMA:
          case CODE.EQUAL:
          case CODE.FORWARD_SLASH:
          case CODE.CLOSE_ANGLE_BRACKET:
          case CODE.SEMICOLON:
            break;
          default:
            if (
              !expression.inType &&
              (keyword === "as" || keyword === "satisfies")
            ) {
              expression.inType = true;
              if (!(expression.ternaryDepth || expression.groupStack.length)) {
                expression.forceType = true;
              }
            }
            return nextPos;
        }
      }

      return -1;
    }
  }
}

function canFollowDivision(code: number) {
  if (isWordCode(code)) return true;
  switch (code) {
    case CODE.BACKTICK:
    case CODE.SINGLE_QUOTE:
    case CODE.DOUBLE_QUOTE:
    case CODE.PERCENT:
    case CODE.CLOSE_PAREN:
    case CODE.PERIOD:
    case CODE.OPEN_ANGLE_BRACKET:
    case CODE.CLOSE_SQUARE_BRACKET:
    case CODE.CLOSE_CURLY_BRACE:
      return true;
    default:
      return false;
  }
}

function isWordOrPeriodCode(code: number) {
  return code === CODE.PERIOD || isWordCode(code);
}

function lookAheadWhile(
  match: (code: number) => boolean,
  data: string,
  pos: number,
) {
  const max = data.length;
  for (let i = pos; i < max; i++) {
    if (!match(data.charCodeAt(i))) return i;
  }

  return max;
}

function lookBehindWhile(
  match: (code: number) => boolean,
  data: string,
  pos: number,
) {
  let i = pos;

  do {
    if (!match(data.charCodeAt(i))) {
      return i + 1;
    }
  } while (i--);

  return 0;
}

// Returns where a whole keyword ending at `pos` starts, or -1. A keyword that
// starts the expression is whole even after a `.` (a spread's `...new x`).
function lookBehindForKeyword(
  expression: ExpressionMeta,
  data: string,
  pos: number,
  keywords: readonly string[],
) {
  // MX: an atom's own name (`:delete`) is not an operator keyword.
  if (pos + 1 === expression.atomEnd) return -1;
  for (const keyword of keywords) {
    const keywordPos = lookBehindFor(data, pos, keyword);
    if (keywordPos !== -1) {
      return keywordPos < expression.start ||
        (keywordPos > expression.start &&
          isWordOrPeriodCode(data.charCodeAt(keywordPos - 1)))
        ? -1
        : keywordPos;
    }
  }
  return -1;
}

function lookBehindFor(data: string, pos: number, str: string) {
  let i = str.length;
  const endPos = pos - i + 1;
  if (endPos < 0) return -1;

  while (i--) {
    if (data.charCodeAt(endPos + i) !== str.charCodeAt(i)) {
      return -1;
    }
  }

  return endPos;
}

function lookAheadFor(data: string, pos: number, str: string) {
  let i = str.length;
  const endPos = pos + i;
  if (endPos > data.length) return -1;

  while (i--) {
    if (data.charCodeAt(pos + i) !== str.charCodeAt(i)) {
      return -1;
    }
  }

  return endPos - 1;
}

function isDigitCode(code: number) {
  return code >= CODE.NUMBER_0 && code <= CODE.NUMBER_9;
}

function isIdentStartCode(code: number) {
  return (
    (code >= CODE.UPPER_A && code <= CODE.UPPER_Z) ||
    (code >= CODE.LOWER_A && code <= CODE.LOWER_Z) ||
    code === CODE.DOLLAR ||
    code === CODE.UNDERSCORE
  );
}

/**
 * MX (decision 156 addenda 2 and 8): a word character for the atom
 * look-behind. Every character at or above U+0080 counts, as after an atom's
 * name in `lexAtom`, so a non-ASCII identifier (`{ é:a }`, `(é :T)`, `éin`)
 * is an operand: a `:` TypeScript could own is TypeScript's. `isWordCode`
 * stays ASCII for its upstream callers.
 */
function isLookBehindWordCode(code: number) {
  return code >= 0x80 || isWordCode(code);
}

/** Whether `at` is the end of the tag or line: `>`, `/>`, a newline or EOF. */
function isBareColonEnd(data: string, at: number) {
  const code = data.charCodeAt(at);
  return (
    code !== code ||
    code === CODE.CLOSE_ANGLE_BRACKET ||
    code === CODE.NEWLINE ||
    code === CODE.CARRIAGE_RETURN ||
    (code === CODE.FORWARD_SLASH &&
      data.charCodeAt(at + 1) === CODE.CLOSE_ANGLE_BRACKET)
  );
}

// MX (decision 156): words after which an expression is expected.
const atomKeywords = [
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
] as const;

/**
 * MX (decision 156), at a `:`: lexes `::name` (reserved, reported through
 * `onError`) or, where an expression is expected, an atom `:name`, recorded
 * on the parser and announced through `onAtom`. Returns whether it consumed
 * the `:`.
 */
function lexAtom(
  parser: Parser,
  expression: ExpressionMeta,
  data: string,
): boolean {
  const start = parser.pos;
  if (data.charCodeAt(start + 1) === CODE.COLON) {
    const end = atomNameEnd(data, start + 2);
    const name = data.slice(start + 2, end);
    parser.emitError(
      { start, end },
      ErrorCode.INVALID_EXPRESSION,
      reservedMessage(name),
    );
    return true;
  }

  const end = atomNameEnd(data, start + 1);
  if (
    end === start + 1 ||
    // A non-ASCII letter right after the name (`:aé`, or `:a-é`, which
    // would silently read as subtraction) is not part of it, and a stand-in
    // there would reach Babel's message; leave `:` to Babel.
    data.charCodeAt(end) >= 0x80 ||
    (data.charCodeAt(end) === CODE.HYPHEN &&
      data.charCodeAt(end + 1) >= 0x80) ||
    !expectsExpression(expression, data, start)
  ) {
    return false;
  }

  const { atoms } = parser;
  const last = atoms[atoms.length - 1];
  // Defensive: no state rewinds `pos` into an expression today (280k fuzzed
  // inputs never re-lexed one), but a re-lex must not record an atom twice.
  if (!last || last.start < start) {
    atoms.push({ start, end });
    parser.options.onAtom?.({ start, end, value: { start: start + 1, end } });
  }
  expression.atomEnd = end;
  parser.pos = end;
  return true;
}

/** MX (decision 156): the error for the reserved `::name` token. */
export function reservedMessage(name: string) {
  return `\`::${name}\` is reserved (decision 156): \`::\` will be the Symbol.for sugar; write \`:${name || "name"}\` for an atom`;
}

/**
 * MX (decision 156): reports a `::` in a tag or attribute name's static
 * text, if any. Only `range` is read, one character past each `:`; never a
 * scan to the end of the file (review round 5, R1).
 */
export function rejectReservedName(parser: Parser, range: Range): boolean {
  const { data } = parser;
  for (let at = range.start; at + 1 < range.end; at++) {
    if (
      data.charCodeAt(at) === CODE.COLON &&
      data.charCodeAt(at + 1) === CODE.COLON
    ) {
      const end = atomNameEnd(data, at + 2);
      parser.emitError(
        { start: at, end },
        ErrorCode.INVALID_EXPRESSION,
        reservedMessage(data.slice(at + 2, end)),
      );
      return true;
    }
  }
  return false;
}

/**
 * Whether the word ending at `end` (inclusive) is an operator keyword after
 * which an expression is expected. Never an atom's own name (`:delete :b`,
 * `:foo-new :b`), a member name (`a.new`), or a contextual keyword used as an
 * identifier: `of` only after an operand (`for (x of …)`), `yield`/`await`
 * not after `?`, `:`, `,` or `(` (`c ? of :b`, `c ? yield :b`).
 */
function isOperatorWord(
  expression: ExpressionMeta,
  data: string,
  end: number,
): boolean {
  if (end + 1 === expression.atomEnd) return false;
  let wordStart = end;
  while (
    wordStart > expression.start &&
    isLookBehindWordCode(data.charCodeAt(wordStart - 1))
  ) {
    wordStart--;
  }
  if (
    wordStart > expression.start &&
    data.charCodeAt(wordStart - 1) === CODE.PERIOD
  ) {
    return false;
  }
  const word = data.slice(wordStart, end + 1);
  if (!(atomKeywords as readonly string[]).includes(word)) return false;
  if (word === "of" || word === "yield" || word === "await") {
    let j = wordStart - 1;
    while (j >= expression.start && isWhitespaceCode(data.charCodeAt(j))) j--;
    const before = j < expression.start ? -1 : data.charCodeAt(j);
    if (word === "of") {
      return (
        isLookBehindWordCode(before) ||
        before === CODE.CLOSE_PAREN ||
        before === CODE.CLOSE_SQUARE_BRACKET ||
        before === CODE.CLOSE_CURLY_BRACE
      );
    }
    return !(
      before === CODE.QUESTION ||
      before === CODE.COLON ||
      before === CODE.COMMA ||
      before === CODE.OPEN_PAREN
    );
  }
  return true;
}

/**
 * Whether the `>` at `end` closes a type argument list: scanning back, the
 * matching `<` is written right after a word (`Array<T>`, `Map<K, V>`,
 * `Array<() => T>`, `a<b >`), within the same group. `a < b >` (space
 * before `<`), `a >> b`, `a < b && c >` and a `<` beyond the group's own
 * opener are comparisons. Stops at `;`, `&&`, `||`, and at a `?` or `:` of
 * this group, so a run of atoms never rescans the expression.
 */
function closesTypeArguments(
  expression: ExpressionMeta,
  data: string,
  end: number,
): boolean {
  let angles = 0;
  let groups = 0;
  for (let j = end; j >= expression.start; j--) {
    const code = data.charCodeAt(j);
    switch (code) {
      case CODE.CLOSE_ANGLE_BRACKET:
        if (data.charCodeAt(j - 1) !== CODE.EQUAL) angles++;
        break;
      case CODE.OPEN_ANGLE_BRACKET:
        if (--angles === 0) {
          return (
            groups === 0 &&
            j > expression.start &&
            isLookBehindWordCode(data.charCodeAt(j - 1))
          );
        }
        break;
      case CODE.CLOSE_PAREN:
      case CODE.CLOSE_SQUARE_BRACKET:
      case CODE.CLOSE_CURLY_BRACE:
        groups++;
        break;
      case CODE.OPEN_PAREN:
      case CODE.OPEN_SQUARE_BRACKET:
      case CODE.OPEN_CURLY_BRACE:
        if (--groups < 0) return false;
        break;
      case CODE.SEMICOLON:
        return false;
      case CODE.QUESTION:
      case CODE.COLON:
        if (groups === 0) return false;
        break;
      case CODE.AMPERSAND:
      case CODE.PIPE:
        if (data.charCodeAt(j - 1) === code) return false;
        break;
    }
  }
  return false;
}

/** Where an atom name `[A-Za-z_$][\w$]*(-[\w$]+)*` starting at `pos` ends. */
function atomNameEnd(data: string, pos: number) {
  if (!isIdentStartCode(data.charCodeAt(pos))) return pos;
  let end = pos + 1;
  for (;;) {
    while (isWordCode(data.charCodeAt(end))) end++;
    if (
      data.charCodeAt(end) !== CODE.HYPHEN ||
      !isWordCode(data.charCodeAt(end + 1))
    ) {
      return end;
    }
    end += 2;
  }
}

/**
 * Whether an expression is expected at `pos`: at the start of the
 * expression, or after an operator, punctuator or operator keyword; never
 * after an expression end (a word, literal, `)`, `]`, `}`), `.`, `?.`, a
 * postfix `++`/`--`, TypeScript's `x?:` / `x!:` markers, a word written
 * right against the `:` (a key or label: `{ new:a }`), or an atom's own name.
 */
function expectsExpression(
  expression: ExpressionMeta,
  data: string,
  pos: number,
): boolean {
  let i = pos - 1;
  for (;;) {
    while (i >= expression.start && isWhitespaceCode(data.charCodeAt(i))) i--;
    const comment = expression.comments?.find((c) => c.end === i + 1);
    if (!comment) break;
    i = comment.start - 1;
  }

  if (i < expression.start) return true;
  const code = data.charCodeAt(i);
  switch (code) {
    case CODE.CLOSE_PAREN:
    case CODE.CLOSE_SQUARE_BRACKET:
    case CODE.CLOSE_CURLY_BRACE:
    case CODE.DOUBLE_QUOTE:
    case CODE.SINGLE_QUOTE:
    case CODE.BACKTICK:
      return false;
    case CODE.PERIOD:
      // Only a spread's `...` expects an expression.
      return (
        data.charCodeAt(i - 1) === CODE.PERIOD &&
        data.charCodeAt(i - 2) === CODE.PERIOD
      );
    case CODE.QUESTION: {
      // A `?` written right after a word or `]` is TypeScript's optional
      // marker (`a?:T`, `a? :T`), whatever follows it; a ternary's `?` has
      // whitespace before it (`a ? :b`), or follows a number, which never
      // carries a marker (`n === 1? :a : :b`).
      if (i === expression.start) return true;
      const owner = data.charCodeAt(i - 1);
      if (isLookBehindWordCode(owner)) {
        let wordStart = i - 1;
        while (
          wordStart > expression.start &&
          isLookBehindWordCode(data.charCodeAt(wordStart - 1))
        ) {
          wordStart--;
        }
        return isDigitCode(data.charCodeAt(wordStart));
      }
      return !(
        owner === CODE.CLOSE_SQUARE_BRACKET ||
        owner === CODE.HYPHEN ||
        owner === CODE.PLUS
      );
    }
    case CODE.EXCLAMATION: {
      // A `!` right after an operand is postfix (non-null `a!`, `a!!`,
      // `a! !`, `(a)!`, or definite assignment `x!:`), and an operand ends
      // there; after an operator keyword (`typeof!x`) or anything else it is
      // unary (`!!x`).
      let j = i - 1;
      while (
        j >= expression.start &&
        (data.charCodeAt(j) === CODE.EXCLAMATION ||
          isWhitespaceCode(data.charCodeAt(j)))
      ) {
        j--;
      }
      if (j < expression.start) return true;
      const owner = data.charCodeAt(j);
      if (
        owner === CODE.CLOSE_PAREN ||
        owner === CODE.CLOSE_SQUARE_BRACKET ||
        owner === CODE.HYPHEN ||
        owner === CODE.PLUS
      ) {
        return false;
      }
      if (!isLookBehindWordCode(owner)) return true;
      return isOperatorWord(expression, data, j);
    }
    case CODE.CLOSE_ANGLE_BRACKET:
      // A type argument list's closing `>` (`y as Array<T> :z`, `a<b> :z`)
      // ends an operand at any depth; `=>`, a comparison and a shift expect
      // an expression.
      return (
        data.charCodeAt(i - 1) === CODE.EQUAL ||
        !closesTypeArguments(expression, data, i)
      );
    case CODE.PLUS:
    case CODE.HYPHEN:
      // A `++`/`--` before a `:` is postfix.
      return data.charCodeAt(i - 1) !== code;
    case CODE.FORWARD_SLASH:
      return i + 1 !== expression.regexEnd;
    default: {
      if (!isLookBehindWordCode(code)) return true;
      // A word directly before the `:` is an object key or a label, keyword
      // or not (`{ new:a }`).
      if (i === pos - 1) return false;
      return isOperatorWord(expression, data, i);
    }
  }
}
