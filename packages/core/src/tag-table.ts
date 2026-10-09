/**
 * Core's tag table: what a tag name means to the parser and to lowering, built
 * from a translator's taglibs and a target's native elements, with no
 * `@marko/compiler` lookup (decision 197, PR 6 slice S3a).
 *
 * It reproduces the merge `@marko/compiler`'s `taglib.buildLookup` performed
 * for the taglibs MX registers, which `tag-table.test.ts` pins against the
 * live lookup:
 *
 * - The target's native elements come first, each under the element taglib id
 *   Marko gave its namespace (`marko-html`, `marko-svg`, `marko-math`), with
 *   `html: true` and the parse switches of its body mode. The ids stay until
 *   the hosts stop reading them (slice S4).
 * - Then each `[id, definition]` of `translator.taglibs`, in order (core's
 *   statement taglib, the host's, the custom tags last). An entry is a
 *   definition key `<name>`; other keys (`taglibId`, `@attr`) are not tags. A
 *   later entry takes the tag's `taglibId`, merges its `parseOptions` key by
 *   key over the earlier ones, and sets `html` only when it says so itself.
 *
 * What it does not do, on purpose: read `tags/` directories, a `marko.json`
 * or a `node_modules` taglib. Custom tags reach the table through
 * `customTags` (core's own discovery); a Marko taglib file is not MX input.
 * No entry carries a `template`.
 */
import { withStatementTags } from "./core-taglib.ts";

/** A native element's body mode, the front end's `tagShape` values (ast §3.12). */
export type NativeBodyMode =
  | "html"
  | "parsed-text"
  | "preserve"
  | "parsed-text-preserve"
  | "void";

/**
 * One native element of a target: its namespace and how its body parses.
 * `@mxlang/web-elements`' `WebElement` has this shape.
 */
export interface NativeTag {
  readonly namespace: "html" | "svg" | "mathml";
  readonly body: NativeBodyMode;
}

/** A target's native elements by tag name (`@mxlang/web-elements`' `WEB_ELEMENTS`). */
export type NativeTags = ReadonlyMap<string, NativeTag>;

/** The parse switches a table entry carries (`statement`: its text is code). */
export interface TagParseOptions {
  statement?: boolean;
  openTagOnly?: boolean;
  text?: boolean;
  preserveWhitespace?: boolean;
  [option: string]: unknown;
}

/** What the table knows about one tag name. */
export interface TagEntry {
  /** The taglib the name's last definition came from. */
  taglibId: string;
  /** Set when a native element or the defining entry says the tag is HTML. */
  html?: true;
  parseOptions?: TagParseOptions;
}

/** Core's tag table, as `parseMx` and lowering read it. */
export interface TagTable {
  /** The entry for `name`, or `undefined` when nothing defines it. */
  getTag(name: string): TagEntry | undefined;
}

const NAMESPACE_TAGLIB_IDS: Record<NativeTag["namespace"], string> = {
  html: "marko-html",
  svg: "marko-svg",
  mathml: "marko-math",
};

const BODY_PARSE_OPTIONS: Record<NativeBodyMode, TagParseOptions | undefined> =
  {
    html: undefined,
    void: { openTagOnly: true },
    preserve: { preserveWhitespace: true },
    "parsed-text": { text: true },
    "parsed-text-preserve": { text: true, preserveWhitespace: true },
  };

/** The element taglib ids, for a reader that tells elements from tags. */
export const ELEMENT_TAGLIB_IDS: ReadonlySet<string> = new Set(
  Object.values(NAMESPACE_TAGLIB_IDS),
);

const nativeLayers = new WeakMap<NativeTags, ReadonlyMap<string, TagEntry>>();
const NO_NATIVES: ReadonlyMap<string, TagEntry> = new Map();

function nativeLayer(natives: NativeTags | undefined) {
  if (!natives) return NO_NATIVES;
  let layer = nativeLayers.get(natives);
  if (!layer) {
    const built = new Map<string, TagEntry>();
    for (const [name, tag] of natives) {
      const parseOptions = BODY_PARSE_OPTIONS[tag.body];
      built.set(name, {
        taglibId: NAMESPACE_TAGLIB_IDS[tag.namespace],
        html: true,
        ...(parseOptions ? { parseOptions: { ...parseOptions } } : {}),
      });
    }
    layer = built;
    nativeLayers.set(natives, layer);
  }
  return layer;
}

/** The shape of a translator this reads: its `[id, definition]` taglibs. */
interface TaglibCarrier {
  taglibs?: ReadonlyArray<readonly [string, unknown]>;
}

const tables = new WeakMap<object, Map<NativeTags | undefined, TagTable>>();

/**
 * The tag table of `translator` over `natives`. `translator` passes core's
 * statement tags first (`withStatementTags`), as every lookup did. Cached per
 * translator and native set, so one compile's repeated asks build it once.
 */
export function tagTable(
  translator: unknown,
  natives: NativeTags | undefined,
): TagTable {
  const key =
    translator !== null && typeof translator === "object"
      ? translator
      : undefined;
  const byNatives = key ? tables.get(key) : undefined;
  const cached = byNatives?.get(natives);
  if (cached) return cached;
  const entries = new Map(nativeLayer(natives));
  const taglibs =
    (withStatementTags(translator) as TaglibCarrier | undefined)?.taglibs ?? [];
  for (const [taglibId, definition] of taglibs) {
    if (definition === null || typeof definition !== "object") continue;
    for (const [field, value] of Object.entries(definition)) {
      if (!(field.startsWith("<") && field.endsWith(">"))) continue;
      const name = field.slice(1, -1);
      const tag = (value ?? {}) as { html?: unknown; parseOptions?: unknown };
      const earlier = entries.get(name);
      const own =
        tag.parseOptions !== null && typeof tag.parseOptions === "object"
          ? (tag.parseOptions as TagParseOptions)
          : undefined;
      const parseOptions =
        earlier?.parseOptions || own
          ? { ...earlier?.parseOptions, ...own }
          : undefined;
      entries.set(name, {
        taglibId,
        ...(earlier?.html || tag.html === true ? { html: true as const } : {}),
        ...(parseOptions ? { parseOptions } : {}),
      });
    }
  }
  const table: TagTable = { getTag: (name) => entries.get(name) };
  if (key) {
    const store = byNatives ?? new Map();
    if (!byNatives) tables.set(key, store);
    store.set(natives, table);
  }
  return table;
}
