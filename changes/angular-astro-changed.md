---
packages: [angular, astro]
kind: Changed
---

`<html-style>` is now a positioned error at the tag name on Angular, like `<html-script>`, instead of being emitted as a literal `<html-style>` element: Angular's template compiler lifts every `<style>` into the component's styles and drops its attributes, so the style could not reach the page as written. The Angular and Astro messages about attribute tags (an array, attributes, nesting, no body, inside `<for>`, on a `<define>` call, a repeated projection, and Astro's attribute tags on an HTML element) now use the dialect's message vocabulary for the words "attribute tag(s)", "attribute-tag" and "attributes"; the default text is unchanged.
