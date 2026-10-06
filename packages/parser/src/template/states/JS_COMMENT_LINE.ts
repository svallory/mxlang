import {
  type Meta,
  type Ranges,
  STATE,
  type StateDefinition,
} from "../internal.ts";
import * as CODE from "../util/codes.ts";
import * as TagType from "../util/tag-type.ts";

// We enter STATE.JS_COMMENT_LINE after we encounter a "//" sequence
// when parsing JavaScript code.
// We leave STATE.JS_COMMENT_LINE when we see a newline character.
export const JS_COMMENT_LINE: StateDefinition = {
  name: "JS_COMMENT_LINE",

  enter(parent, start) {
    return {
      state: JS_COMMENT_LINE,
      parent,
      start,
      end: start,
    };
  },

  exit() {},

  parse(data, maxPos, comment) {
    while (this.pos < maxPos) {
      const code = data.charCodeAt(this.pos);
      if (code === CODE.NEWLINE || code === CODE.CARRIAGE_RETURN) {
        // Leave pos at the newline for the parent state to handle.
        this.exitState();
        return;
      } else if (
        !this.isConcise &&
        code === CODE.OPEN_ANGLE_BRACKET &&
        this.activeTag?.type === TagType.text &&
        isInTextBody(comment) &&
        STATE.checkForClosingTag(this)
      ) {
        // We reached the closing tag of a text-only tag (eg "<script>//foo</script>").
        // checkForClosingTag exited this comment; also exit the text content state.
        this.exitState();
        return;
      } else {
        this.pos++;
      }
    }
    // EOF
    this.exitState();
  },

  /* node:coverage ignore next */ // never has child states
  return() {},
};

/**
 * MX (template-parser-comment-in-text-tag-open-crash): whether a comment is
 * in a text tag's body (`<script>// </script>` closes the tag there), not in
 * an expression of its open tag (`<script x=1 // </script>`), where the
 * close-tag check used to end the tag inside its own open tag.
 */
function isInTextBody(comment: Meta) {
  for (let range = comment.parent; range; range = range.parent) {
    if (range.state === STATE.OPEN_TAG) return false;
    if (range.state === STATE.PARSED_TEXT_CONTENT) return true;
  }
  return false;
}

/**
 * The range of a JavaScript line or block comment that a state returned from,
 * with the delimiters stripped from its value.
 */
export function getJSCommentRange(comment: Meta): Ranges.Value {
  return {
    start: comment.start,
    end: comment.end,
    value: {
      start: comment.start + 2, // strip // or /*
      end:
        comment.state === STATE.JS_COMMENT_BLOCK
          ? comment.end - 2 // strip */
          : comment.end,
    },
  };
}
