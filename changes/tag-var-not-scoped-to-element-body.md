---
packages: [core, html]
kind: Fixed
---
A native element's body is now its own scope for the tag variables it declares, as in Marko 6.4.4. `<let/count=1/><div><const/count=2/>${count}</div>${count}` renders `<div>2</div>1` on the html target; it used to emit a second `const count` in the same block and fail to load. A `<const>`, `<let>`, `<define>` or `/var` written in an element body no longer collides with the same name outside it or in a sibling element, and the write checks follow the scope: an inner `<const/x>` no longer makes a later write to the outer `<let/x>` an error, and an inner `<let/x>` no longer makes a later write to the outer `<const/x>` legal. Behaviour change: a read after the element of a name declared only inside it (`<div><const/x=1/></div>${x}`) used to render the inner value and now throws `x is not defined` at render, as it already did after an `<if>` body.
