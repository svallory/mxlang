import { ssr as _$ssr } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { Loading as _$Loading } from "@solidjs/web";
import { Errored as _$Errored } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
var _tmpl$ = ["<div", "><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--></div>"],
 _tmpl$2 = ["<p", ">caught: <!--$-->", "<!--/-->:<!--$-->", "<!--/--></p>"],
 _tmpl$3 = ["<p", ">msg: <!--$-->", "<!--/--></p>"],
 _tmpl$4 = ["<p", ">failed</p>"],
 _tmpl$5 = ["<span", ">risky</span>"],
 _tmpl$6 = ["<span", ">slow</span>"];
export function TryCatch() {
 var _v$ = _$ssrHydrationKey(),
 _v$2 = _$escape(_$Errored({
 fallback: (__mxErr, ...__mxArgs) => ((e, reset, _v$6, _v$7, _v$8) => (_v$6 = _$ssrHydrationKey(), _v$7 = () => _$escape(e.message), _v$8 = typeof reset, _$ssr(_tmpl$2, _v$6, _v$7, _v$8)))(__mxErr(), ...__mxArgs),
 get children() {
 return _$Loading({
 get children() {
 return Risky({});
 }
 });
 }
 })),
 _v$3 = _$escape(_$Errored({
 fallback: (__mxErr, ...__mxArgs) => (({
 message
 }) => {
 var _v$9, _v$0;
 return _v$9 = _$ssrHydrationKey(), _v$0 = _$escape(message), _$ssr(_tmpl$3, _v$9, _v$0);
 })(__mxErr(), ...__mxArgs),
 get children() {
 return _$Loading({
 get children() {
 return Risky({});
 }
 });
 }
 })),
 _v$4 = _$escape(_$Errored({
 fallback: () => {
 var _v$1;
 return _v$1 = _$ssrHydrationKey(), _$ssr(_tmpl$4, _v$1);
 },
 get children() {
 return _$Loading({
 get children() {
 return Risky({});
 }
 });
 }
 })),
 _v$5 = _$escape(_$Loading({
 get fallback() {
 return "loading\u2026";
 },
 get children() {
 return Slow({});
 }
 }));
 return _$ssr(_tmpl$, _v$, _v$2, _v$3, _v$4, _v$5);
}
function Risky() {
 var _v$10 = _$ssrHydrationKey();
 return _$ssr(_tmpl$5, _v$10);
}
function Slow() {
 var _v$11 = _$ssrHydrationKey();
 return _$ssr(_tmpl$6, _v$11);
}