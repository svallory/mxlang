import {
  isWhitespaceCode,
  matchesCloseCurlyBrace,
  type Meta,
  Parser,
  type Ranges,
  STATE,
  type StateDefinition,
} from "../internal.ts";
import * as CODE from "../util/codes.ts";
import * as ErrorCode from "../util/error-code.ts";
import type { TagType as TagTypeValue } from "../util/constants.ts";
import * as TagType from "../util/tag-type.ts";
import { prepareScriptlet } from "./INLINE_SCRIPT.ts";

export interface TagNameMeta extends Meta, Ranges.Template {
  shorthandCode: -1 | typeof CODE.NUMBER_SIGN | typeof CODE.PERIOD;
}

// We enter STATE.TAG_NAME after we encounter a "<"
// followed by a non-special character
export const TAG_NAME: StateDefinition<TagNameMeta> = {
  name: "TAG_NAME",

  enter(parent, start) {
    return {
      state: TAG_NAME as StateDefinition,
      parent,
      start,
      end: start,
      shorthandCode: -1,
      expressions: [],
      quasis: [{ start, end: start }],
    };
  },

  exit(tagName) {
    const { start, end, quasis, expressions } = tagName;
    const last = quasis[quasis.length - 1];
    if (last.end < end) last.end = end;

    switch (tagName.shorthandCode) {
      case CODE.NUMBER_SIGN:
        if (this.activeTag!.hasShorthandId) {
          return this.emitError(
            tagName,
            ErrorCode.INVALID_TAG_SHORTHAND,
            "Multiple shorthand ID parts are not allowed on the same tag",
          );
        }

        this.activeTag!.hasShorthandId = true;
        this.options.onTagShorthandId?.({
          start,
          end,
          quasis,
          expressions,
        });
        break;
      case CODE.PERIOD:
        this.options.onTagShorthandClass?.({
          start,
          end,
          quasis,
          expressions,
        });
        break;
      default: {
        const tag = this.activeTag!;
        // MX: the syntax table's `tagTypes`,
        // computed before the parse, decides; a handler that still returns
        // a type (`@marko/compiler`'s taglib, bundled into core) wins.
        const tagType =
          this.options.onOpenTagName?.({
            start,
            end,
            quasis,
            expressions,
          }) ?? tableTagType(this, tagName, expressions.length > 0);
        tag.tagName = tagName;

        if (tagType) {
          tag.type = tagType;

          if (tagType === TagType.statement) {
            if (!tag.concise) {
              return this.emitError(
                tagName,
                ErrorCode.RESERVED_TAG_NAME,
                `The "${this.read(
                  tagName,
                )}" tag is reserved and cannot be used as an HTML tag.`,
              );
            }

            if (tag.parentTag) {
              return this.emitError(
                tagName,
                ErrorCode.ROOT_TAG_ONLY,
                `"${this.read(
                  tagName,
                )}" can only be used at the root of the template.`,
              );
            }

            prepareStatement(
              this.enterState(STATE.EXPRESSION),
              this,
              this.pos + 1,
            );
          }
        }

        break;
      }
    }
  },

  parse(data, maxPos, tagName) {
    const shorthands = this.syntax.tagShorthands;
    while (this.pos < maxPos) {
      const code = data.charCodeAt(this.pos);

      // EOL terminates the tag name
      if (code === CODE.NEWLINE || code === CODE.CARRIAGE_RETURN) {
        this.activeTag!.shorthandEnd = this.pos;
        this.exitState();
        return; // parent handles the newline
      }

      if (
        code === CODE.DOLLAR &&
        data.charCodeAt(this.pos + 1) === CODE.OPEN_CURLY_BRACE
      ) {
        this.pos += 2; // skip ${
        const expr = this.enterState(STATE.EXPRESSION);
        expr.shouldTerminate = matchesCloseCurlyBrace;
        // MX: every `${}` is an expression position.
        expr.triggers = true;
        return;
      } else if (endsTagName(this, code, data.charCodeAt(this.pos + 1))) {
        this.activeTag!.shorthandEnd = this.pos;
        this.exitState();
        return; // parent handles the terminator char
      } else if (
        !shorthands &&
        (code === CODE.PERIOD || code === CODE.NUMBER_SIGN)
      ) {
        // MX (`tagShorthands: false`): no shorthand. `#` is refused, and so
        // is a head that starts with `.` (an implicit `div`); any other `.`
        // continues the name, as in a JSX member tag, so long as a name part
        // follows it.
        if (code === CODE.NUMBER_SIGN) {
          return this.emitError(
            { start: this.pos, end: this.pos + 1 },
            ErrorCode.MX_NO_TAG_SHORTHAND,
            NO_ID_SHORTHAND,
          );
        }

        if (this.pos === tagName.start) {
          return this.emitError(
            { start: this.pos, end: this.pos + 1 },
            ErrorCode.MX_NO_TAG_SHORTHAND,
            NO_CLASS_SHORTHAND,
          );
        }

        const last = tagName.expressions[tagName.expressions.length - 1];
        if (last && last.end === this.pos) {
          return this.emitError(
            { start: this.pos, end: this.pos + 1 },
            ErrorCode.MX_INVALID_TAG_NAME,
            DOT_AFTER_PLACEHOLDER,
          );
        }

        // The run of dots: `a..b`, `a.`, `a..` all leave an empty part.
        let runEnd = this.pos + 1;
        while (runEnd < maxPos && data.charCodeAt(runEnd) === CODE.PERIOD) {
          runEnd++;
        }

        if (
          runEnd > this.pos + 1 ||
          runEnd >= maxPos ||
          endsTagName(
            this,
            data.charCodeAt(runEnd),
            data.charCodeAt(runEnd + 1),
          )
        ) {
          return this.emitError(
            { start: this.pos, end: runEnd },
            ErrorCode.MX_INVALID_TAG_NAME,
            EMPTY_NAME_PART,
          );
        }

        this.pos = runEnd;
      } else if (code === CODE.PERIOD || code === CODE.NUMBER_SIGN) {
        this.exitState();
        const shorthand = this.enterState(TAG_NAME);
        shorthand.shorthandCode = code as
          | typeof CODE.PERIOD
          | typeof CODE.NUMBER_SIGN;
        shorthand.quasis[0].start = ++this.pos; // skip . or #
        return; // new TAG_NAME starts at pos+1
      } else {
        this.pos++;
      }
    }

    // EOF
    this.exitState();
  },

  return(child, tagName) {
    if (child.start === child.end) {
      this.emitError(
        child,
        ErrorCode.MALFORMED_PLACEHOLDER,
        "Invalid placeholder, the expression cannot be missing",
      );
    }

    const { quasis, expressions } = tagName;
    const start = child.start - 2; // include ${
    const end = ++this.pos; // include }
    const nextStart = end;
    expressions.push({
      start,
      end,
      value: {
        start: child.start,
        end: child.end,
      },
    });

    quasis[quasis.length - 1].end = start;
    quasis.push({ start: nextStart, end: nextStart });
  },
};

/**
 * Whether `code` (followed by `next`) ends a tag name: a line break, white
 * space, or one of the characters that start what follows the name.
 */
function endsTagName(parser: Parser, code: number, next: number): boolean {
  return (
    code === CODE.NEWLINE ||
    code === CODE.CARRIAGE_RETURN ||
    isWhitespaceCode(code) ||
    code === CODE.EQUAL ||
    (code === CODE.COLON && next === CODE.EQUAL) ||
    code === CODE.OPEN_PAREN ||
    code === CODE.FORWARD_SLASH ||
    code === CODE.PIPE ||
    code === CODE.OPEN_ANGLE_BRACKET ||
    code === CODE.COMMA ||
    (parser.isConcise
      ? code === CODE.SEMICOLON || code === CODE.OPEN_SQUARE_BRACKET
      : code === CODE.CLOSE_ANGLE_BRACKET)
  );
}

// The messages of `tagShorthands: false`: each states the rule and the fix.
const NO_ID_SHORTHAND =
  "`#` is not allowed in a tag name: this file's dialect has no `#id` shorthand; write the id as an attribute (`id=\"main\"`) or drop the `#`";
const NO_CLASS_SHORTHAND =
  'a tag name cannot start with `.`: this file\'s dialect has no `.class` shorthand and no implicit `div`; name the tag and write the class as an attribute (`class="x"`)';
const EMPTY_NAME_PART =
  "a tag name cannot have an empty part: a `.` must be followed by a name, as in `billing.InvoiceVoided`, and cannot end the name or follow another `.`";
const DOT_AFTER_PLACEHOLDER =
  "a `.` cannot follow a `${…}` in a tag name: a dotted name is plain text (`billing.InvoiceVoided`), or write the whole name as one placeholder";

// Sets up a root statement's expression, whose code starts at `pos`.
export function prepareStatement(
  expr: STATE.ExpressionMeta,
  parser: Parser,
  pos = parser.pos,
) {
  expr.consumeIndentedContent = true;
  prepareScriptlet(expr, parser, pos);
}

/**
 * MX: a tag's type from the table, keyed by the
 * full written static name (`input:email` is its own key). A dynamic name
 * or an attribute tag (`@name`) is never looked up; a name absent is html;
 * `statement` applies only on a concise line, so the HTML-mode spelling of
 * a statement word stays html.
 */
function tableTagType(
  parser: Parser,
  name: { start: number; end: number },
  dynamic: boolean,
): TagTypeValue | undefined {
  const { tagTypes } = parser.syntax;
  if (dynamic || tagTypes.size === 0) return undefined;
  const written = parser.data.slice(name.start, name.end);
  if (written[0] === "@") return undefined;
  const type = tagTypes.get(written);
  return type === TagType.statement && !parser.activeTag!.concise
    ? undefined
    : type;
}
