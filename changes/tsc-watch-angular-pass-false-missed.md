---
packages: [tsc]
kind: Fixed
---
`mx-tsc -b -w` no longer prints "the Angular template pass missed this rebuild" after a change that rebuilds more than one project (two projects that include the same file). tsc builds the second project on a later timer turn, and the notice was decided between the two, before the one summary that follows the last project; the pass had run. A `-b -w` rebuild is now called missed only after it stays quiet for 400 ms with no further file read and no recognized summary, so a localized `tsc --locale` rebuild still gets the notice. `-w` without `-b` is unchanged.
