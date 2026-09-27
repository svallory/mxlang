import { template as _$template } from "@solidjs/web";
import { Loading as _$Loading } from "@solidjs/web";
import { Errored as _$Errored } from "@solidjs/web";
import { Show as _$Show } from "@solidjs/web";
import { createComponent as _$createComponent } from "@solidjs/web";
import { For as _$For } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
var _tmpl$ = /*#__PURE__*/_$template(`<section><header></header><main></main><footer>`),
 _tmpl$2 = /*#__PURE__*/_$template(`<p>`),
 _tmpl$3 = /*#__PURE__*/_$template(`<p>Loading…`),
 _tmpl$4 = /*#__PURE__*/_$template(`<p>body`),
 _tmpl$5 = /*#__PURE__*/_$template(`<div><!><!><!><!><!>`),
 _tmpl$6 = /*#__PURE__*/_$template(`<li>: <!>`),
 _tmpl$7 = /*#__PURE__*/_$template(`<b>`),
 _tmpl$8 = /*#__PURE__*/_$template(`<h1>Title`),
 _tmpl$9 = /*#__PURE__*/_$template(`<small>`),
 _tmpl$0 = /*#__PURE__*/_$template(`<span>risky`),
 _tmpl$1 = /*#__PURE__*/_$template(`<span>slow`);
import { createSignal } from "solid-js";
function Layout(props) {
 var _el$ = _tmpl$(),
 _el$2 = _el$.firstChild,
 _el$3 = _el$2.nextSibling,
 _el$4 = _el$3.nextSibling;
 _$insert(_el$2, () => props.header.content);
 _$insert(_el$3, () => props.children);
 _$insert(_el$4, () => props.footer.content(2026));
 // Each slot is wrapped in an element rather than sitting as a bare
 // placeholder run: MX drops the whitespace-only lines between siblings
 // where JSX keeps one space each, and the formatter insists on breaking
 // this body across lines. With real element boundaries the two agree.
 // See `fixtures/README.md`, "Whitespace in a twin".
 return _el$;
}
export function RenderProps() {
 // Setters are unused: the fixture exercises lowering shapes, not behavior.
 const [items, _setItems] = createSignal([]);
 const [user, _setUser] = createSignal(null);
 const errorFallback = (e, _reset) => (() => {
 var _el$5 = _tmpl$2();
 _$insert(_el$5, () => e.message);
 return _el$5;
 })();
 const loadingFallback = _tmpl$3();
 var _el$7 = _tmpl$5(),
 _el$9 = _el$7.firstChild,
 _el$0 = _el$9.nextSibling,
 _el$1 = _el$0.nextSibling,
 _el$10 = _el$1.nextSibling,
 _el$11 = _el$10.nextSibling;
 _$insert(_el$7, _$createComponent(_$For, {
 get each() {
 return items();
 },
 children: (item, i) => (() => {
 var _el$12 = _tmpl$6(),
 _el$13 = _el$12.firstChild,
 _el$14 = _el$13.nextSibling;
 _$insert(_el$12, i, _el$13);
 _$insert(_el$12, item, _el$14);
 return _el$12;
 })()
 }), _el$9);
 _$insert(_el$7, _$createComponent(_$Show, {
 get when() {
 return user();
 },
 fallback: "Anonymous",
 children: u => (() => {
 var _el$15 = _tmpl$7();
 _$insert(_el$15, () => u().name);
 return _el$15;
 })()
 }), _el$0);
 _$insert(_el$7, _$createComponent(_$Errored, {
 fallback: errorFallback,
 get children() {
 return _$createComponent(Risky, {});
 }
 }), _el$1);
 _$insert(_el$7, _$createComponent(_$Loading, {
 fallback: loadingFallback,
 get children() {
 return _$createComponent(Slow, {});
 }
 }), _el$10);
 _$insert(_el$7, _$createComponent(Layout, {
 header: {
 content: () => _tmpl$8()
 },
 footer: {
 content: year => () => (() => {
 var _el$17 = _tmpl$9();
 _$insert(_el$17, year);
 return _el$17;
 })()
 },
 get children() {
 return _tmpl$4();
 }
 }), _el$11);
 return _el$7;
}
function Risky() {
 return _tmpl$0();
}
function Slow() {
 return _tmpl$1();
}