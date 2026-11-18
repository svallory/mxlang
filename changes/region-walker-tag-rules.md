---
packages: [core, tsx-bridge, angular]
kind: Fixed
---
In a file routed to a dialect whose `tagRules` is `none`, MX regions found by the TypeScript bridge (`parse`, `print`, and an Angular `.ng.mx` region through `compileNgMx`) now have no void elements, as core already lowers them: `<input><child/></input>` and `<input></input>` compile instead of being refused as `An MX region has exactly one root element` and `<input> is a void element and cannot have a closing tag.` This closes the Angular exception `fragment-native-tags` named. Core adds `tagRulesOf(filename)` (`@unstable`), the tag rules a routed file parses under, for the bridge to read. MX's own files and files of a dialect stating another preset keep HTML's void elements.
