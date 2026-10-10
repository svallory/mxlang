import {
  type ErrorCode,
  getLines,
  getPosition,
  isUnicodeWhitespaceCode,
  isWhitespaceCode,
  type ParserOptions as Options,
  type Range,
  STATE,
} from "../internal.ts";
import {
  type CompiledSyntax,
  type CompiledTrigger,
  DEFAULT_COMPILED,
  matchTrigger,
  matchValue,
  standInText,
  type TriggerSet,
} from "../syntax.ts";
import * as CODE from "../util/codes.ts";
import * as TagType from "../util/tag-type.ts";

export interface Meta extends Range {
  parent: Meta;
  state: StateDefinition;
}
/**
 * A base position for `parse`: when the source text handed to `parse` is a
 * substring of a larger document, this lets `positionAt`/`locationAt` (and
 * `offsetAt`) report positions relative to that document instead of the
 * substring. Every position/offset a caller passes *in* stays substring
 * relative — only what comes back out is rebased.
 *
 * Ranges passed to handlers (including error ranges) and read back by
 * `read(range)` stay relative to the parsed string, exactly as without these
 * options; `positionAt`, `locationAt` and `offsetAt` are relative to the
 * enclosing file.
 */
export interface ParseOptions {
  /** Character offset of the substring's first character in the document. */
  startOffset?: number;
  /** Zero-based line of the substring's first character in the document. */
  startLine?: number;
  /**
   * Zero-based column of the substring's first character in the document.
   * Applied only to positions on the substring's own first line.
   */
  startColumn?: number;
}
export interface StateDefinition<P extends Meta = Meta> {
  name: string;
  enter: (
    this: Parser,
    parent: Meta,
    pos: number,
  ) => Partial<P & { state: unknown }>;
  exit: (this: Parser, activeRange: P) => void;
  parse: (this: Parser, data: string, maxPos: number, activeRange: P) => void;
  return: (this: Parser, child: Meta, activeRange: P) => void;
}

/**
 * MX: the `claim` option of `createParser`. Asked when an attribute or line
 * trigger's row matches, or a value row matches a whole attribute value,
 * with the row's id, the position and the matched text's range;
 * `undefined` declines (the text lexes as if no row matched), anything else
 * claims it.
 */
export type TriggerClaim = (
  id: string,
  position: "attribute" | "line" | "value",
  start: number,
  end: number,
) => unknown;

/** MX (decision 182): a lexed trigger's span and the stand-in `read` gives it. */
export interface TriggerSpan extends Range {
  standIn: "number" | "identifier";
}

/** The index of the first span of a sorted list starting at or after `start` (binary search). */
function firstAtOrAfter(spans: Range[], start: number) {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid]!.start < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Parser {
  declare public pos: number;
  declare public maxPos: number;
  declare public data: string;
  declare public activeState: StateDefinition;
  declare public activeRange: Meta;
  declare public activeTag: STATE.OpenTagMeta | undefined; // Used to reference the closest open tag
  declare public activeAttr: STATE.AttrMeta | undefined; // Used to reference the current attribute that is being parsed
  declare public indent: string; // Used to build the indent for the current concise line
  declare public isConcise: boolean; // Set to true if parser is currently in concise mode
  declare public beginMixedMode?: boolean; // Used as a flag to mark that the next HTML block should enter the parser into HTML mode
  declare public endingMixedModeAtEOL?: boolean; // Used as a flag to record that the next EOL to exit HTML mode and go back to concise
  declare public textPos: number; // Used to buffer text that is found within the body of a tag
  declare public lines: undefined | number[]; // Keeps track of line indexes to provide line/column info.
  declare public options: Options;
  /** MX (decision 156): the span of every atom lexed so far, in source order. */
  declare public atoms: Range[];
  /**
   * MX (decision 156): each raw open tag, as tag-name start -> open-tag-end
   * start. A read of exactly that range (`@marko/compiler`'s `rawValue`,
   * which `<style>` uses) gets the source, never stand-ins; any other read,
   * a mixed tag name's template (`<foo-${:a}>`) included, gets stand-ins.
   */
  declare public rawOpenTags: Map<number, number>;
  /**
   * MX (decision 182): the syntax table's compiled triggers. The default row
   * compiles to no sets, so every check is one `null` test.
   */
  declare public syntax: CompiledSyntax;
  /**
   * MX (decision 182): the span and stand-in of every trigger lexed so far
   * whose stand-in is not `"keep"`, in source order. Disjoint from `atoms`:
   * neither is lexed inside the other.
   */
  declare public triggers: TriggerSpan[];
  /** MX (decision 182): where the last trigger lexed starts (-1: none). */
  declare public lastTriggerStart: number;
  /** MX: the `claim` option; absent means every matched row claims. */
  declare public claim: TriggerClaim | undefined;
  /** MX: what `claim` answered, by position and trigger start, so a re-lex within this parse asks once. */
  declare public claims: Map<string, unknown>;

  constructor(
    options: Options,
    syntax: CompiledSyntax = DEFAULT_COMPILED,
    claim?: TriggerClaim,
  ) {
    this.options = options;
    this.syntax = syntax;
    this.claim = claim;
  }

  declare public startOffset: number;
  declare public startLine: number;
  declare public startColumn: number;

  read(range: Range) {
    const text = this.data.slice(range.start, range.end);
    if (this.triggers.length) return this.standIn(text, range);
    return this.atoms.length ? this.standInAtoms(text, range) : text;
  }

  /**
   * MX (decision 182): `standInAtoms` generalised to triggers. `text` (the
   * source of `range`) with every atom and every trigger that lies wholly
   * inside `range` replaced by its same-length stand-in (`standInText`), so
   * a sub-parser reads it at the authored offsets. The same raw open tag
   * rule applies; a partly covered span reads the source.
   */
  standIn(text: string, range: Range) {
    if (this.rawOpenTags.get(range.start) === range.end) return text;
    const { atoms, triggers } = this;
    let a = firstAtOrAfter(atoms, range.start);
    let t = firstAtOrAfter(triggers, range.start);
    let out = "";
    let last = range.start;
    for (;;) {
      const atom = atoms[a];
      const trigger = triggers[t];
      let next: Range | undefined;
      let replacement: string;
      if (atom && (!trigger || atom.start < trigger.start)) {
        next = atom;
        replacement = standInText("number", ":".repeat(atom.end - atom.start));
        a++;
      } else if (trigger) {
        next = trigger;
        replacement = standInText(
          trigger.standIn,
          this.data.slice(trigger.start, trigger.end),
        );
        t++;
      } else break;
      if (next.end > range.end) break;
      out += this.data.slice(last, next.start) + replacement;
      last = next.end;
    }
    return last === range.start ? text : out + this.data.slice(last, range.end);
  }

  /**
   * MX: the row of `set` matching at `pos`, when its claim takes it. With no
   * `claim` option every match claims (`claim` is then `undefined`); a
   * declined match is `undefined`, as if no row matched.
   */
  claimTrigger(
    set: TriggerSet,
    data: string,
    pos: number,
    position: "attribute" | "line",
  ): { trigger: CompiledTrigger; end: number; claim: unknown } | undefined {
    const hit = matchTrigger(set, data, pos);
    if (hit === undefined) return undefined;
    if (this.claim === undefined) return { ...hit, claim: undefined };
    const key = `${position}:${pos}`;
    let claim: unknown;
    if (this.claims.has(key)) claim = this.claims.get(key);
    else {
      claim = this.claim(hit.trigger.id, position, pos, hit.end);
      this.claims.set(key, claim);
    }
    return claim === undefined ? undefined : { ...hit, claim };
  }

  /**
   * MX: the value row claiming `data.slice(start, end)`, a whole attribute
   * value: the row armed on its first character whose `match` covers all
   * of it, when its claim takes it. Memoized per range, so the end rule
   * (`EXPRESSION`) and the value's exit ask once between them.
   */
  claimValue(
    data: string,
    start: number,
    end: number,
  ): { trigger: CompiledTrigger; claim: unknown } | undefined {
    const set = this.syntax.value;
    if (set === null) return undefined;
    const trigger = matchValue(set, data, start, end);
    if (trigger === undefined) return undefined;
    if (this.claim === undefined) return { trigger, claim: undefined };
    const key = `value:${start}:${end}`;
    let claim: unknown;
    if (this.claims.has(key)) claim = this.claims.get(key);
    else {
      claim = this.claim(trigger.id, "value", start, end);
      this.claims.set(key, claim);
    }
    return claim === undefined ? undefined : { trigger, claim };
  }

  /**
   * MX (decision 182): records a lexed trigger's span for `read` (unless its
   * stand-in is `"keep"`). Returns false for a trigger already recorded: a
   * re-lex never records or announces one twice, as for atoms.
   */
  recordTrigger(trigger: CompiledTrigger, start: number, end: number) {
    if (start <= this.lastTriggerStart) return false;
    this.lastTriggerStart = start;
    if (trigger.standIn !== "keep") {
      this.triggers.push({ start, end, standIn: trigger.standIn });
    }
    return true;
  }

  /**
   * MX (decision 156): `text` (the source of `range`) with every atom that
   * lies wholly inside `range` replaced by a numeric literal of the same
   * length (`:a` -> `0.`, `:rename-all` -> `0.000000000`), which Babel parses
   * at the atom's exact offsets. A consumer tells the stand-in from an
   * authored number by the source character at its start, which is `:`.
   *
   * A read of exactly a raw open tag (`rawOpenTags`) gets the source.
   * Reading exactly an atom's own range does get the stand-in, by design:
   * that is how `x=:a`'s value reaches Babel. A consumer that wants the
   * atom's text slices the source (or reads `value`, the name).
   * The first candidate atom is found by binary search.
   */
  standInAtoms(text: string, range: Range) {
    if (this.rawOpenTags.get(range.start) === range.end) return text;
    const { atoms } = this;
    let lo = 0;
    let hi = atoms.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (atoms[mid]!.start < range.start) lo = mid + 1;
      else hi = mid;
    }
    let out = "";
    let last = range.start;
    for (let k = lo; k < atoms.length; k++) {
      const atom = atoms[k]!;
      if (atom.end > range.end) break;
      out +=
        this.data.slice(last, atom.start) +
        "0." +
        "0".repeat(atom.end - atom.start - 2);
      last = atom.end;
    }
    return last === range.start ? text : out + this.data.slice(last, range.end);
  }

  /**
   * Given an offset in the current source code, returns a Position object
   * with line & character information, rebased onto the enclosing document
   * when `parse` was called with a base position (`startOffset`/`startLine`/
   * `startColumn`).
   */
  positionAt(offset: number) {
    const position = getPosition(
      this.lines || (this.lines = getLines(this.data)),
      offset,
    );
    if (!this.startOffset && !this.startLine && !this.startColumn) {
      return position;
    }
    return {
      line: position.line + this.startLine,
      character:
        position.line === 0
          ? position.character + this.startColumn
          : position.character,
    };
  }

  locationAt(range: Range) {
    return {
      start: this.positionAt(range.start),
      end: this.positionAt(range.end),
    };
  }

  /**
   * Rebases a substring-relative character offset onto the enclosing
   * document, using the base offset given to `parse`.
   */
  offsetAt(offset: number) {
    return offset + this.startOffset;
  }

  enterState<P extends Meta>(state: StateDefinition<P>): P {
    this.activeState = state as unknown as StateDefinition;
    return (this.activeRange = state.enter.call(
      this,
      this.activeRange,
      this.pos,
    ) as P);
  }

  exitState() {
    const { activeRange, activeState } = this;
    const parent = (this.activeRange = activeRange.parent);
    this.activeState = parent.state;
    activeRange.end = this.pos;
    activeState.exit.call(this, activeRange);
    this.activeState.return.call(this, activeRange, parent);
  }

  /**
   * Compare a position in the source to either another position, or a string.
   */
  matchAtPos(a: Range, b: Range | string) {
    const aPos = a.start;
    const aLen = a.end - aPos;
    let bPos = 0;
    let bLen: number;
    let bSource = this.data;

    if (typeof b === "string") {
      bLen = b.length;
      bSource = b;
    } else {
      bPos = b.start;
      bLen = b.end - bPos;
    }

    if (aLen !== bLen) return false;
    for (let i = 0; i < aLen; i++) {
      if (this.data.charAt(aPos + i) !== bSource.charAt(bPos + i)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Look ahead to see if the given str matches the substring sequence
   * beyond
   */
  lookAheadFor(str: string, startPos = this.pos + 1) {
    let i = str.length;
    if (startPos + i <= this.maxPos) {
      const { data } = this;
      for (; i--; ) {
        if (str[i] !== data[startPos + i]) {
          return undefined;
        }
      }

      return str;
    }
  }

  lookAtCharCodeAhead(offset: number, startPos = this.pos) {
    return this.data.charCodeAt(startPos + offset);
  }

  startText() {
    if (this.textPos === -1) {
      this.textPos = this.pos;
    }
  }

  endText() {
    const start = this.textPos;
    if (start !== -1) {
      if (start !== this.pos) {
        this.options.onText?.({ start, end: this.pos });
      }
      this.textPos = -1;
    }
  }

  /**
   * This is used to enter into "HTML" parsing mode instead
   * of concise HTML. We push a block on to the stack so that we know when
   * return back to the previous parsing mode and to ensure that all
   * tags within a block are properly closed.
   */
  beginHtmlBlock(delimiter: string | undefined, singleLine: boolean) {
    const content = this.enterState(
      this.activeTag?.type === TagType.text
        ? STATE.PARSED_TEXT_CONTENT
        : STATE.HTML_CONTENT,
    );

    content.singleLine = singleLine;
    content.delimiter = delimiter;
    content.indent = this.indent;
  }

  emitError(range: number | Range, code: ErrorCode, message: string) {
    let start, end;

    if (typeof range === "number") {
      start = end = range;
    } else {
      start = range.start;
      end = range.end;
    }

    this.options.onError?.({
      start,
      end,
      code,
      message,
    });

    this.pos = this.maxPos + 1;
  }

  closeTagEnd(start: number, end: number, name: Range | undefined) {
    const { beginMixedMode, parentTag } = this.activeTag!;
    if (beginMixedMode) this.endingMixedModeAtEOL = true;
    this.activeTag = parentTag;

    if (name) this.options.onCloseTagName?.(name);
    this.options.onCloseTagEnd?.({ start, end });
  }

  // --------------------------

  consumeWhitespaceIfBefore(str: string, start = 0) {
    const { pos, data } = this;
    let cur = pos + start;
    while (isWhitespaceCode(data.charCodeAt(cur))) cur++;

    if (this.lookAheadFor(str, cur)) {
      this.pos = cur;
      return true;
    }

    return false;
  }

  getPreviousNonWhitespaceCharCode(start = -1) {
    let behind = start;
    // MX (decision 156 addendum 11): Unicode whitespace too.
    while (isUnicodeWhitespaceCode(this.lookAtCharCodeAhead(behind))) behind--;
    const code = this.lookAtCharCodeAhead(behind);
    // MX (decision 156 addendum 13): a surrogate pair is one code point.
    if (code >= 0xdc00 && code <= 0xdfff) {
      const high = this.lookAtCharCodeAhead(behind - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        return ((high - 0xd800) << 10) + (code - 0xdc00) + 0x10000;
      }
    }
    return code;
  }

  onlyWhitespaceRemainsOnLine(start: number) {
    const maxOffset = this.maxPos - this.pos;
    let ahead = start;

    while (ahead < maxOffset) {
      const code = this.lookAtCharCodeAhead(ahead);
      if (isWhitespaceCode(code)) {
        switch (code) {
          case CODE.CARRIAGE_RETURN:
          case CODE.NEWLINE:
            return true;
        }
      } else {
        return false;
      }

      ahead++;
    }

    return true;
  }

  consumeWhitespaceOnLine(start = 1) {
    const maxOffset = this.maxPos - this.pos;
    let ahead = start;

    while (ahead < maxOffset) {
      const code = this.lookAtCharCodeAhead(ahead);
      if (isWhitespaceCode(code)) {
        switch (code) {
          case CODE.CARRIAGE_RETURN:
          case CODE.NEWLINE:
            this.pos += ahead;
            return true;
        }
      } else {
        this.pos += ahead;
        return false;
      }

      ahead++;
    }

    this.pos = this.maxPos;
    return true;
  }

  consumeWhitespace() {
    const maxOffset = this.maxPos - this.pos;
    let ahead = 0;
    while (
      ahead < maxOffset &&
      isWhitespaceCode(this.lookAtCharCodeAhead(ahead))
    ) {
      ahead++;
    }
    this.pos += ahead;
  }

  parse(data: string, options?: ParseOptions) {
    const maxPos = (this.maxPos = data.length);
    this.data = data;
    this.startOffset = options?.startOffset ?? 0;
    this.startLine = options?.startLine ?? 0;
    this.startColumn = options?.startColumn ?? 0;
    this.indent = "";
    this.textPos = -1;
    this.isConcise = true;
    this.beginMixedMode = this.endingMixedModeAtEOL = false;
    this.lines = this.activeTag = this.activeAttr = undefined;
    this.atoms = [];
    this.triggers = [];
    this.lastTriggerStart = -1;
    this.claims = new Map();
    this.rawOpenTags = new Map();
    // Drop any state left over from a previous parse so reusing a parser
    // does not chain (and retain) the old state metas via parent references.
    this.activeRange = undefined as unknown as Meta;

    // Skip the byte order mark (BOM) sequence
    // at the beginning of the file if there is one:
    // - https://en.wikipedia.org/wiki/Byte_order_mark
    // > The Unicode Standard permits the BOM in UTF-8, but does not require or recommend its use.
    this.pos = data.charCodeAt(0) === 0xfeff ? 1 : 0;
    this.enterState(STATE.CONCISE_HTML_CONTENT);

    while (this.pos <= maxPos) {
      this.activeState.parse.call(this, data, maxPos, this.activeRange);
    }
  }
}
