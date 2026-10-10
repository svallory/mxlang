/**
 * Tag rules presets (decision 204): the tag-table entries a dialect or a
 * target picks by name instead of assembling taglibs.
 *
 * - `html`: the html target's full table. The target's native elements with
 *   their HTML parse rules, plus every entry of core's taglib (`if`, `for`,
 *   `script`, `let`, the statement tags, ...).
 * - `markup`: the native elements plus core's statement tags (`import`,
 *   `static`, `export`, `client`, `server`, `class`), what the JSX, Solid,
 *   Astro and Angular hosts register, plus `<const>` and `<return>` as
 *   open-tag-only.
 * - `none`: no native tag rules at all, only the module statements
 *   (`import`, `static`, `export`) and `<const>`/`<return>` as open-tag-only.
 *   Every other name, `script`, `br` and `class` included, is an ordinary tag
 *   whose body parses as markup. The IR entry point (`lowerSource`) defaults
 *   to it.
 *
 * `<const>` and `<return>` take no body in any preset: without
 * `openTagOnly`, `<const/y=1>` in HTML mode waits for a `</const>`, and
 * `<const/y=1><b/></const>` lowers to a lone `Const` with `<b/>` silently
 * dropped.
 *
 * The entries are core's own `TagEntry` values, never Marko's `[id,
 * definition]` taglib form; `taglibsOfRules` converts them for the
 * translator-shaped paths until slice S3b-2 removes those.
 */

import { CORE_TAGLIB_ID, STATEMENT_TAGLIB_ID } from "./core-taglib.ts";
import {
  coreNativeTags,
  type NativeTags,
  type TagEntry,
  type TagParseOptions,
} from "./tag-table.ts";
import coreTags from "./taglib/core-tags.json" with { type: "json" };

/** A tag rules preset's name. */
export type TagRulesPreset = "html" | "markup" | "none";

/** The tag rules presets, in order of how much HTML they know. */
export const TAG_RULES_PRESETS: readonly TagRulesPreset[] = [
  "html",
  "markup",
  "none",
];

/** What a preset knows: native elements, then language tags over them. */
export interface TagRules {
  readonly preset: TagRulesPreset;
  /** The native elements; empty under `none`. */
  readonly nativeTags: NativeTags;
  /** The language tags layered over the natives, by name. */
  readonly tags: ReadonlyMap<string, TagEntry>;
}

/** The module statements: the only statement tags `none` knows. */
const MODULE_STATEMENTS: ReadonlySet<string> = new Set([
  "import",
  "static",
  "export",
]);

/** The language tags that never take a body, in `markup` and `none` too. */
const OPEN_TAG_ONLY: ReadonlySet<string> = new Set(["const", "return"]);

interface CoreTagDefinition {
  html?: boolean;
  parseOptions?: TagParseOptions;
}

/** Core's taglib entries as `TagEntry` values under `taglibId`, filtered. */
function coreEntries(
  taglibId: string,
  keep: (name: string, tag: CoreTagDefinition) => boolean,
): ReadonlyMap<string, TagEntry> {
  const entries = new Map<string, TagEntry>();
  for (const [key, value] of Object.entries(coreTags)) {
    if (!(key.startsWith("<") && key.endsWith(">"))) continue;
    const name = key.slice(1, -1);
    const tag = value as CoreTagDefinition;
    if (!keep(name, tag)) continue;
    entries.set(name, {
      taglibId,
      ...(tag.html === true ? { html: true as const } : {}),
      ...(tag.parseOptions ? { parseOptions: { ...tag.parseOptions } } : {}),
    });
  }
  return entries;
}

const NO_NATIVES: NativeTags = new Map();

let presetTags: Record<TagRulesPreset, ReadonlyMap<string, TagEntry>>;

function tagsOf(preset: TagRulesPreset): ReadonlyMap<string, TagEntry> {
  presetTags ??= {
    html: coreEntries(CORE_TAGLIB_ID, () => true),
    markup: coreEntries(
      STATEMENT_TAGLIB_ID,
      (name, tag) =>
        tag.parseOptions?.statement === true || OPEN_TAG_ONLY.has(name),
    ),
    none: coreEntries(
      STATEMENT_TAGLIB_ID,
      (name) => MODULE_STATEMENTS.has(name) || OPEN_TAG_ONLY.has(name),
    ),
  };
  return presetTags[preset];
}

const cache = new WeakMap<NativeTags, Map<TagRulesPreset, TagRules>>();

/**
 * The tag rules of `preset`. `nativeTags` is the target's or dialect's
 * native elements (core's own HTML elements when omitted); `none` ignores
 * it. The result is cached per preset and native set, so one compile's
 * repeated asks share one object.
 */
export function tagRulesPreset(
  preset: TagRulesPreset,
  nativeTags?: NativeTags,
): TagRules {
  if (!TAG_RULES_PRESETS.includes(preset)) {
    throw new TypeError(
      `unknown tag rules preset ${JSON.stringify(preset)}; expected one of ${TAG_RULES_PRESETS.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  const natives =
    preset === "none" ? NO_NATIVES : (nativeTags ?? coreNativeTags());
  let byPreset = cache.get(natives);
  if (!byPreset) {
    byPreset = new Map();
    cache.set(natives, byPreset);
  }
  let rules = byPreset.get(preset);
  if (!rules) {
    rules = { preset, nativeTags: natives, tags: tagsOf(preset) };
    byPreset.set(preset, rules);
  }
  return rules;
}

const taglibsCache = new WeakMap<TagRules, Array<[string, unknown]>>();

/**
 * `rules`' tags in Marko's `[id, definition]` taglib form, for a path that
 * still builds a translator (`compileSource`, `parseMxDocument`). One small
 * adapter so the presets stay core entries; slice S3b-2 deletes it with the
 * translator `taglibs` form. Cached per rules object: the tag table keys its
 * cache on the translator, so an unstable array would rebuild it per call.
 */
export function taglibsOfRules(rules: TagRules): Array<[string, unknown]> {
  let taglibs = taglibsCache.get(rules);
  if (!taglibs) {
    const byId = new Map<string, Record<string, unknown>>();
    for (const [name, entry] of rules.tags) {
      let definition = byId.get(entry.taglibId);
      if (!definition) {
        definition = {};
        byId.set(entry.taglibId, definition);
      }
      definition[`<${name}>`] = {
        ...(entry.html ? { html: true } : {}),
        ...(entry.parseOptions ? { parseOptions: entry.parseOptions } : {}),
      };
    }
    taglibs = [...byId];
    taglibsCache.set(rules, taglibs);
  }
  return taglibs;
}
