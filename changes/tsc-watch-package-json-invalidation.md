---
packages: [tsc]
kind: Fixed
---
Under `mx-tsc --watch`, a change to the `package.json` that decides a `.mx` file's host now rebuilds and recompiles those files, with `-w -p` and with `-b -w`. Before, breaking it (an `mx.target` that belongs to another host, an unparseable file) started no rebuild and printed `Found 0 errors`, and a rebuild that something else started kept the old answer: fixing it left the `TS80001` and `TS80003` lines until every `.mx` file under it had compiled again, and a `TS80003` line pointed at the old line numbers after the file was edited. A break is reported on the rebuild it causes, a fix clears both lines at once, the position follows the new text, and a nearer `package.json` created later is noticed. An edit that changes nothing prints the same diagnostics as before. The one-shot `--pretty` line `mx-tsc: Found N MX error(s)` now counts a `TS80003` host-policy error with the other MX errors.
