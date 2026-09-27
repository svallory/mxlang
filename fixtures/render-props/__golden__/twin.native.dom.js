import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { createComponent as _$createComponent } from "@solidjs/web";
import { For as _$For } from "@solidjs/web";
import { Show as _$Show } from "@solidjs/web";
import { Errored as _$Errored } from "@solidjs/web";
import { Loading as _$Loading } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<section><header></header><main></main><footer>`);
var _tmpl$2 = /* @__PURE__ */ _$template(`<p>body`);
var _tmpl$3 = /* @__PURE__ */ _$template(`<div><!><!><!><!><!>`);
var _tmpl$4 = /* @__PURE__ */ _$template(`<li>: <!>`);
var _tmpl$5 = /* @__PURE__ */ _$template(`<b>`);
var _tmpl$6 = /* @__PURE__ */ _$template(`<p>`);
var _tmpl$7 = /* @__PURE__ */ _$template(`<p>Loading…`);
var _tmpl$8 = /* @__PURE__ */ _$template(`<h1>Title`);
var _tmpl$9 = /* @__PURE__ */ _$template(`<small>`);
var _tmpl$10 = /* @__PURE__ */ _$template(`<span>risky`);
var _tmpl$11 = /* @__PURE__ */ _$template(`<span>slow`);
import { createSignal } from "solid-js";
function Layout(props) {
 var _el$ = _tmpl$();
 var _el$2 = _el$.firstChild;
 var _el$3 = _el$2.nextSibling;
 var _el$4 = _el$3.nextSibling;
 _$insert(_el$2, () => {
 return props.header;
 });
 _$insert(_el$3, () => {
 return props.children;
 });
 _$insert(_el$4, () => {
 return props.footer(2026);
 });
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
 var _el$5 = _tmpl$3();
 var _el$6 = _el$5.firstChild;
 var _el$7 = _el$6.nextSibling;
 var _el$8 = _el$7.nextSibling;
 var _el$9 = _el$8.nextSibling;
 var _el$11 = _el$9.nextSibling;
 _$insert(_el$5, _$createComponent(_$For, {
 get each() {
 return items();
 },
 children: (item, i) => (() => {
 var _el$12 = _tmpl$4();
 var _el$13 = _el$12.firstChild;
 var _el$14 = _el$13.nextSibling;
 _$insert(_el$12, i, _el$13);
 _$insert(_el$12, item, _el$14);
 return _el$12;
 })()
 }), _el$6);
 _$insert(_el$5, _$createComponent(_$Show, {
 get when() {
 return user();
 },
 fallback: () => "Anonymous",
 children: (u) => (() => {
 var _el$15 = _tmpl$5();
 _$insert(_el$15, () => {
 return u().name;
 });
 return _el$15;
 })()
 }), _el$7);
 _$insert(_el$5, _$createComponent(_$Errored, {
 fallback: (e, reset) => () => (() => {
 var _el$16 = _tmpl$6();
 _$insert(_el$16, () => {
 return e.message;
 });
 return _el$16;
 })(),
 get children() {
 return _$createComponent(Risky, {});
 }
 }), _el$8);
 _$insert(_el$5, _$createComponent(_$Loading, {
 fallback: () => _tmpl$7(),
 get children() {
 return _$createComponent(Slow, {});
 }
 }), _el$9);
 _$insert(_el$5, _$createComponent(Layout, {
 header: () => _tmpl$8(),
 footer: (year) => () => (() => {
 var _el$19 = _tmpl$9();
 _$insert(_el$19, year);
 return _el$19;
 })(),
 get children() {
 return _tmpl$2();
 }
 }), _el$11);
 return _el$5;
}
function Risky() {
 return _tmpl$10();
}
function Slow() {
 return _tmpl$11();
}
