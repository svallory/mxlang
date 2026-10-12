---
packages: [angular]
kind: Fixed
---
In an Angular tag, a template that reads a name its own module declares (`static let n`, `static const k`, a `static function f`, or an imported value) now sees it. The generated component class had no such member, so `{{ n }}` rendered blank, or failed `ng build` under strict template checks, and MX reported nothing. The class now exposes each module-level name the template reads through an accessor, so a `static let` that module code reassigns shows its current value, and a `let` or `var` also takes an assignment from the template. A type-only name gets no member. When a tag reads a bare name that is also one of its `Input` properties, that is a positioned error at the read asking to rename one of them.
