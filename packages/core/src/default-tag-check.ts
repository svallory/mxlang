import { dirname } from "node:path";
import { buildMarkoLookup } from "./compile.ts";
import {
  type ContractDefaultTagInput,
  contractDefaultTagDiagnostics,
} from "./contract-default-tag.ts";
import type { Ctx } from "./core.ts";
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
 * Reads `mx.<target>.defaultTag` for the package that holds `filePath`, then
 * validates it: the one path every compile entry shares, so none can diverge
 * from the registry's. A rejected value comes back as the diagnostic and no
 * value, so the compile falls to the next rung of the ladder. The scope is
 * built only when the package sets a value.
 */
export function checkConfiguredDefaultTag(
  filePath: string,
  target: string,
  options: { scope: DefaultTagScopeSource },
): CheckedDefaultTag {
  const config = readTargetDefaultTag(filePath, target);
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
  /** The target whose `mx.<target>.defaultTag` this compile reads. */
  target: string;
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
 * The validated `mx.<target>.defaultTag` for `file`, or `undefined`, for a
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
    scope: () => ownScope(file, input),
  });
  if (diagnostic) input.report(diagnostic);
  if (input.tags) {
    const scope = ownScope(file, input);
    for (const found of contractDefaultTagDiagnostics({
      tags: input.tags,
      customTags: scope.customTags ?? {},
      scope,
      host: {
        name: input.hostName ?? input.target,
        ...(input.declarations?.allowContractDefaultTag === false
          ? { allowContractDefaultTag: false }
          : {}),
      },
    }))
      input.report(found);
  }
  return value;
}

function ownScope(file: string, input: OwnDefaultTagInput): DefaultTagScope {
  return buildScope({
    dir: dirname(file),
    translator: input.translator,
    ...(input.customTags ? { customTags: input.customTags } : {}),
    ...(input.declarations ? { declarations: input.declarations } : {}),
    ...(input.builtins ? { builtins: input.builtins } : {}),
  });
}

/**
 * The scope a target's own compile gives a `defaultTag`: its package's custom
 * tags, Marko's lookup for its translator (parse shape, and its elements
 * through the host's own `isElement`), and the names it lists as built-in.
 */
export function defaultTagScopeFor(
  input: DefaultTagScopeInput,
): DefaultTagScope {
  return buildScope(input);
}

/** What `defaultTagScopeFor` needs. */
export interface DefaultTagScopeInput {
  /** A directory of the package: the lookup is built as seen from there. */
  dir: string;
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
  const lookup = buildMarkoLookup(input.dir, input.translator);
  const declarations = input.declarations;
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

/**
 * Whether a name is an element of the target: the host's own `isElement` says
 * so AND Marko's own `html` flag is on the tag def. The flag is a taglib
 * property (every element of marko-html, -svg and -math has it, no core or
 * translator tag does), so a host whose own `isElement` is casing-only
 * (Solid) cannot let `await` or `define` through, and a target with no
 * declarations is covered too.
 */
export function elementPredicate(
  lookup: { getTag(name: string): object | undefined } | undefined,
  declarations: HostDeclarations | undefined,
): (name: string) => boolean {
  const flagged = (name: string): boolean =>
    (lookup?.getTag(name) as { html?: unknown } | undefined)?.html === true;
  return (name) =>
    (!declarations?.isElement ||
      declarations.isElement(name, {
        lookup,
        defines: new Set<string>(),
        imports: new Set<string>(),
      } as unknown as Ctx)) &&
    flagged(name);
}

/**
 * Whether the host compiles a name its lookup does not know as a native
 * element: its own `isElement` answer, never the lookup's flag. A target with
 * no declarations cannot say.
 */
export function nativeElementPredicate(
  lookup: { getTag(name: string): object | undefined } | undefined,
  declarations: HostDeclarations | undefined,
): (name: string) => boolean {
  return (name) =>
    !!declarations?.isElement &&
    declarations.isElement(name, {
      lookup,
      defines: new Set<string>(),
      imports: new Set<string>(),
    } as unknown as Ctx);
}
