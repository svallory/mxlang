/**
 * A dialect's own tag vocabulary (`Dialect.contracts`): the contracts every
 * file of the dialect is checked against, in every tool. Validated once per
 * module revision when the dialect loads ({@link checkDialectContracts}), and
 * merged with the caller's `customTags` in each entry that resolves a
 * dialect ({@link withDialectContracts}).
 */
import { claimedFields } from "./contract-fields.ts";
import { isTranslateError, type TranslateError } from "./core.ts";
import {
  type ContractMap,
  CUSTOM_TAG_KEYS,
  type CustomTag,
  isValidatedContract,
  markValidatedContracts,
  rejectUnknownDeclarationKeys,
  rejectUnknownTagKeys,
  rejectUnreachableHooks,
} from "./custom-tags.ts";
import { isDeepFrozen } from "./deep-frozen.ts";
import {
  INVALID_DIALECT_CONTRACT_CODE,
  isReservedHookCode,
} from "./diagnostic-codes.ts";
import { checkParseOptions } from "./scan.ts";
import type { Dialect } from "./syntax-table.ts";
import {
  RESERVED_NAMES,
  reservedNameMessage,
  TAG_NAME_RE,
} from "./tag-names.ts";

/**
 * Places a contract error: `at` is the key path in the dialect's default
 * export (`["contracts", "<name>"]`), `code` the diagnostic code it carries.
 */
export type ContractFail = (
  message: string,
  at: readonly string[],
  code: string,
) => never;

/** The `CustomTag` keys a dialect contract may state (every one but `template`). */
const CONTRACT_KEYS = CUSTOM_TAG_KEYS.filter((key) => key !== "template");

const CONTRACT_HOOKS = ["analyze", "transform", "finalize"] as const;

const CORE_RESERVED: ReadonlySet<string> = new Set(RESERVED_NAMES);

/**
 * The code a refused entry carries: the dialect's own, when its
 * `checkContract` gave one; otherwise this rule's. A code of MX's own (the
 * cause's rule, or the default of a `checkContract` that gave none) is
 * reported as this rule.
 */
function causeCode(cause: TranslateError): string {
  const code = cause.diagnosticCode;
  return code !== undefined && !isReservedHookCode(code)
    ? code
    : INVALID_DIALECT_CONTRACT_CODE;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validates `dialect.contracts` as a registration would, once, when the
 * dialect loads: a plain object of plain `CustomTag` objects, each named by
 * a usable tag name that core does not reserve, stating only `CustomTag`
 * keys other than `template` (plus the keys the dialect claims), with valid
 * `parseOptions`, hooks that are functions, and declarations core accepts
 * (`rejectUnknownDeclarationKeys`, which also runs the dialect's
 * `checkContract`, and `rejectUnreachableHooks`). The first failure is
 * placed by `fail` at the entry's key, `` `<path>contracts.<name>`: … ``,
 * with code `MX_INVALID_DIALECT_CONTRACT`, or the code the dialect's
 * `checkContract` gave. The whole dialect fails: dropping one entry would
 * let its calls pass silently. A map that passes is marked validated under
 * the dialect's claim, so registration does not check its entries again,
 * and neither does a later load that meets the same entry objects.
 */
export function checkDialectContracts(
  dialect: Record<string, unknown>,
  path: string,
  fail: ContractFail,
): void {
  const contracts = dialect.contracts;
  if (contracts === undefined) return;
  if (!isPlainObject(contracts)) {
    fail(
      `\`${path}contracts\` must be a plain object of tag contracts by tag name (a \`ContractMap\`)`,
      ["contracts"],
      INVALID_DIALECT_CONTRACT_CODE,
    );
  }
  // SAFETY: only the two claimed-key fields are read, and `checkModuleShape`
  // validated `contractFields` and `checkContract` before this runs.
  const claimed = claimedFields(dialect as unknown as Dialect);
  const map = contracts as Record<string, unknown>;
  for (const name of Object.keys(map)) {
    const at = ["contracts", name];
    const entry = `\`${path}contracts.${name}\``;
    const refuse = (problem: string, code = INVALID_DIALECT_CONTRACT_CODE) =>
      fail(`${entry}: ${problem}`, at, code);
    if (!TAG_NAME_RE.test(name)) {
      refuse(
        `\`${name}\` is not a tag name; a tag name starts with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots`,
      );
    }
    if (CORE_RESERVED.has(name)) refuse(reservedNameMessage(name));
    const definition = map[name];
    if (!isPlainObject(definition)) {
      fail(
        `${entry} must be a plain CustomTag object`,
        at,
        INVALID_DIALECT_CONTRACT_CODE,
      );
    }
    for (const key of Object.getOwnPropertyNames(definition)) {
      if ((CONTRACT_KEYS as readonly string[]).includes(key)) continue;
      if (claimed.tag.has(key)) continue;
      if (key === "template") {
        refuse(
          "`template` is not allowed in a dialect contract: a tag with a template is a tag file",
        );
      }
      if (key === "declares") {
        refuse(
          "`declares` is not allowed: no syntax module claims it (`contractFields`)",
        );
      }
      // Any other key: the shared refusal, listing the keys a contract has.
      try {
        rejectUnknownTagKeys(
          name,
          definition,
          claimed,
          undefined,
          CONTRACT_KEYS,
        );
      } catch (cause) {
        if (!isTranslateError(cause)) throw cause;
        refuse(cause.message, causeCode(cause));
      }
    }
    for (const hook of CONTRACT_HOOKS) {
      if (
        definition[hook] !== undefined &&
        typeof definition[hook] !== "function"
      ) {
        refuse(`\`${hook}\` must be a function`);
      }
    }
    // A deep-frozen entry already checked under this claim (the same object,
    // from an earlier load or call) is not checked again. An entry that is
    // not deep-frozen can change in place, so it is checked every time; a
    // routed dialect is checked once per load of its module either way.
    if (
      isDeepFrozen(definition) &&
      isValidatedContract(definition as CustomTag, claimed)
    ) {
      continue;
    }
    try {
      if (definition.parseOptions !== undefined) {
        checkParseOptions(definition.parseOptions, "", "parseOptions");
      }
      // SAFETY: the keys and hooks above are a CustomTag's; these checks
      // read the declarations dynamically and refuse what they cannot use.
      const all = map as ContractMap;
      const only = (tag: string) => tag === name;
      rejectUnknownDeclarationKeys(all, claimed, only);
      rejectUnreachableHooks(all, only);
    } catch (cause) {
      if (!isTranslateError(cause)) throw cause;
      refuse(cause.message, causeCode(cause));
    }
  }
  markValidatedContracts(map as ContractMap, claimed);
}

/** The merged maps, so merging one again (`lowerSource` then `compileSource`) is free. */
const mergedMaps = new WeakSet<object>();

/** The key a call with no `customTags` memoizes under. */
const NO_TAGS: ContractMap = Object.freeze(Object.create(null));

/** Whether `map` is one {@link withDialectContracts} built. */
export function isMergedContracts(map: object): boolean {
  return mergedMaps.has(map);
}

/**
 * Merged maps per dialect, for the `contracts` object they merged (a dialect
 * object that is not frozen may get a new one), per caller kind, per
 * `customTags` map.
 */
const merges = new WeakMap<
  Dialect,
  {
    contracts: ContractMap;
    routed: WeakMap<object, ContractMap>;
    explicit: WeakMap<object, ContractMap>;
  }
>();

/**
 * The map a file of `dialect` registers: `customTags` (the caller's, or
 * the scan's) over the dialect's `contracts`. Precedence, highest first:
 * the dialect's reserved contracts (`reserved`, its manifest's
 * `reservedTags`), then `customTags`, then the dialect's other contracts.
 * A routed caller's `customTags` naming a reserved name are refused before
 * this (`MX_RESERVED_TAG`, `dialectCustomTags`). For a
 * caller that passes the dialect itself (`explicit`), `customTags` are the
 * dialect's own and override every contract. `customTags` itself when the
 * dialect has no contracts; memoized per (dialect, map), so the merged map
 * keeps its identity across compiles and the caches keyed on it stay warm; a
 * dialect whose `contracts` object changed is merged again. For the
 * `dialect` option (`explicit`) the memo is kept only when `contracts` is
 * deep-frozen: an unfrozen map is merged on every call, because an entry in
 * it can change in place.
 */
export function withDialectContracts(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  dialect: Dialect | undefined,
  reserved: readonly string[],
  explicit: boolean,
): Record<string, CustomTag> | undefined {
  const contracts = dialect?.contracts;
  if (!dialect || !contracts) return customTags as Record<string, CustomTag>;
  if (customTags && mergedMaps.has(customTags)) {
    return customTags as Record<string, CustomTag>;
  }
  // For the `dialect` option, only a deep-frozen `contracts` map is
  // memoized: an unfrozen one can have an entry added, removed or swapped in
  // place, which identity cannot see. A routed dialect is loaded once per
  // revision of its module file and is fixed until the next one, so its merge
  // is always memoized.
  const memoized = !explicit || isDeepFrozen(contracts);
  let byKind = memoized ? merges.get(dialect) : undefined;
  if (memoized && byKind?.contracts !== contracts) {
    byKind = { contracts, routed: new WeakMap(), explicit: new WeakMap() };
    merges.set(dialect, byKind);
  }
  const memo = byKind && (explicit ? byKind.explicit : byKind.routed);
  const key = customTags ?? NO_TAGS;
  const known = memo?.get(key);
  if (known) return known;
  const isReserved = (name: string) => !explicit && reserved.includes(name);
  const merged: Record<string, CustomTag> = Object.create(null);
  for (const name of Object.keys(contracts)) {
    if (!isReserved(name)) merged[name] = contracts[name] as CustomTag;
  }
  if (customTags) {
    for (const name of Object.keys(customTags)) {
      merged[name] = customTags[name] as CustomTag;
    }
  }
  for (const name of Object.keys(contracts)) {
    if (isReserved(name)) merged[name] = contracts[name] as CustomTag;
  }
  mergedMaps.add(merged);
  memo?.set(key, merged);
  return merged;
}
