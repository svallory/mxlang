---
packages: [core, angular]
kind: Changed
---
On Angular, the refusal of an attribute on a bare `<style>` (`<style media="print">`) now ends with Angular's route instead of stock Marko's advice to use `<html-style>`, which Angular refuses too: `` The `style` does not support html attributes. Angular refuses `<html-style>` too: its template compiler lifts every `<style>` element into the component's styles and drops its attributes. Put the CSS in the component's `styles` or `styleUrls`, or in a global stylesheet listed in the `styles` array of `angular.json`. For `media`, write an `@media` rule in that CSS. `` The code (`MX_INVALID_ATTRIBUTE`) and position are unchanged. Core adds the optional `HostDeclarations.bareStyleAttributesHint`, the sentence a host sets to replace stock's second sentence; every other host keeps stock's message unchanged.
