import { escape as _$escape } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
import { Errored as _$Errored } from "@solidjs/web";
import { Loading as _$Loading } from "@solidjs/web";
var _tmpl$ = [
 "<div",
 "><!--$-->",
 "<!--/--><!--$-->",
 "<!--/--><!--$-->",
 "<!--/--><!--$-->",
 "<!--/--></div>"
];
var _tmpl$2 = [
 "<p",
 ">caught: <!--$-->",
 "<!--/-->:<!--$-->",
 "<!--/--></p>"
];
var _tmpl$3 = [
 "<p",
 ">msg: <!--$-->",
 "<!--/--></p>"
];
var _tmpl$4 = ["<p", ">failed</p>"];
var _tmpl$5 = ["<span", ">risky</span>"];
var _tmpl$6 = ["<span", ">slow</span>"];
export function TryCatch() {
 var _v$ = _$ssrHydrationKey(), _v$2 = _$escape(_$Errored({
 fallback: (__mxErr, ...__mxArgs) => ((e, reset, _v$6, _v$7, _v$8) => (_v$6 = _$ssrHydrationKey(), _v$7 = () => {
 return _$escape(e.message);
 }, _v$8 = typeof reset, _$ssr(_tmpl$2, _v$6, _v$7, _v$8)))(__mxErr(), ...__mxArgs),
 get children() {
 return _$Loading({ get children() {
 return Risky({});
 } });
 }
 })), _v$3 = _$escape(_$Errored({
 fallback: (__mxErr, ...__mxArgs) => (({ message }) => {
 var _v$9, _v$10;
 return _v$9 = _$ssrHydrationKey(), _v$10 = _$escape(message), _$ssr(_tmpl$3, _v$9, _v$10);
 })(__mxErr(), ...__mxArgs),
 get children() {
 return _$Loading({ get children() {
 return Risky({});
 } });
 }
 })), _v$4 = _$escape(_$Errored({
 fallback: () => {
 var _v$11;
 return _v$11 = _$ssrHydrationKey(), _$ssr(_tmpl$4, _v$11);
 },
 get children() {
 return _$Loading({ get children() {
 return Risky({});
 } });
 }
 })), _v$5 = _$escape(_$Loading({
 get fallback() {
 return "loading…";
 },
 get children() {
 return Slow({});
 }
 }));
 return _$ssr(_tmpl$, _v$, _v$2, _v$3, _v$4, _v$5);
}
function Risky() {
 var _v$12 = _$ssrHydrationKey();
 return _$ssr(_tmpl$5, _v$12);
}
function Slow() {
 var _v$13 = _$ssrHydrationKey();
 return _$ssr(_tmpl$6, _v$13);
}
