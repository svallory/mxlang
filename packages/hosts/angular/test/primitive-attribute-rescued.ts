/**
 * Real attributes whose name misses Angular's DOM schema in its own spelling
 * because the registry keys the IDL property (`maxlength` is `maxLength`),
 * each on an element that has it. Found case-insensitively, they bind as
 * `[attr.name]` (see `nativeBinding`), exactly as Marko prints them.
 */
// `<iframe allowfullscreen>`/`referrerpolicy` resolve the same way, but
// Angular refuses any binding of them on an iframe (NG0910); see
// primitive-attributes.test.ts.
export const RESCUED: [tag: string, name: string][] = [
  ["input", "maxlength"],
  ["input", "minlength"],
  ["input", "inputmode"],
  ["input", "formnovalidate"],
  ["iframe", "frameborder"],
  ["img", "referrerpolicy"],
  ["video", "playsinline"],
  ["img", "usemap"],
  ["img", "ismap"],
  ["img", "crossorigin"],
  ["td", "colspan"],
  ["td", "rowspan"],
  ["div", "accesskey"],
  ["div", "contenteditable"],
  ["div", "enterkeyhint"],
  ["form", "novalidate"],
];
