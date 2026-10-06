---
title: "Preact: whole-file .mx (alpha)"
description: "A .mx file that is the entire Preact component: the compiler writes the function, your Input interface is the props type, hooks go in <const>."
---

# Preact: whole-file `.mx` (alpha)

A plain `.mx` file on the Preact host is the whole component. There is no function to write: MX emits the default-exported function component, and `export interface Input` becomes its props type.

**Alpha.** [`.preact.mx`](/hosts/preact/) is the form to start with. Whole-file `.mx` exists so that one template can later compile to several hosts; today it trades Preact's own function for MX's statements, and hooks read less naturally.

```mx title="Counter.mx"
import { useState } from "preact/hooks";

export interface Input {
  label: string;
}

<const/state=useState(0)/>
<const/count=state[0]/>
<const/setCount=state[1]/>

<button onClick() { setCount(count + 1); }>${input.label}: ${count}</button>
<if=(count > 2)><p>That is plenty.</p></if>
```

- **Props** are `input`: `input.label`.
- **Hooks go in `<const>`**, which becomes a statement in the component body. `static` is module scope and must not call a hook.
- **`import`, `static` and `export`** are hoisted to the module.
- **Marko's stateful tags are errors** that name the hook to use: `<let>` names `useState`, `<effect>` names `useEffect`, `<id>` names `useId`.

## Selecting the host

A whole-file `.mx` has no host in its name, so `package.json` says which one compiles it: `"mx": { "host": "preact" }`. A project with exactly one `@mxlang/*` host dependency may leave the field out. `mx.target: "preact-jsx"` selects Preact too; if both are given and disagree, the tools report `target-host-mismatch`.

Setup is the same as for [region files](/hosts/preact/#preact-setup). Everything in [What MX compiles to](/hosts/preact/semantics/) applies; a whole-file template also has `<const/x=expr/>` (a `const` in the component body) and `<return>`.

`examples/preact-app` is a complete whole-file app.
