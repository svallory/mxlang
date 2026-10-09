import {
  isIndentCode,
  isUnicodeWhitespaceCode,
  isWhitespaceCode,
  matchesCloseAngleBracket,
  matchesCloseCurlyBrace,
  matchesCloseParen,
  type Meta,
  Parser,
  type Range,
  type Ranges,
  STATE,
  type StateDefinition,
  wordWidthAt,
  wordWidthBefore,
} from "../internal.ts";
import { type CompiledTrigger, matchTrigger } from "../syntax.ts";
import * as CODE from "../util/codes.ts";
import * as ErrorCode from "../util/error-code.ts";
import { rejectReservedName } from "./EXPRESSION.ts";
import * as ATTR_STAGE from "./attr-stage.ts";
import * as TAG_STAGE from "./tag-stage.ts";

export interface AttrMeta extends Meta {
  stage: ATTR_STAGE.AttrStage;
  name: undefined | Range;
  valueStart: number;
  args: boolean | Ranges.AttrMethod["params"];
  typeParams: undefined | Ranges.Value;
  spread: boolean;
  bound: boolean;
  /** A pending `async`, held until the args close reveals what it modifies. */
  async: undefined | Range;
  /** Range of an `async` keyword already confirmed to modify a method. */
  asyncMethod: undefined | Range;
  /**
   * MX (decision 182): the attribute trigger this attribute is, its matched
   * text, whether it is announced (false on a re-lex), its `(args)` (written
   * with no body), and whether `onTrigger` was called for it already.
   */
  trigger:
    | undefined
    | {
        trigger: CompiledTrigger;
        text: Range;
        fresh: boolean;
        args: Ranges.Value | undefined;
        announced: boolean;
      };
}

// We enter STATE.ATTRIBUTE when we see a non-whitespace
// character after reading the tag name
export const ATTRIBUTE: StateDefinition<AttrMeta> = {
  name: "ATTRIBUTE",

  enter(parent, start) {
    return (this.activeAttr = {
      state: ATTRIBUTE as StateDefinition,
      parent,
      start,
      end: start,
      valueStart: start,
      stage: ATTR_STAGE.UNKNOWN,
      name: undefined,
      args: false,
      typeParams: undefined,
      bound: false,
      spread: false,
      async: undefined,
      asyncMethod: undefined,
      trigger: undefined,
    });
  },

  exit(attr) {
    // Catches the paths that leave the attribute without resolving a pending
    // `async`, notably EOF part way through typing `<div async onCl`.
    flushPendingAsync(this, attr);
    // MX (decision 182): a trigger with `(args)` and no value ends with the
    // attribute, as a named attribute's arguments do.
    if (attr.trigger && !attr.trigger.announced) {
      announceAttrTrigger(this, attr, undefined, undefined);
    }
    this.activeAttr = undefined;
  },

  parse(data, maxPos, attr) {
    while (this.pos < maxPos) {
      const code = data.charCodeAt(this.pos);

      if (code === CODE.NEWLINE || code === CODE.CARRIAGE_RETURN) {
        if (this.isConcise) {
          this.exitState();
          return; // parent handles newline
        }
        this.pos +=
          code === CODE.CARRIAGE_RETURN &&
          data.charCodeAt(this.pos + 1) === CODE.NEWLINE
            ? 2
            : 1;
        continue;
      }

      if (isWhitespaceCode(code)) {
        this.pos++;
        continue;
      }

      if (code === CODE.OPEN_ANGLE_BRACKET && this.lookAheadFor("!--")) {
        this.exitState();
        return; // the open tag reports the html comment
      }

      if (
        code === CODE.EQUAL ||
        (code === CODE.COLON && data.charCodeAt(this.pos + 1) === CODE.EQUAL) ||
        (code === CODE.PERIOD && this.lookAheadFor(".."))
      ) {
        attr.valueStart = this.pos;
        flushPendingAsync(this, attr); // a value means no method follows

        // MX (decision 182): `=` or `:=` after a trigger's `(args)`.
        if (attr.trigger && code !== CODE.PERIOD) {
          enterTriggerValue(this, attr, code === CODE.COLON);
          return;
        }

        if (code === CODE.COLON) {
          ensureAttrName(this, attr);
          attr.bound = true;
          this.pos += 2; // skip :=
          this.consumeWhitespace();
        } else if (code === CODE.PERIOD) {
          attr.spread = true;
          this.pos += 3; // skip ...
        } else {
          ensureAttrName(this, attr);
          this.pos++; // skip =
          this.consumeWhitespace();
        }

        attr.stage = ATTR_STAGE.VALUE;
        // MX: a default attribute (no name) is exempt from the after-value rule.
        enterAttrValue(this, !!(attr.name || attr.spread));
        return;
      } else if (code === CODE.OPEN_PAREN) {
        // With a pending `async` the name is emitted once we know whether this
        // is a method, since `<foo async(1)/>` is an attribute named `async`.
        // MX: an attribute trigger's method announces no name.
        if (!attr.async && !attr.trigger) ensureAttrName(this, attr);
        attr.stage = ATTR_STAGE.ARGUMENT;
        this.pos++; // skip (
        const expr = this.enterState(STATE.EXPRESSION);
        expr.shouldTerminate = matchesCloseParen;
        expr.atoms = true; // MX: decision 156
        return;
      } else if (
        code === CODE.OPEN_ANGLE_BRACKET &&
        // A pending `async` leaves the stage UNKNOWN, but type params can
        // still follow it for a default attribute method.
        (attr.stage === ATTR_STAGE.NAME || attr.async)
      ) {
        attr.stage = ATTR_STAGE.TYPE_PARAMS;
        this.pos++; // skip <
        const expr = this.enterState(STATE.EXPRESSION);
        expr.inType = true;
        expr.forceType = true;
        expr.shouldTerminate = matchesCloseAngleBracket;
        return;
      } else if (code === CODE.OPEN_CURLY_BRACE && attr.args) {
        if (!attr.trigger) ensureAttrName(this, attr);
        attr.stage = ATTR_STAGE.BLOCK;
        this.pos++; // skip {
        const body = this.enterState(STATE.EXPRESSION);
        body.shouldTerminate = matchesCloseCurlyBrace;
        // MX: a method-shorthand body is an attribute value (it lowers to a
        // function), so it lexes atoms (decision 156; lead ruling 2026-10-05).
        body.atoms = true;
        return;
      } else if (attr.stage === ATTR_STAGE.UNKNOWN) {
        if (code === CODE.OPEN_ANGLE_BRACKET) {
          if (data.charCodeAt(this.pos + 1) === CODE.FORWARD_SLASH) {
            return this.emitError(
              this.pos,
              ErrorCode.MALFORMED_OPEN_TAG,
              'A close tag was found before the "' +
                this.read(this.activeTag!.tagName) +
                '" open tag was closed. If the "</" was intended as part of an attribute expression (eg a less-than comparison), wrap the value in parentheses.',
            );
          }
          return this.emitError(
            this.pos,
            ErrorCode.INVALID_ATTRIBUTE_NAME,
            'Invalid attribute name. Attribute name cannot begin with the "<" character.',
          );
        }

        // MX (decision 182): an attribute trigger, armed by the name's
        // first character. The default row has no trigger set.
        if (
          this.syntax.attribute !== null &&
          !attr.name &&
          lexAttrTrigger(this, attr, data)
        ) {
          return;
        }

        attr.stage = ATTR_STAGE.NAME;
        // Don't advance pos: EXPRESSION starts at current char
        const expr = this.enterState(STATE.EXPRESSION);
        expr.terminatedByWhitespace = true;
        expr.shouldTerminate = this.isConcise
          ? this.activeTag!.stage === TAG_STAGE.ATTR_GROUP
            ? shouldTerminateConciseGroupedAttrName
            : shouldTerminateConciseAttrName
          : shouldTerminateHtmlAttrName;
        return;
      } else {
        flushPendingAsync(this, attr);
        this.exitState();
        return;
      }
    }

    // EOF
    flushPendingAsync(this, attr);
    if (this.isConcise) {
      this.exitState();
    } else {
      this.emitError(
        attr,
        ErrorCode.MALFORMED_OPEN_TAG,
        'EOF reached while parsing attribute "' +
          (attr.name ? this.read(attr.name) : "default") +
          '" for the "' +
          this.read(this.activeTag!.tagName) +
          '" tag',
      );
    }
  },

  return(child, attr) {
    switch (attr.stage) {
      case ATTR_STAGE.NAME: {
        const name = {
          start: child.start,
          end: child.end,
        };

        if (!attr.async && !attr.name && isAsyncMethodPrefix(this, name)) {
          // Both names stay unemitted until a method is confirmed or
          // flushPendingAsync replays them as ordinary attributes.
          attr.async = name;
          attr.stage = ATTR_STAGE.UNKNOWN;
          return;
        }

        attr.name = name;
        // MX (decision 156 addendum 2): `::` is reserved in an attribute name.
        if (rejectReservedName(this, name)) return;

        // With a pending `async` this name is emitted later, once we know
        // which attribute it belongs to.
        if (!attr.async) this.options.onAttrName?.(attr.name);

        if (!this.isConcise && detectAmbiguousCloseAngleBracket(this, child)) {
          return;
        }
        break;
      }
      case ATTR_STAGE.ARGUMENT: {
        if (attr.args) {
          this.emitError(
            child,
            ErrorCode.INVALID_ATTRIBUTE_ARGUMENT,
            "An attribute can only have one set of arguments",
          );
          return;
        }
        const start = child.start - 1; // include (
        const end = ++this.pos; // include )
        const value = {
          start: child.start,
          end: child.end,
        };

        if (this.consumeWhitespaceIfBefore("{")) {
          // A shorthand method: any pending `async` is a modifier on this
          // method rather than an attribute, so only the name is emitted.
          if (attr.async) {
            // A default attribute method has no name to emit here; the "{"
            // branch of parse emits its empty name range.
            if (attr.name) this.options.onAttrName?.(attr.name);
            attr.asyncMethod = attr.async;
            attr.async = undefined;
          }

          attr.args = {
            start,
            end,
            value,
          };
        } else if (attr.typeParams) {
          flushPendingAsync(this, attr);
          this.emitError(
            child,
            ErrorCode.INVALID_ATTRIBUTE_ARGUMENT,
            "An attribute cannot have both type parameters and arguments",
          );
        } else {
          flushPendingAsync(this, attr); // args without a body is not a method
          attr.args = true;
          // MX (decision 182): an attribute trigger's arguments are announced
          // with it (core decides what they mean).
          if (attr.trigger) attr.trigger.args = { start, end, value };
          else {
            this.options.onAttrArgs?.({
              start,
              end,
              value,
            });
          }
        }

        break;
      }
      case ATTR_STAGE.BLOCK: {
        const params = attr.args as Ranges.Value;
        const end = ++this.pos; // include }
        const { typeParams, asyncMethod } = attr;
        // An attribute trigger's method starts at its own `<` or `(`: the
        // `async` written before the trigger is outside the method's text,
        // carried by the `async` flag and covered by the trigger's span
        // (review 460 F1). Elsewhere the method starts at `async`, as Marko's.
        const start =
          asyncMethod && !attr.trigger
            ? asyncMethod.start
            : typeParams
              ? typeParams.start
              : params.start;

        const method: Ranges.AttrMethod = {
          start,
          end,
          params,
          typeParams,
          async: asyncMethod !== undefined,
          body: {
            start: child.start - 1, // include {
            end,
            value: {
              start: child.start,
              end: child.end,
            },
          },
        };
        // MX (decision 182): an attribute trigger's method is its value.
        if (attr.trigger) announceAttrTrigger(this, attr, undefined, method);
        else this.options.onAttrMethod?.(method);
        this.exitState();
        break;
      }

      case ATTR_STAGE.TYPE_PARAMS: {
        const start = child.start - 1; // include <
        const end = ++this.pos; // include >

        if (!this.consumeWhitespaceIfBefore("(")) {
          flushPendingAsync(this, attr);
          return this.emitError(
            child,
            ErrorCode.INVALID_ATTR_TYPE_PARAMS,
            "Attribute cannot contain type parameters unless it is a shorthand method",
          );
        }

        attr.typeParams = {
          start,
          end,
          value: {
            start: child.start,
            end: child.end,
          },
        };

        break;
      }

      case ATTR_STAGE.TRIGGER_VALUE: {
        if (child.start === child.end) {
          return this.emitError(
            child,
            ErrorCode.INVALID_ATTRIBUTE_VALUE,
            "Missing value for attribute",
          );
        }

        if (!this.isConcise && detectAmbiguousCloseAngleBracket(this, child)) {
          return;
        }

        announceAttrTrigger(
          this,
          attr,
          { start: child.start, end: child.end },
          undefined,
        );
        this.exitState();
        break;
      }

      case ATTR_STAGE.VALUE: {
        if (child.start === child.end) {
          return this.emitError(
            child,
            ErrorCode.INVALID_ATTRIBUTE_VALUE,
            "Missing value for attribute",
          );
        }

        if (!this.isConcise && detectAmbiguousCloseAngleBracket(this, child)) {
          return;
        }

        if (attr.spread) {
          this.options.onAttrSpread?.({
            start: attr.valueStart,
            end: child.end,
            value: {
              start: child.start,
              end: child.end,
            },
          });
        } else {
          this.options.onAttrValue?.({
            start: attr.valueStart,
            end: child.end,
            bound: attr.bound,
            value: {
              start: child.start,
              end: child.end,
            },
          });
        }

        this.exitState();
        break;
      }
    }
  },
};

/**
 * Enters an attribute value's `EXPRESSION` at the current position.
 * `attrValue` (MX) arms the after-value rule; without it, decision 146
 * addendum 5's single-atom default value still is followed by name sugar.
 */
function enterAttrValue(parser: Parser, attrValue: boolean) {
  const expr = parser.enterState(STATE.EXPRESSION);
  expr.attrValue = attrValue;
  // A loaded expression trigger on `:` replaces built-in atoms, and with
  // them this exemption (the coexistence rule; 182 addendum 1 item 3).
  expr.defaultAtom = !attrValue && parser.syntax.builtInAtoms;
  expr.atoms = true; // MX: decision 156
  expr.operators = true;
  expr.terminatedByWhitespace = true;
  expr.shouldTerminate = parser.isConcise
    ? parser.activeTag!.stage === TAG_STAGE.ATTR_GROUP
      ? shouldTerminateConciseGroupedAttrValue
      : shouldTerminateConciseAttrValue
    : shouldTerminateHtmlAttrValue;
}

/**
 * MX (decision 182): at an attribute name's first character, lexes an
 * attribute trigger when its matcher matches. The match is the whole name.
 * After it (and optional whitespace, as after a name): `=` or `:=` starts a
 * value lexed exactly as a named attribute's (announced with its
 * `operator`); `(params) { body }`, or `<T>(params) { body }`, is a method
 * value lexed as a named attribute's method shorthand (an `async` before
 * the trigger modifies it); `(args)` with no body are its `args`, as a named
 * attribute's arguments (an `=` / `:=` value may follow them, and the
 * trigger is announced when the attribute ends); anything but the end of
 * the name (whitespace, `,`, the end of the tag or line) is an error. A row with `value: "refuse"` takes no value: `=`, `:=` or `(`
 * there is an error positioned at it. Returns whether it consumed the
 * trigger.
 */
function lexAttrTrigger(parser: Parser, attr: AttrMeta, data: string) {
  const start = parser.pos;
  const hit = matchTrigger(parser.syntax.attribute!, data, start);
  if (!hit) return false;
  const { trigger, end } = hit;
  attr.trigger = {
    trigger,
    text: { start, end },
    fresh: parser.recordTrigger(trigger, start, end),
    args: undefined,
    announced: false,
  };
  parser.pos = end;

  // `&a = 1`: whitespace before the `=`, exactly as after a name (in
  // concise mode a line break ends the attribute).
  const skip = parser.isConcise ? isIndentCode : isWhitespaceCode;
  let at = end;
  while (at < parser.maxPos && skip(data.charCodeAt(at))) at++;
  const code = data.charCodeAt(at);
  const bound = code === CODE.COLON && data.charCodeAt(at + 1) === CODE.EQUAL;

  if (
    trigger.refusesValue &&
    (code === CODE.EQUAL || code === CODE.OPEN_PAREN || bound)
  ) {
    flushPendingAsync(parser, attr);
    parser.emitError(
      { start: at, end: at + (bound ? 2 : 1) },
      ErrorCode.INVALID_ATTRIBUTE_VALUE,
      `The \`${data.slice(start, end)}\` shorthand takes no value.`,
    );
    return true;
  }

  if (
    !trigger.refusesValue &&
    (code === CODE.OPEN_PAREN ||
      // Type parameters; never `</` or `<!--`, which end the attribute.
      (code === CODE.OPEN_ANGLE_BRACKET &&
        data.charCodeAt(at + 1) !== CODE.FORWARD_SLASH &&
        data.charCodeAt(at + 1) !== CODE.EXCLAMATION))
  ) {
    // A method value: the attribute's own `(` and `<` branches lex it, as
    // after a name; a pending `async` stays pending until the body shows.
    attr.stage = ATTR_STAGE.NAME;
    parser.pos = at;
    return true;
  }

  flushPendingAsync(parser, attr);
  if (code === CODE.EQUAL || bound) {
    attr.valueStart = at;
    parser.pos = at;
    enterTriggerValue(parser, attr, bound);
    return true;
  }

  if (!endsAttrTriggerAt(parser, data, end)) {
    parser.emitError(
      { start, end: end + 1 },
      ErrorCode.INVALID_ATTRIBUTE_NAME,
      triggerFollowMessage(parser, trigger, { start, end }),
    );
    return true;
  }

  announceAttrTrigger(parser, attr, undefined, undefined);
  parser.exitState();
  return true;
}

/** The error for text after an attribute trigger that cannot follow it. */
function triggerFollowMessage(
  parser: Parser,
  trigger: CompiledTrigger,
  text: Range,
) {
  return `Invalid attribute name. The "${trigger.id}" trigger "${parser.data.slice(text.start, text.end)}" must be followed by whitespace, "="${trigger.refusesValue ? "" : ", a method"} or the end of the tag.`;
}

/**
 * At an attribute trigger's `=` or `:=` (`bound`): enters its value, lexed
 * exactly as a named attribute's (stage `TRIGGER_VALUE`).
 */
function enterTriggerValue(parser: Parser, attr: AttrMeta, bound: boolean) {
  attr.bound = bound;
  attr.stage = ATTR_STAGE.TRIGGER_VALUE;
  parser.pos += bound ? 2 : 1; // skip = or :=
  parser.consumeWhitespace();
  enterAttrValue(parser, true);
}

/** Whether an attribute trigger's text may end at `pos`: whitespace, `,`, EOF, or the end of the tag, line or attribute group. */
function endsAttrTriggerAt(parser: Parser, data: string, pos: number) {
  const code = data.charCodeAt(pos);
  if (code !== code || isWhitespaceCode(code) || code === CODE.COMMA) {
    return true;
  }
  if (parser.isConcise) {
    return (
      code === CODE.SEMICOLON ||
      (code === CODE.CLOSE_SQUARE_BRACKET &&
        parser.activeTag!.stage === TAG_STAGE.ATTR_GROUP)
    );
  }
  return (
    code === CODE.CLOSE_ANGLE_BRACKET ||
    (code === CODE.FORWARD_SLASH &&
      data.charCodeAt(pos + 1) === CODE.CLOSE_ANGLE_BRACKET)
  );
}

function announceAttrTrigger(
  parser: Parser,
  attr: AttrMeta,
  value: Range | undefined,
  method: Ranges.AttrMethod | undefined,
) {
  const state = attr.trigger!;
  state.announced = true;
  const { trigger, text, fresh, args } = state;
  if (!fresh) return;
  parser.options.onTrigger?.({
    id: trigger.id,
    position: "attribute",
    standIn: trigger.standIn,
    start: method
      ? Math.min(text.start, method.start, attr.asyncMethod?.start ?? text.start)
      : text.start,
    end: method ? method.end : value ? value.end : args ? args.end : text.end,
    text,
    ...(args && { args }),
    ...(value && { value, operator: attr.bound ? ":=" : "=" }),
    ...(method && { method }),
  });
}

/**
 * In HTML mode a ">" after an unenclosed attribute always ends the tag, but a
 * whitespace preceded ">" is often intended as a comparison operator, eg
 * `<if=count > 10>` which actually parses as `<if=count>` followed by the
 * body content " 10>". Both interpretations are valid so this is truly
 * ambiguous; rather than silently picking one, when the attribute is
 * followed by whitespace and a ">" this looks ahead for the telltale tail of
 * a split expression — operator connected operands ending in a second ">"
 * (or "/>") on the same line — and reports an error that shows how to
 * disambiguate. Anything else (including anything this lookahead does not
 * understand, such as string literals) keeps the existing tag-end behavior.
 */
function detectAmbiguousCloseAngleBracket(parser: Parser, child: Meta) {
  const { data, maxPos } = parser;
  let pos = parser.pos;

  // Only an expression that stopped at horizontal whitespace followed by ">"
  // on the same line is ambiguous.
  if (!isIndentCode(data.charCodeAt(pos))) return false;
  do pos++;
  while (isIndentCode(data.charCodeAt(pos)));
  if (data.charCodeAt(pos) !== CODE.CLOSE_ANGLE_BRACKET) return false;

  let sawOperand = false;
  // Set when an operand ended and another operand would need an operator
  // between them, eg text like "10 items>" is not a split expression.
  let operatorPending = false;
  // Tracks "(" and "[" nesting; the tag can only end at the top level.
  let groupDepth = 0;
  // A whitespace preceded ">=" is always continued as a comparison by
  // shouldTerminateHtmlAttrValue, so the ">" here is never part of a ">=".
  let lookPos = pos + 1;

  for (; lookPos < maxPos; lookPos++) {
    const code = data.charCodeAt(lookPos);

    // A ">=" (anywhere) or a grouped ">" is a comparison, not the tag end.
    if (
      code === CODE.CLOSE_ANGLE_BRACKET &&
      (groupDepth || data.charCodeAt(lookPos + 1) === CODE.EQUAL)
    ) {
      if (data.charCodeAt(lookPos + 1) === CODE.EQUAL) lookPos++; // skip =
      operatorPending = false;
      continue;
    }

    if (
      !groupDepth &&
      (code === CODE.CLOSE_ANGLE_BRACKET ||
        (code === CODE.FORWARD_SLASH &&
          data.charCodeAt(lookPos + 1) === CODE.CLOSE_ANGLE_BRACKET))
    ) {
      // Ignore horizontal whitespace between the final operand and the ">".
      let exprEnd = lookPos;
      while (isIndentCode(data.charCodeAt(exprEnd - 1))) exprEnd--;
      if (sawOperand && isOperandEndAt(data, exprEnd - 1)) {
        const expression = data.slice(child.start, exprEnd);
        const tail = data
          .slice(pos + 1, lookPos + (code === CODE.FORWARD_SLASH ? 2 : 1))
          .trim();
        parser.emitError(
          { start: child.start, end: exprEnd },
          ErrorCode.AMBIGUOUS_ATTRIBUTE_VALUE,
          'Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "' +
            expression +
            '" was intended as a single expression, wrap it in parentheses, eg "=(' +
            expression +
            ')". If the tag was instead meant to end at the first ">", leaving "' +
            tail +
            '" as body content, remove the whitespace before that ">".',
        );
        return true;
      }
      return false;
    }

    const wordWidth = wordWidthAt(data, lookPos);
    if (wordWidth > 0) {
      if (operatorPending) return false;
      sawOperand = true;
      lookPos += wordWidth - 1; // a surrogate pair is one character
      continue;
    }

    if (isIndentCode(code)) {
      if (sawOperand && isOperandEndAt(data, lookPos - 1)) {
        operatorPending = true;
      }
      continue;
    }

    switch (code) {
      case CODE.EQUAL:
        // An "=>" arrow connects operands; a bare "=" is not understood.
        if (data.charCodeAt(lookPos + 1) !== CODE.CLOSE_ANGLE_BRACKET) {
          return false;
        }
        lookPos++; // skip the ">" of "=>"
        operatorPending = false;
        continue;
      case CODE.FORWARD_SLASH: {
        // A "/" is only understood as division; where a regex could start
        // (no operand before it) this does not look like a split expression.
        let prevPos = lookPos - 1;
        while (isIndentCode(data.charCodeAt(prevPos))) prevPos--;
        if (!isOperandEndAt(data, prevPos)) return false;
        operatorPending = false;
        continue;
      }
      case CODE.OPEN_PAREN:
        groupDepth++;
        operatorPending = false;
        continue;
      case CODE.OPEN_SQUARE_BRACKET:
        groupDepth++;
        operatorPending = false;
        continue;
      case CODE.CLOSE_PAREN:
      case CODE.CLOSE_SQUARE_BRACKET:
        // An unmatched closer means this is not a split expression.
        if (!groupDepth) return false;
        groupDepth--;
        operatorPending = false;
        continue;
      case CODE.AMPERSAND:
      case CODE.ASTERISK:
      case CODE.CARET:
      case CODE.COLON:
      case CODE.EXCLAMATION:
      case CODE.HYPHEN:
      case CODE.PERCENT:
      case CODE.PERIOD:
      case CODE.PIPE:
      case CODE.PLUS:
      case CODE.QUESTION:
      case CODE.TILDE:
        operatorPending = false;
        continue;
      default:
        // Newlines, "<", quotes, and anything else not recognized above
        // means this does not look like a split expression.
        return false;
    }
  }

  return false;
}

/** Whether an operand ends at index `at`: `)`, `]` or a word character. */
function isOperandEndAt(data: string, at: number) {
  switch (data.charCodeAt(at)) {
    case CODE.CLOSE_PAREN:
    case CODE.CLOSE_SQUARE_BRACKET:
      return true;
    default:
      return wordWidthBefore(data, at) > 0;
  }
}

/**
 * Whether a method name, or a default attribute method's params, follows the
 * keyword. Anything else keeps `async` ordinary, eg `<script async src=x>`.
 */
function isAsyncMethodPrefix(parser: Parser, name: Range) {
  const { data } = parser;
  if (
    name.end - name.start !== 5 ||
    // Cheap reject for the many five character attribute names, eg
    // "class", "style", "value", before comparing the rest.
    data.charCodeAt(name.start) !== CODE.LOWER_A ||
    !parser.lookAheadFor("async", name.start)
  ) {
    return false;
  }

  // In concise mode a newline ends the attribute, so a name on the following
  // line belongs to a separate attribute and cannot be this method's name.
  const skip = parser.isConcise ? isIndentCode : isWhitespaceCode;
  let pos = parser.pos;
  while (skip(data.charCodeAt(pos))) pos++;

  const code = data.charCodeAt(pos);
  return (
    wordWidthAt(data, pos) > 0 || // the method name
    code === CODE.OPEN_PAREN || // a default attribute method's params
    // a default attribute method's type params, but not a close tag
    (code === CODE.OPEN_ANGLE_BRACKET &&
      data.charCodeAt(pos + 1) !== CODE.FORWARD_SLASH) ||
    // MX (decision 182): an attribute trigger, which may take a method
    // value; `lexAttrTrigger` flushes `async` when none follows.
    (parser.syntax.attribute !== null &&
      matchTrigger(parser.syntax.attribute, data, pos) !== undefined)
  );
}

/**
 * Replays a deferred `async`, and the name held behind it, as attribute names
 * once the attribute turns out not to be a shorthand method.
 */
function flushPendingAsync(parser: Parser, attr: AttrMeta) {
  if (attr.async) {
    parser.options.onAttrName?.(attr.async);
    attr.async = undefined;
    if (attr.name) parser.options.onAttrName?.(attr.name);
  }
}

function ensureAttrName(parser: Parser, attr: AttrMeta) {
  if (!attr.name) {
    parser.options.onAttrName?.({
      start: attr.start,
      end: attr.start,
    });
  }
}

function shouldTerminateHtmlAttrName(code: number, data: string, pos: number) {
  switch (code) {
    case CODE.COMMA:
    case CODE.EQUAL:
    case CODE.OPEN_PAREN:
    case CODE.CLOSE_ANGLE_BRACKET:
    case CODE.OPEN_ANGLE_BRACKET:
      return true;
    case CODE.COLON:
      return data.charCodeAt(pos + 1) === CODE.EQUAL;
    case CODE.FORWARD_SLASH:
      return data.charCodeAt(pos + 1) === CODE.CLOSE_ANGLE_BRACKET;
    default:
      return false;
  }
}

export function shouldTerminateHtmlAttrValue(
  this: STATE.ExpressionMeta,
  code: number,
  data: string,
  pos: number,
) {
  switch (code) {
    case CODE.COMMA:
      return true;
    case CODE.FORWARD_SLASH:
      return data.charCodeAt(pos + 1) === CODE.CLOSE_ANGLE_BRACKET;
    case CODE.CLOSE_ANGLE_BRACKET: {
      // We only look around the ">" if we're not at the start of the expression
      // otherwise this would match something like "<span class=>".
      if (pos === this.start) return true;
      // Add special case for =>
      if (data.charCodeAt(pos - 1) === CODE.EQUAL) return false;
      // A whitespace preceded ">" immediately followed by "=" is always a ">="
      // comparison operator, since a closed tag would instead put the "=" in
      // its body content, eg `<if=count >= 10>`.
      return !(
        isUnicodeWhitespaceCode(data.charCodeAt(pos - 1)) &&
        data.charCodeAt(pos + 1) === CODE.EQUAL
      );
    }
    default:
      return false;
  }
}

function shouldTerminateConciseAttrName(
  code: number,
  data: string,
  pos: number,
) {
  switch (code) {
    case CODE.COMMA:
    case CODE.EQUAL:
    case CODE.OPEN_PAREN:
    case CODE.SEMICOLON:
    case CODE.OPEN_ANGLE_BRACKET:
      return true;
    case CODE.COLON:
      return data.charCodeAt(pos + 1) === CODE.EQUAL;
    case CODE.HYPHEN:
      return (
        data.charCodeAt(pos + 1) === CODE.HYPHEN &&
        isUnicodeWhitespaceCode(data.charCodeAt(pos - 1))
      );
    default:
      return false;
  }
}

export function shouldTerminateConciseAttrValue(
  code: number,
  data: string,
  pos: number,
) {
  switch (code) {
    case CODE.COMMA:
    case CODE.SEMICOLON:
      return true;
    case CODE.HYPHEN:
      return (
        data.charCodeAt(pos + 1) === CODE.HYPHEN &&
        isUnicodeWhitespaceCode(data.charCodeAt(pos - 1))
      );
    default:
      return false;
  }
}

function shouldTerminateConciseGroupedAttrName(
  code: number,
  data: string,
  pos: number,
) {
  switch (code) {
    case CODE.COMMA:
    case CODE.EQUAL:
    case CODE.OPEN_PAREN:
    case CODE.CLOSE_SQUARE_BRACKET:
    case CODE.OPEN_ANGLE_BRACKET:
      return true;
    case CODE.COLON:
      return data.charCodeAt(pos + 1) === CODE.EQUAL;
    default:
      return false;
  }
}

function shouldTerminateConciseGroupedAttrValue(code: number) {
  switch (code) {
    case CODE.COMMA:
    case CODE.CLOSE_SQUARE_BRACKET:
      return true;
    default:
      return false;
  }
}
