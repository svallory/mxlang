/**
 * The tag scan's manifest-parse prefix is shared with
 * `scanDiagnosticsNotSaidByPolicy`, which recognizes the scan twin it drops.
 * The consequence is shared by the scan's `MX_IGNORED_CONFIG` diagnostic
 * (`scan.ts` readManifest) and the host policy's `malformed-package-json`
 * diagnostic (`host-policy.ts` resolveTargetPolicyDetailed). The policy's
 * parse-failure reason is separate; only the scan and filter use the prefix.
 *
 * Internal on purpose: nothing outside core builds these strings, so this is
 * not exported from the package index.
 */

/** The scan diagnostic's opening, also used by the filter to match its twin. */
export const MANIFEST_PARSE_PREFIX =
  "`package.json` could not be parsed as JSON";

/**
 * What happens to `mx.tags` and `mx.contracts` while the manifest does not
 * parse: nothing is loaded, unless a previous valid manifest was read, in
 * which case its entries stay in force.
 */
export function manifestParseConsequence(manifest: unknown): string {
  return manifest === undefined
    ? "no `mx.tags` or `mx.contracts` are loaded until the manifest parses"
    : "the previous valid `mx.tags` and `mx.contracts` stay in force";
}
