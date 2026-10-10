import {
  type ContractDefaultTagInput,
  contractDefaultTagDiagnostics,
} from "./contract-default-tag.ts";
import type { Ctx } from "./core.ts";
import { CORE_TAGLIB, CORE_TAGLIB_ID } from "./core-taglib.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import {
  type DefaultTagScope,
  validateDefaultTag,
} from "./default-tag-validate.ts";
import {
  type PolicyLocation,
  readTargetDefaultTag,
  type TargetPolicyDiagnostic,
} from "./host-policy.ts";
import { type NativeTags, type TagTable, tagTable } from "./tag-table.ts";

/** What one package's `mx.<target>.defaultTag` came to. */
export interface CheckedDefaultTag {
  /** The configured name, validated: use it. Absent when unset or rejected. */
  value?: string;
  /** The one error, positioned at the `package.json` value, when it was rejected. */
  diagnostic?: TargetPolicyDiagnostic;
}

/** A scope, or a function that builds one (it may throw: see below). */
export type DefaultTagScopeSource = DefaultTagScope | (() => DefaultTagScope);

/**
 * The diagnostic for `name` written at `at`, or `undefined` when it is a
 * usable default tag in `scope`. `owner` names where the value is written
 * when that is not the package's own `mx.<target>.defaultTag`.
 *
 * A failed scan (a malformed `mx.contracts`) is not an error here: see
 * `defaultTagScopeFor`. Any other failure building the scope throws.
 */
export function defaultTagDiagnostic(
  name: string,
  at: PolicyLocation,
  source: DefaultTagScopeSource,
  owner?: string,
): TargetPolicyDiagnostic | undefined {
  // Anything that throws while building the scope (a taglib that fails to
  // load, a translator getter) throws: only a failed scan is tolerated, and
  // `defaultTagScopeFor` handles that where the scan is read.
  const scope = typeof source === "function" ? source() : source;
  const reason = validateDefaultTag(name, scope);
  if (reason === undefined) return undefined;
  return {
    code: "invalid-default-tag",
    severity: "error",
    file: at.file,
    message: `invalid \`defaultTag\` value: ${reason}${owner ? ` (${owner})` : ""}`,
    line: at.line,
    column: at.column,
    length: at.length,
  };
}

/**
 * Reads `mx.<config key>.defaultTag` for the package that holds `filePath`,
 * then validates it: the one path every compile entry shares, so none can
 * diverge from the registry's. The key is the target's descriptor `configKey`
 * when it has one, else its name. A rejected value comes back as the
 * diagnostic and no value, so the compile falls to the next rung of the
 * ladder. The scope is built only when the package sets a value.
 */
export function checkConfiguredDefaultTag(
  filePath: string,
  target: string,
  options: { scope: DefaultTagScopeSource; configKey?: string },
): CheckedDefaultTag {
  const config = readTargetDefaultTag(filePath, target, options.configKey);
  if (config.diagnostic) return { diagnostic: config.diagnostic };
  if (config.value === undefined || !config.at) return {};
  const diagnostic = defaultTagDiagnostic(
    config.value,
    config.at,
    options.scope,
  );
  return diagnostic ? { diagnostic } : { value: config.value };
}

/** What a compile entry that scans for itself knows about its target. */
export interface OwnDefaultTagInput {
  /** The target whose `mx.<config key>.defaultTag` this compile reads. */
  target: string;
  /** The target's descriptor `configKey`, when it is not the target's `name`. */
  configKey?: string;
  /** The custom tags this compile scanned for the file, or the scan (see `defaultTagScopeFor`). */
  customTags?: DefaultTagScopeInput["customTags"];
  /** The Marko translator the target compiles with. */
  translator: unknown;
  declarations?: HostDeclarations;
  builtins?: readonly string[];
  /**
   * The scan's tags, when this entry scanned for itself: every contract
   * `defaultTag` is then checked too (the registry's registration check) and
   * reported through `report`, at the declaration.
   */
  tags?: ContractDefaultTagInput["tags"];
  /** The host's name, for the refusal when its declarations forbid the contract rung. */
  hostName?: string;
  /** Where a rejected value is reported; once per call, positioned in the `package.json`. */
  report: (diagnostic: TargetPolicyDiagnostic) => void;
}

/**
 * The validated `mx.<config key>.defaultTag` for `file`, or `undefined`, for a
 * compile entry that reads the config itself because it scans for itself: the
 * Bun loaders, the Astro Vite template plugin, Angular's `build()`, `loadMx`.
 * It is the registry's check, over this entry's own scan and translator. A
 * rejected value is dropped (the built-in answers) and handed to `report`.
 */
export function ownDefaultTag(
  file: string,
  input: OwnDefaultTagInput,
): string | undefined {
  const { value, diagnostic } = checkConfiguredDefaultTag(file, input.target, {
    scope: () => ownScope(input),
    configKey: input.configKey,
  });
  if (diagnostic) input.report(diagnostic);
  if (input.tags) {
    const scope = ownScope(input);
    for (const found of contractDefaultTagDiagnostics({
      tags: input.tags,
      customTags: scope.customTags ?? {},
      scope,
      host: {
        name: input.hostName ?? input.target,
        kind: input.hostName ? "host" : "target",
        ...(input.declarations?.allowContractDefaultTag === false
          ? { allowContractDefaultTag: false }
          : {}),
      },
    }))
      input.report(found);
  }
  return value;
}

function ownScope(input: OwnDefaultTagInput): DefaultTagScope {
  return buildScope({
    translator: input.translator,
    ...(input.customTags ? { customTags: input.customTags } : {}),
    ...(input.declarations ? { declarations: input.declarations } : {}),
    ...(input.builtins ? { builtins: input.builtins } : {}),
  });
}

/**
 * The scope a target's own compile gives a `defaultTag`: its package's custom
 * tags, the tag table its compile reads (its translator's taglibs over its
 * `nativeTags`: parse shape, and its elements through the host's own
 * `isElement`), and the names it lists as built-in. No `marko.json` is read
 * (decision 197).
 */
export function defaultTagScopeFor(
  input: DefaultTagScopeInput,
): DefaultTagScope {
  return buildScope(input);
}

/** What `defaultTagScopeFor` needs. */
export interface DefaultTagScopeInput {
  /**
   * A directory of the package. Not read since decision 197: the tag table
   * reads no directory (no `marko.json`, no `tags-dir`).
   */
  dir?: string;
  translator: unknown;
  /**
   * The package's custom tags, or the scan that reads them. A scan that throws
   * makes the custom tags unknown (`customTagsUnknown`): the parse-shape check
   * still runs, and a verdict that needs them is skipped. Nothing else is
   * caught.
   */
  customTags?:
    | Readonly<Record<string, CustomTag>>
    | (() => Readonly<Record<string, CustomTag>>);
  declarations?: HostDeclarations;
  builtins?: readonly string[];
}

function buildScope(input: DefaultTagScopeInput): DefaultTagScope {
  let customTags: Readonly<Record<string, CustomTag>> | undefined;
  let customTagsUnknown = false;
  if (typeof input.customTags === "function") {
    try {
      customTags = input.customTags();
    } catch {
      customTagsUnknown = true;
    }
  } else customTags = input.customTags;
  const declarations = input.declarations;
  const lookup = judgingLookup(
    tagTable(input.translator, declarations?.nativeTags),
    declarations?.nativeTags,
  );
  const isElement = elementPredicate(lookup, declarations);
  const isNativeElement = nativeElementPredicate(lookup, declarations);
  return {
    ...(customTags ? { customTags } : {}),
    ...(customTagsUnknown ? { customTagsUnknown } : {}),
    ...(lookup ? { lookup } : {}),
    ...(input.builtins ? { builtins: input.builtins } : {}),
    isElement,
    isNativeElement,
  };
}

let coreTranslator: unknown;

/**
 * The table a default tag is judged in: the compile's or the target's own,
 * with Marko's core tags (`CORE_TAGLIB`) always behind it, both over the
 * target's `nativeTags` (core's own elements when it declares none). A host
 * whose translator registers no core taglib (the JSX, Solid, Angular and
 * Astro hosts) would otherwise not know `html-script` or `else-if` as tags at
 * all and judge them natively; registration, the compile and every entry that
 * scans for itself build their view here, so they cannot disagree.
 */
export function judgingLookup(
  primary: TagTable | undefined,
  nativeTags: NativeTags | undefined,
): TagTable {
  coreTranslator ??= {
    taglibs: [[CORE_TAGLIB_ID, CORE_TAGLIB]],
    tagDiscoveryDirs: [],
    translate: {},
  };
  const core = tagTable(coreTranslator, nativeTags);
  if (!primary) return core;
  return {
    getTag: (name: string) => primary.getTag(name) ?? core.getTag(name),
  };
}

/**
 * Whether a name is an element of the target: the host's own `isElement` says
 * so AND Marko's own `html` flag is on the tag def. The flag is a taglib
 * property (every element of marko-html, -svg and -math has it, no core or
 * translator tag does), so a host whose own `isElement` is casing-only
 * (Solid) cannot let `await` or `define` through, and a target with no
 * declarations is covered too.
 */
export function elementPredicate(
  lookup: TagTable,
  declarations: HostDeclarations | undefined,
): (name: string) => boolean {
  const flagged = (name: string): boolean => lookup.getTag(name)?.html === true;
  const ctx = isElementCtx(lookup);
  return (name) =>
    (!declarations?.isElement || declarations.isElement(name, ctx)) &&
    flagged(name);
}

/**
 * Whether the host compiles a name its lookup does not know as a native
 * element: its own `isElement` answer, never the lookup's flag. A target with
 * no declarations cannot say.
 */
export function nativeElementPredicate(
  lookup: TagTable,
  declarations: HostDeclarations | undefined,
): (name: string) => boolean {
  const ctx = isElementCtx(lookup);
  return (name) =>
    !!declarations?.isElement && declarations.isElement(name, ctx);
}

/**
 * The compile state a host's `isElement` reads, outside a compile: the
 * judging table as the compile's `ctx.tagTable`, and no file-local bindings.
 */
function isElementCtx(table: TagTable): Ctx {
  const view: Pick<Ctx, "tagTable" | "defines" | "imports"> = {
    tagTable: table,
    defines: new Map(),
    imports: new Set(),
  };
  // SAFETY: `Ctx` is compiler-internal, and a host's `isElement` reads only
  // `tagTable`, `defines` and `imports` from it. `view` is typed as that
  // `Pick` of `Ctx`, so renaming one of those fields fails to compile here.
  return view as Ctx;
}
