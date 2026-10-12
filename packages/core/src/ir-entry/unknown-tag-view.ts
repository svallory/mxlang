/**
 * What a dialect's `explainUnknownTag` is handed and what it may return,
 * shared by the two places core finds an authored tag with no contract: the
 * check on a source that lowered (`checks.ts`) and the parse-only scan of a
 * source whose lowering failed (`authored-tags.ts`).
 *
 * Both paths build the tag's view with the functions here — the ancestor
 * frame (`enterTag`) and the call (`explainerFor`) — so the hook gets the
 * same `UnknownTag` whichever path found the tag. A path only supplies what
 * it reads from its own tree: the written name, the name's span and the
 * element's span.
 */

import { contractData } from "../contract-fields.ts";
import { TranslateError } from "../core.ts";
import type { CustomTag } from "../custom-tags.ts";
import { DIALECT_HOOK_ERROR_CODE } from "../diagnostic-codes.ts";
import type { SourceSpan } from "../mapping.ts";
import type {
  Dialect,
  UnknownTag,
  UnknownTagAncestor,
  UnknownTagExplanation,
} from "../syntax-table.ts";
import {
  type ContractScope,
  matchWildcardChild,
  scopeForChildren,
} from "../wildcard-resolve.ts";
import { positionAt } from "./diagnostics.ts";

/** What building ancestors needs: the contracts, and what a module claims on them. */
export interface ViewEnv {
  /** The contracts lowering reads (a deferred entry through its view). */
  readonly customTags: Readonly<Record<string, CustomTag>> | undefined;
  /** The contract keys the file's dialect claims, copied into `ContractData`. */
  readonly tagFields: ReadonlySet<string>;
  /** One copy per registered object across the call's hook calls. */
  readonly memo: WeakMap<object, unknown>;
}

/** Where a walk is: the contract in force and the authored tags around it. */
export interface ViewFrame {
  readonly scope: ContractScope | undefined;
  readonly ancestors: readonly UnknownTagAncestor[];
}

/** The top level of a file. */
export const ROOT_FRAME: ViewFrame = Object.freeze({
  scope: undefined,
  ancestors: Object.freeze([]),
});

/** One authored tag, as either path reads it. */
export interface EnteredTag {
  /** A key for the wildcard match core records per tag (the MX node, or any fresh object). */
  readonly node: object;
  /** The name as written: `@row` for an attribute tag, the resolved default tag for an unnamed one. */
  readonly written: string;
  /** The name lowering uses: the written name, or a wildcard child's canonical one. */
  readonly name: string;
  readonly nameSpan?: SourceSpan | undefined;
  /** Whether a parent's `children["*"]` claimed it (so `name` is canonical, `written` the alias). */
  readonly claimed: boolean;
}

/**
 * The contract in force for what is written inside `tag`: the one core checks
 * its children against (a wildcard child's matched contract, an attribute
 * tag's declaration in its owner, a registered tag's own), `undefined` for a
 * tag with none.
 */
export function scopeInside(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  scope: ContractScope | undefined,
  tag: EnteredTag,
): ContractScope | undefined {
  const claimed = tag.claimed
    ? matchWildcardChild(tag.node, tag.written, scope, {
        customTags,
      } as Parameters<typeof matchWildcardChild>[3])
    : undefined;
  return scopeForChildren(
    tag.node,
    claimed?.canonical ?? tag.name,
    scope,
    customTags,
  );
}

/**
 * The frame inside `tag`: its contract in force for what is written within
 * it, and the tag appended to the ancestors.
 */
export function enterTag(
  env: ViewEnv,
  frame: ViewFrame,
  tag: EnteredTag,
): ViewFrame {
  const scope = scopeInside(env.customTags, frame.scope, tag);
  const ancestor: UnknownTagAncestor = Object.freeze({
    tag: tag.written,
    ...(tag.nameSpan ? { nameSpan: tag.nameSpan } : {}),
    ...(scope
      ? { contract: contractData(scope.declaration, env.tagFields, env.memo) }
      : {}),
  });
  return Object.freeze({
    scope,
    ancestors: Object.freeze([...frame.ancestors, ancestor]),
  });
}

/** What a path knows of an unknown tag. */
export interface UnknownTagFacts {
  readonly name: string;
  readonly nameSpan: SourceSpan;
  readonly span: SourceSpan;
  readonly ancestors: readonly UnknownTagAncestor[];
}

/** Calls the dialect's hook for a tag and turns what it says into an error. */
export interface Explainer {
  readonly env: ViewEnv;
  /**
   * The error for `tag`, or `undefined` when the dialect does not explain it.
   * Never throws: a hook that throws or returns a malformed value is the
   * error (`MX_DIALECT_HOOK_ERROR`, at the tag).
   */
  explain(tag: UnknownTagFacts): TranslateError | undefined;
}

/** Is `span` a `{ sourceStart, sourceEnd }` inside a document of `length` characters? */
function insideDocument(span: unknown, length: number): span is SourceSpan {
  const at = span as SourceSpan | null | undefined;
  return (
    !!at &&
    typeof at === "object" &&
    Number.isInteger(at.sourceStart) &&
    Number.isInteger(at.sourceEnd) &&
    at.sourceStart >= 0 &&
    at.sourceStart <= at.sourceEnd &&
    at.sourceEnd <= length
  );
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return JSON.stringify(value);
  return `a ${typeof value}`;
}

/**
 * The explainer for a file's dialect, or `undefined` when it has no hook (the
 * caller then keeps core's behaviour and the cost of a walk it did not need).
 */
export function explainerFor(
  dialect: Dialect | undefined,
  options: {
    mode: "allow" | "reject";
    file: string;
    source: string;
    lineStarts: number[];
    env: ViewEnv;
  },
): Explainer | undefined {
  const hook = dialect?.explainUnknownTag;
  if (!dialect || !hook) return undefined;
  const { mode, file, source, lineStarts, env } = options;
  const errorAt = (
    offset: number,
    endOffset: number,
    message: string,
    code?: string,
  ) => {
    const position = positionAt(lineStarts, offset);
    const error = new TranslateError(message, position.line, position.column);
    error.end = positionAt(lineStarts, Math.max(offset, endOffset));
    if (code !== undefined) error.diagnosticCode = code;
    return error;
  };
  return {
    env,
    explain(facts) {
      const hookError = (what: string) =>
        errorAt(
          facts.span.sourceStart,
          // Blamed on the tag: its `<name`.
          facts.nameSpan?.sourceEnd ?? facts.span.sourceStart,
          `the dialect's \`explainUnknownTag\` ${what}`,
          DIALECT_HOOK_ERROR_CODE,
        );
      const tag: UnknownTag = Object.freeze({
        name: facts.name,
        nameSpan: facts.nameSpan,
        span: facts.span,
        ancestors: facts.ancestors,
        mode,
        file,
        source,
      });
      // Everything the hook hands back is read inside the guard: a getter or a
      // proxy that throws is the dialect's failure too.
      try {
        const returned: unknown = hook.call(dialect, tag);
        if (returned === undefined) return undefined;
        if (
          returned === null ||
          typeof returned !== "object" ||
          Array.isArray(returned)
        ) {
          return hookError(
            `must return an explanation object or undefined, got ${describe(returned)} for \`<${facts.name}>\``,
          );
        }
        if (typeof (returned as { then?: unknown }).then === "function") {
          return hookError(
            `must be synchronous: it returned a promise for \`<${facts.name}>\``,
          );
        }
        const { message, code, at } = returned as Partial<
          Record<keyof UnknownTagExplanation, unknown>
        >;
        if (typeof message !== "string" || message === "") {
          return hookError(
            `must return a non-empty \`message\`, got ${describe(message)} for \`<${facts.name}>\``,
          );
        }
        if (code !== undefined && (typeof code !== "string" || code === "")) {
          return hookError(
            `must return \`code\` as a non-empty string, got ${describe(code)} for \`<${facts.name}>\``,
          );
        }
        if (at !== undefined && !insideDocument(at, source.length)) {
          return hookError(
            `must return \`at\` as a \`{ sourceStart, sourceEnd }\` span inside the document (0 to ${source.length}) for \`<${facts.name}>\``,
          );
        }
        const range = at as SourceSpan | undefined;
        return errorAt(
          range?.sourceStart ?? facts.span.sourceStart,
          range?.sourceEnd ??
            facts.nameSpan?.sourceEnd ??
            facts.span.sourceStart,
          message,
          code as string | undefined,
        );
      } catch (thrown) {
        const reason =
          thrown instanceof Error ? thrown.message : describe(thrown);
        return hookError(
          `threw while explaining \`<${facts.name}>\`: ${reason}`,
        );
      }
    },
  };
}
