import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { createComponent as _$createComponent } from "@solidjs/web";
import { Loading as _$Loading } from "@solidjs/web";
import { Errored as _$Errored } from "@solidjs/web";
var _tmpl$ = /*#__PURE__*/_$template(`<div><!><!><!><!>`),
 _tmpl$2 = /*#__PURE__*/_$template(`<p>caught: <!>:<!>`),
 _tmpl$3 = /*#__PURE__*/_$template(`<p>msg: `),
 _tmpl$4 = /*#__PURE__*/_$template(`<p>failed`),
 _tmpl$5 = /*#__PURE__*/_$template(`<span>risky`),
 _tmpl$6 = /*#__PURE__*/_$template(`<span>slow`);
export function TryCatch() {
 var _el$ = _tmpl$(),
 _el$2 = _el$.firstChild,
 _el$3 = _el$2.nextSibling,
 _el$4 = _el$3.nextSibling,
 _el$5 = _el$4.nextSibling;
 _$insert(_el$, _$createComponent(_$Errored, {
 fallback: (__mxErr, ...__mxArgs) => ((e, reset) => (() => {
 var _el$6 = _tmpl$2(),
 _el$7 = _el$6.firstChild,
 _el$9 = _el$7.nextSibling,
 _el$8 = _el$9.nextSibling,
 _el$0 = _el$8.nextSibling;
 _$insert(_el$6, () => e.message, _el$9);
 _$insert(_el$6, typeof reset, _el$0);
 return _el$6;
 })())(__mxErr(), ...__mxArgs),
 get children() {
 return _$createComponent(_$Loading, {
 get children() {
 return _$createComponent(Risky, {});
 }
 });
 }
 }), _el$2);
 _$insert(_el$, _$createComponent(_$Errored, {
 fallback: (__mxErr, ...__mxArgs) => (({
 message
 }) => (() => {
 var _el$1 = _tmpl$3(),
 _el$10 = _el$1.firstChild;
 _$insert(_el$1, message, null);
 return _el$1;
 })())(__mxErr(), ...__mxArgs),
 get children() {
 return _$createComponent(_$Loading, {
 get children() {
 return _$createComponent(Risky, {});
 }
 });
 }
 }), _el$3);
 _$insert(_el$, _$createComponent(_$Errored, {
 fallback: () => _tmpl$4(),
 get children() {
 return _$createComponent(_$Loading, {
 get children() {
 return _$createComponent(Risky, {});
 }
 });
 }
 }), _el$4);
 _$insert(_el$, _$createComponent(_$Loading, {
 get fallback() {
 return "loading\u2026";
 },
 get children() {
 return _$createComponent(Slow, {});
 }
 }), _el$5);
 return _el$;
}
function Risky() {
 return _tmpl$5();
}
function Slow() {
 return _tmpl$6();
}