---
packages: [tsc]
kind: Fixed
---
`mx-tsc -b -w` no longer prints "the Angular template pass missed this rebuild" after a change that rebuilds more than one project (two projects that include the same file), and now prints it for every rebuild whose summary is not recognized, including each rebuild of a single project under a localized `tsc --locale`. tsc builds a rebuild's projects on separate build turns and writes the one summary after the last; the notice was decided between turns, before the summary, although the pass had run. A `-b -w` rebuild is now decided at the end of its last build turn, in any locale. `-w` without `-b` is unchanged.
