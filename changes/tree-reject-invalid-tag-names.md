---
packages: [core, data]
kind: Fixed
---
A tag name outside letters, digits and `-._:$` (`&title`, `a!b`) is now a positioned error on the name ("Invalid tag name `&title`; Marko rejects it too — …"), next to the existing attribute-name error, on every target. Stock Marko lexes such a name and fails only later in its translator ("Unable to find entry point for custom tag"); `parseData("div\n  &title\n")` used to return a child tag named `&title` with no diagnostic.
