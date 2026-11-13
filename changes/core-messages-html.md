---
packages: [html]
kind: Changed
---
`<div on:click=fn/>` is refused with the fix-it every other host gives, naming both MX spellings: `` `on:click=fn` is not MX syntax; write `onClick=fn` for a DOM event or `on-click=fn` for a custom event name (Marko rejects this form too) ``, in place of Marko's `` did you mean `onClick` ``. Same input, same position; an empty `on:`, `class:`, `style:` and a modifier on a component call keep their messages.
