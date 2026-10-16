/**
 * The words core's messages use for a dialect's files (`Dialect.messageVocabulary`).
 *
 * A message that a dialect file's author reaches with the dialect's own tags
 * and attributes names three things in MX's words: an "attribute", the "data
 * file" (and its plural, "data files"), and a tag as `<name>`. {@link Voice} is the one
 * place those words live: the message builders in the IR entry checks, the
 * contract validators and the generic lowering take a `Voice` and splice its
 * words, and {@link MX_VOICE} (the default) spells every message exactly as it
 * was before a dialect could change it.
 *
 * Funnels (`raise`, `failForOwner`, the IR entry's `fail`, `warn`) keep taking
 * finished strings: only a builder knows which words it uses.
 */
import type { Ctx } from "./core.ts";
import type { TagTrigger } from "./ir.ts";
import type { Dialect, MessageTag, MessageVocabulary } from "./syntax-table.ts";

/**
 * Thrown by {@link Voice.tag} when the dialect's `formatTag` throws or returns
 * a value that is not a spelling. Not a diagnostic yet: the message was being
 * built, so the lowering boundary (`lower.ts`, the IR entry's walk) turns it
 * into an `MX_DIALECT_HOOK_ERROR` at the tag it was lowering.
 */
export class VoiceHookError extends Error {
  /** The tag as MX spells it, for the message. */
  readonly tag: string;
  constructor(message: string, tag: string) {
    super(message);
    this.name = "VoiceHookError";
    this.tag = tag;
  }
}

/** MX's own spelling of a tag, bare: `<name>`, `<@name>`, `<${name}>`. */
export function mxSpelling(tag: MessageTag): string {
  switch (tag.form) {
    case "attributeTag":
      return `<@${tag.name}>`;
    case "dynamic":
      return `<\${${tag.name}}>`;
    case "tag":
      return `<${tag.name}>`;
  }
}

/**
 * Does `voice` spell the built-in tag `name` the way MX does (`<name>`)? A
 * message that shows a syntax example written in MX's tags (`<const/name=value/>`)
 * shows it only then: a dialect that spells the tag otherwise does not write
 * MX's syntax, so the example would teach a form its file's author cannot use,
 * and the message states the rule without it.
 */
export function writesMxSyntax(
  voice: Voice,
  name: string,
  trigger?: TagTrigger,
): boolean {
  return (
    voice.tag(name, trigger) === `\`${mxSpelling({ name, form: "tag" })}\``
  );
}

/** The words a message splices. See the file header. */
export interface Voice {
  /** `attribute` */
  readonly attribute: string;
  /** `attributes` */
  readonly attributes: string;
  /** `Attribute`, for the start of a sentence. */
  readonly Attribute: string;
  /** `Attributes`, for the start of a sentence. */
  readonly Attributes: string;
  /** `an attribute`: the article the dialect states or the noun's first letter picks. */
  readonly anAttribute: string;
  /** `attribute tag` */
  readonly attributeTag: string;
  /** `attribute tags` */
  readonly attributeTags: string;
  /** `attribute-tag`, the compound ("an attribute-tag declaration"). */
  readonly attributeTagCompound: string;
  /** `data file` */
  readonly file: string;
  /** `data files` */
  readonly files: string;
  /** `Data files`, for the start of a sentence. */
  readonly Files: string;
  /** `a data file`: the article the dialect states or the noun's first letter picks. */
  readonly aFile: string;
  /**
   * `data tree`. Unused: no message reads it any more (they say "<Files> are
   * static, so ..."); kept while `MessageVocabulary.tree` is still accepted.
   */
  readonly tree: string;
  /**
   * A tag in backticks, as the dialect spells it (`` `<member>` `` by
   * default). Throws {@link VoiceHookError} when the dialect's `formatTag`
   * breaks its contract.
   */
  tag(name: string, trigger?: TagTrigger): string;
  /** An `@name` attribute tag in backticks (`` `<@name>` `` by default). */
  attrTag(name: string, trigger?: TagTrigger): string;
  /**
   * A dynamic tag in backticks (`` `<${expr}>` `` by default), `source` being
   * the expression's source text: it is what the dialect's `formatTag` gets as
   * `name`. A message that only illustrates a dynamic tag passes `example`,
   * the placeholder MX's own words print (`expr`, `…`) when the dialect has no
   * spelling; it is `source` when omitted.
   */
  dynamicTag(source: string, trigger?: TagTrigger, example?: string): string;
  /** The bare spelling of `tag`, without backticks. */
  spell(tag: MessageTag): string;
}

/**
 * The trigger that made a tag (`ctx.child`), read off its AST node, or none for
 * an authored tag.
 */
export function triggerOfNode(
  node: { mxTrigger?: TagTrigger | undefined } | null | undefined,
): TagTrigger | undefined {
  const mark = node?.mxTrigger;
  return mark ? { id: mark.id, span: mark.span, text: mark.text } : undefined;
}

/** "an" before a vowel letter, else "a". */
export function articleFor(noun: string): "a" | "an" {
  return /^[aeiou]/i.test(noun.trim()) ? "an" : "a";
}

function capitalized(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

/**
 * `noun` with its first letter upper-cased for the start of a sentence, unless
 * the noun already has a capital after its first letter ("iOS file"): that is
 * the dialect's own spelling.
 */
function sentenceStart(noun: string): string {
  return /^\S[^\s]*[A-Z]/.test(noun) ? noun : capitalized(noun);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return JSON.stringify(value);
  return `a ${typeof value}`;
}

/** Builds a voice from a dialect's vocabulary (all members optional). */
function buildVoice(vocabulary: MessageVocabulary | undefined): Voice {
  const one = vocabulary?.attribute?.one ?? "attribute";
  const many = vocabulary?.attribute?.many ?? "attributes";
  const article = vocabulary?.attribute?.article ?? articleFor(one);
  const stated = vocabulary?.file;
  const file =
    typeof stated === "object" ? stated.one : (stated ?? "data file");
  const files = typeof stated === "object" ? stated.many : `${file}s`;
  const fileArticle =
    typeof stated === "object"
      ? (stated.article ?? articleFor(file))
      : articleFor(file);
  const tree = vocabulary?.tree ?? "data tree";
  const format = vocabulary?.formatTag;
  const spell = (tag: MessageTag, example?: string): string => {
    const mx = (): string =>
      mxSpelling(example === undefined ? tag : { ...tag, name: example });
    if (format === undefined) return mx();
    let spelled: unknown;
    try {
      spelled = format.call(vocabulary, tag);
    } catch (thrown) {
      const reason =
        thrown instanceof Error ? thrown.message : describe(thrown);
      throw new VoiceHookError(
        `the dialect's \`messageVocabulary.formatTag\` threw while spelling \`${mx()}\`: ${reason}`,
        tag.name,
      );
    }
    if (spelled === undefined) return mx();
    if (
      typeof spelled !== "string" ||
      spelled === "" ||
      /[\r\n`]/.test(spelled)
    ) {
      throw new VoiceHookError(
        `the dialect's \`messageVocabulary.formatTag\` must return undefined or a non-empty single-line string without backticks, got ${describe(spelled)} for \`${mx()}\``,
        tag.name,
      );
    }
    return spelled;
  };
  const marked = (
    name: string,
    form: MessageTag["form"],
    trigger?: TagTrigger,
    example?: string,
  ): string =>
    `\`${spell({ name, form, ...(trigger ? { trigger } : {}) }, example)}\``;
  const voice: Voice = {
    attribute: one,
    attributes: many,
    Attribute: capitalized(one),
    Attributes: capitalized(many),
    anAttribute: `${article} ${one}`,
    attributeTag: `${one} tag`,
    attributeTags: `${one} tags`,
    attributeTagCompound: `${one}-tag`,
    file,
    files,
    Files: sentenceStart(files),
    aFile: `${fileArticle} ${file}`,
    tree,
    tag: (name, trigger) => marked(name, "tag", trigger),
    attrTag: (name, trigger) => marked(name, "attributeTag", trigger),
    dynamicTag: (source, trigger, example) =>
      marked(source, "dynamic", trigger, example),
    spell,
  };
  return Object.freeze(voice);
}

/** MX's own words: every message spelled as it always was. */
export const MX_VOICE: Voice = buildVoice(undefined);

const voices = new WeakMap<object, Voice>();

/**
 * The voice of a file's dialect: {@link MX_VOICE} for none, or for a dialect
 * that states no vocabulary. Cached per dialect object.
 */
export function voiceOf(dialect: Dialect | undefined): Voice {
  const vocabulary = dialect?.messageVocabulary;
  if (!dialect || !vocabulary) return MX_VOICE;
  let voice = voices.get(dialect);
  if (voice === undefined) {
    voice = buildVoice(vocabulary);
    voices.set(dialect, voice);
  }
  return voice;
}

/** The fixed structural-reject message: `construct` is already spelled. */
export function structuralMessage(construct: string, voice: Voice): string {
  return `${voice.Files} are static, so they do not evaluate ${construct}`;
}

/** The voice of the file being lowered, as `productOf` reads its product. */
export function voiceOfCtx(ctx: Ctx): Voice {
  return ctx.voice ?? MX_VOICE;
}

/**
 * An owner chain, or a thunk that spells it. A label is spelled through the
 * dialect's `formatTag`, which may throw, and a valid file reports nothing:
 * the chain is spelled only when a message is built (`ownerText`).
 */
export type Owner = string | (() => string);

/** A thunk that spells the owner once, on first use. */
export function lazyOwner(spell: () => string): () => string {
  let text: string | undefined;
  return () => {
    text ??= spell();
    return text;
  };
}

export function ownerText(owner: Owner): string {
  return typeof owner === "string" ? owner : owner();
}
