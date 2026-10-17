---
packages: [angular]
kind: Fixed
---
A tag variable is now scoped to the native element body that declares it on Angular, as in Marko 6.4.4. `<const/count=1/><div><const/count=2/>${count}</div>${count}` rendered `<div>1</div>1`, and two sibling elements that each declared the same name rendered the first one empty, because Angular scopes a `@let` to a view and an element does not open one, so every `@let count` in the element bodies collided with the outer one. The emitter now gives a `<const>` or `<define>` written directly in a native element body a name of its own and points the reads after it in that body at it, so an inner declaration shadows the outer one only inside the element and a read after the element is the outer binding. The DOM and content projection into a hand-written component called by selector are unchanged.
