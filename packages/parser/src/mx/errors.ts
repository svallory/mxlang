import { ParseErrorEnum } from "../babel/parse-error.ts";

/**
 * Parse errors raised while lowering an MX region. These go through Babel's
 * normal `raise` path so the TypeScript plugin's `tryParse` rollback (which
 * counts `state.errors`) sees them as ordinary parse errors — the same way a
 * malformed JSX element would be seen.
 */
export const MxErrors = ParseErrorEnum`mx`({
  HtmlParserError: ({ message }: { message: string }) => message,
  HostError: ({ message }: { message: string }) => message,
  UnsupportedConstruct: ({ construct }: { construct: string }) =>
    `${construct} is not supported yet.`,
  InterpolationOutsideRegion: () =>
    // biome-ignore lint/suspicious/noTemplateCurlyInString: error message text
    "MX interpolation `${...}` is only valid inside an MX region. In a TSX fragment, use `{...}` instead.",
  PositionRejected: ({ message }: { message: string }) => message,
  MissingRegionCompile: ({ filename }: { filename: string }) =>
    `An MX region needs \`mxRegionCompile\` to lower it, but none was given for "${filename}". ` +
    "Pass a `mxRegionCompile` hook when calling `parse`/`print` — for `.solid.mx`, that is " +
    '`compileSolidMx` from "@mxlang/solid".',
});
