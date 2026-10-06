import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { delegateEvents as _$delegateEvents } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<button>`);
import { createSignal } from "solid-js";
export function Counter() {
 const [count, setCount] = createSignal(0);
 var _el$ = _tmpl$();
 _el$.$$click = function() {
 setCount(count() + 1);
 };
 _$insert(_el$, count);
 return _el$;
}
_$delegateEvents(["click"]);
