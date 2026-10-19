---
packages: [solid, preact, react, hono, typescript-plugin, tsc]
kind: Fixed
---
Method-shorthand parameter types, defaults and generic constraints on ordinary element and component attributes in whole-file Solid, Preact, React and Hono templates now report TypeScript errors at their exact authored positions. Solid also covers dynamic-tag props and attribute-tag attributes. Printed method heads are mapped separately from their bodies; emitted code is unchanged.
