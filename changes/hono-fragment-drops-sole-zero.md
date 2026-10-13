---
packages: [preact, react, hono]
kind: Fixed
---
A lone placeholder whose value is `0` or `NaN` no longer renders nothing on Hono. Hono's `Fragment` drops a sole falsy child, so `<if=input.a>${input.x}</if>` with `x` = 0 rendered an empty string where the html target renders `0`, `<for|i| of=[0,1]>${i}</for>` rendered `1` instead of `01`, and a define call or dynamic tag body `${0}` rendered empty. The emitter now writes a `{null}` child after a fragment's only value child, in the component's own return, a `<for>` row, the body of a define call or dynamic tag, a `<define>` and a `<try>`. A null child renders nothing on every JSX host, so the Preact and React output is unchanged apart from that extra child, the way an attribute-tag body was already written.
