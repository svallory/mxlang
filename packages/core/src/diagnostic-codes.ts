/**
 * Stable diagnostic codes of core's own errors, carried as
 * `TranslateError.diagnosticCode` and, through `lowerSource`, as
 * `IrDiagnostic.code`. A message is prose and may be reworded; a code is the
 * contract a consumer matches on. `MX_DUPLICATE_ATTRIBUTE` (a warning) lives
 * with the lowering that raises it.
 */

/** An authored tag with no contract in `customTags`, under `unknownTags: "reject"`. */
export const UNKNOWN_TAG_CODE = "MX_UNKNOWN_TAG";

/**
 * A definition that names a reserved tag, from any source: a discovered tag
 * file, an `mx.tags` directory, an `mx.contracts` entry or a `customTags`
 * entry. The definition is dropped.
 */
export const RESERVED_TAG_CODE = "MX_RESERVED_TAG";

/** A child tag a parent's `children` contract does not allow. */
export const TAG_NOT_ALLOWED_CODE = "MX_TAG_NOT_ALLOWED";

/** Text where a parent's `children` contract allows none. */
export const TEXT_NOT_ALLOWED_CODE = "MX_TEXT_NOT_ALLOWED";

/** A second expression after the one an expression position holds. */
export const EXPECTED_SINGLE_EXPRESSION_CODE = "MX_EXPECTED_SINGLE_EXPRESSION";

/** The stable code of a front-end parse error, by the parser's own `MxParseError.code`. */
export const PARSE_ERROR_DIAGNOSTIC_CODES: Readonly<Record<string, string>> = {
  BABEL_ParseExpressionExpectsEOF: EXPECTED_SINGLE_EXPRESSION_CODE,
};
