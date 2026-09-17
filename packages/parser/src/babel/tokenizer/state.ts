import type { OptionsWithDefaults } from "../options.ts";
import type { CommentWhitespace } from "../parser/comments";
import { Position } from "../util/location.ts";

import { types as ct, type TokContext } from "./context.ts";
import { tt, type TokenType } from "./types.ts";
import type { Errors } from "../parse-error.ts";
import type { ParseError } from "../parse-error.ts";
// MX FORK: the enclosing-syntax parent stack `mxRegionPositionCheck` reads
// (see `../../mx/region-context.ts`). Only pushed/popped when a host set
// that option; see `parser/expression.ts`/`parser/statement.ts`.
import type { MxRegionParentFrame } from "../../mx/region-context.ts";

export type DeferredStrictError =
  | typeof Errors.StrictNumericEscape
  | typeof Errors.StrictOctalLiteral;

type TopicContextState = {
  // When a topic binding has been currently established,
  // then this is 1. Otherwise, it is 0. This is forwards compatible
  // with a future plugin for multiple lexical topics.
  maxNumOfResolvableTopics: number;
  // When a topic binding has been currently established, and if that binding
  // has been used as a topic reference `#`, then this is 0. Otherwise, it is
  // `null`. This is forwards compatible with a future plugin for multiple
  // lexical topics.
  maxTopicIndex: null | 0;
};

export const enum LoopLabelKind {
  Loop = 1,
  Switch = 2,
}

// Upstream packs @bit-decorated boolean accessors into a single bit-packed
// `flags` field via a build-time Babel transform (scripts/babel-plugin-bit-decorator).
// We don't run that transform standalone, so this reimplements the same
// packing (mask starting at 1, left-shifted per field, in declaration order)
// as a native stage-3 accessor decorator over `this.flags`.
let nextBitMask = 1;
function bit(
  _target: ClassAccessorDecoratorTarget<State, boolean>,
  context: ClassAccessorDecoratorContext<State, boolean>,
): ClassAccessorDecoratorResult<State, boolean> {
  const mask = nextBitMask;
  nextBitMask <<= 1;
  return {
    init(this: State, v: boolean) {
      if (v) this.flags |= mask;
      return v;
    },
    get(this: State) {
      return (this.flags & mask) > 0;
    },
    set(this: State, v: boolean) {
      if (v) this.flags |= mask;
      else this.flags &= ~mask;
    },
  };
}

export default class State {
  flags: number = 0;

  @bit accessor strict = false;

  startIndex!: number;
  curLine!: number;
  lineStart!: number;

  // And, if locations are used, the {line, column} object
  // corresponding to those offsets
  startLoc!: Position;
  endLoc!: Position;

  init({
    strictMode,
    sourceType,
    startIndex,
    startLine,
    startColumn,
  }: OptionsWithDefaults): void {
    this.strict =
      strictMode === false
        ? false
        : strictMode === true
          ? true
          : sourceType === "module";

    this.startIndex = startIndex;
    this.curLine = startLine;
    this.lineStart = -startColumn;
    this.startLoc = this.endLoc = new Position(
      startLine,
      startColumn,
      startIndex,
    );
  }

  errors: ParseError<any>[] = [];

  // Used to signify the start of a potential arrow function
  potentialArrowAt: number = -1;

  // Used to signify the start of an expression which looks like a
  // typed arrow function, but it isn't
  // e.g. a ? (b) : c => d
  //          ^
  noArrowAt: number[] = [];

  // Used to signify the start of an expression whose params, if it looks like
  // an arrow function, shouldn't be converted to assignable nodes.
  // This is used to defer the validation of typed arrow functions inside
  // conditional expressions.
  // e.g. a ? (b) : c => d
  //          ^
  noArrowParamsConversionAt: number[] = [];

  // Flags to track
  @bit accessor maybeInArrowParameters = false;
  @bit accessor inType = false;
  @bit accessor noAnonFunctionType = false;
  @bit accessor hasFlowComment = false;
  @bit accessor isAmbientContext = false;
  @bit accessor inAbstractClass = false;
  @bit accessor inDisallowConditionalTypesContext = false;

  // For the Hack-style pipelines plugin
  topicContext: TopicContextState = {
    maxNumOfResolvableTopics: 0,
    maxTopicIndex: null,
  };

  // For the F#-style pipelines plugin
  @bit accessor soloAwait = false;
  @bit accessor inFSharpPipelineDirectBody = false;

  // Labels in scope.
  labels: {
    kind: LoopLabelKind | null;
    name?: string | null;
    statementStart?: number;
  }[] = [];

  commentsLen = 0;
  // Comment attachment store
  commentStack: CommentWhitespace[] = [];

  // The current position of the tokenizer in the input.
  pos: number = 0;

  // Properties of the current token:
  // Its type
  type: TokenType = tt.eof;

  // For tokens that include more information than their type, the value
  value: any = null;

  // Its start and end offset
  start: number = 0;
  end: number = 0;

  // Position information for the previous token
  // this is initialized when generating the second token.
  lastTokEndLoc: Position | null = null;
  // this is initialized when generating the second token.
  lastTokStartLoc: Position | null = null;

  // The context stack is used to track whether the apostrophe "`" starts
  // or ends a string template
  context: TokContext[] = [ct.brace];

  // MX FORK: the minimal syntactic-parent stack `mxRegionPositionCheck`
  // consults. Empty and untouched unless that option is set — see
  // `../../mx/region-context.ts`.
  mxRegionParents: MxRegionParentFrame[] = [];

  // MX FORK: a transient handoff from `parseExprList`'s loop to
  // `parseExprListItem`'s boundary push — the index of the list item about
  // to be parsed, so a decorator's own argument list can record which
  // argument (transitively) encloses a region (`MxRegionContext.argumentIndex`,
  // `../../mx/region-context.ts`). Read and cleared by the very next
  // `parseExprListItem` call; `null` the rest of the time.
  mxNextBoundaryIndex: number | null = null;

  // Used to track whether a JSX element is allowed to form
  @bit accessor canStartJSXElement = true;

  // Used to signal to callers of `readWord1` whether the word
  // contained any escape sequences. This is needed because words with
  // escape sequences must not be interpreted as keywords.
  @bit accessor containsEsc = false;

  // Used to track invalid escape sequences in template literals,
  // that must be reported if the template is not tagged.
  firstInvalidTemplateEscapePos: null | Position = null;

  @bit accessor hasTopLevelAwait = false;

  // This property is used to track the following errors
  // - StrictNumericEscape
  // - StrictOctalLiteral
  //
  // in a literal that occurs prior to/immediately after a "use strict" directive.

  // todo(JLHwung): set strictErrors to null and avoid recording string errors
  // after a non-directive is parsed
  strictErrors = new Map<number, [DeferredStrictError, Position]>();

  // Tokens length in token store
  tokensLength: number = 0;

  /**
   * When we add a new property, we must manually update the `clone` method
   * @see State#clone
   */

  curPosition(): Position {
    return new Position(
      this.curLine,
      this.pos - this.lineStart,
      this.pos + this.startIndex,
    );
  }

  clone(): State {
    const state = new State();
    state.flags = this.flags;
    state.startIndex = this.startIndex;
    state.curLine = this.curLine;
    state.lineStart = this.lineStart;
    state.startLoc = this.startLoc;
    state.endLoc = this.endLoc;
    state.errors = this.errors.slice();
    state.potentialArrowAt = this.potentialArrowAt;
    state.noArrowAt = this.noArrowAt.slice();
    state.noArrowParamsConversionAt = this.noArrowParamsConversionAt.slice();
    state.topicContext = this.topicContext;
    state.labels = this.labels.slice();
    state.commentsLen = this.commentsLen;
    state.commentStack = this.commentStack.slice();
    state.pos = this.pos;
    state.type = this.type;
    state.value = this.value;
    state.start = this.start;
    state.end = this.end;
    state.lastTokEndLoc = this.lastTokEndLoc;
    state.lastTokStartLoc = this.lastTokStartLoc;
    state.context = this.context.slice();
    state.mxRegionParents = this.mxRegionParents.slice();
    state.firstInvalidTemplateEscapePos = this.firstInvalidTemplateEscapePos;
    state.strictErrors = this.strictErrors;
    state.tokensLength = this.tokensLength;

    return state;
  }
}

export type LookaheadState = {
  pos: number;
  value: any;
  type: TokenType;
  start: number;
  end: number;
  context: TokContext[];
  startLoc: Position;
  lastTokEndLoc: Position | null;
  curLine: number;
  lineStart: number;
  curPosition: State["curPosition"];
  /* Used only in readToken_mult_modulo */
  inType: boolean;
  // These boolean properties are not initialized in createLookaheadState()
  // instead they will only be set by the tokenizer
  containsEsc?: boolean;
};
