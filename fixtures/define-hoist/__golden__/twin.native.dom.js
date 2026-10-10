import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<li>-<!>`);
var _tmpl$2 = /* @__PURE__ */ _$template(`<section><h1>`);
var _tmpl$3 = /* @__PURE__ */ _$template(`<div><!><!><!>`);
function Empty() {
 return "no args";
}
function Row(item, i) {
 var _el$ = _tmpl$();
 var _el$2 = _el$.firstChild;
 var _el$3 = _el$2.nextSibling;
 _$insert(_el$, item, _el$2);
 _$insert(_el$, i, _el$3);
 return _el$;
}
function Card(title, { head }) {
 var _el$4 = _tmpl$2();
 var _el$5 = _el$4.firstChild;
 _$insert(_el$5, title);
 _$insert(_el$4, head, null);
 return _el$4;
}
export function DefineHoist() {
 var _el$6 = _tmpl$3();
 var _el$7 = _el$6.firstChild;
 var _el$8 = _el$7.nextSibling;
 var _el$9 = _el$8.nextSibling;
 _$insert(_el$6, Empty, _el$7);
 _$insert(_el$6, () => {
 return Row(1, 0);
 }, _el$8);
 _$insert(_el$6, () => {
 return Card("Hi", { head: () => "tagged" });
 }, _el$9);
 return _el$6;
}
