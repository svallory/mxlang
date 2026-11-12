---
packages: [host-preact, host-hono, host-react]
kind: Fixed
---

Hono, Preact and React match stock Marko in four rendering details. A `<@catch>` whose body is a `<for>` renders its rows without commas on Hono. `${1n}` prints `1` and `${0n}` prints nothing on Hono. A null-prototype object in a Hono text placeholder throws, as it does in Marko, instead of printing `[object Object]`. A spread's `textContent` and `innerText` keys are written as ordinary escaped attributes (`textcontent=`, `innertext=`) on Preact, React and Hono, so no renderer hyphenates them or assigns them as DOM properties.
