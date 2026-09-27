import { Loading as _$Loading } from "@solidjs/web";
import { Errored as _$Errored } from "@solidjs/web";
import { Show as _$Show } from "@solidjs/web";
import { For as _$For } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
import { scope as _$scope } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
var _tmpl$ = ["<section", "><header>", "</header><main>", "</main><footer>", "</footer></section>"],
 _tmpl$2 = ["<p", ">body</p>"],
 _tmpl$3 = ["<div", "><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--></div>"],
 _tmpl$4 = ["<li", "><!--$-->", "<!--/-->: <!--$-->", "<!--/--></li>"],
 _tmpl$5 = ["<b", ">", "</b>"],
 _tmpl$6 = ["<p", ">", "</p>"],
 _tmpl$7 = ["<p", ">Loading\u2026</p>"],
 _tmpl$8 = ["<h1", ">Title</h1>"],
 _tmpl$9 = ["<small", ">", "</small>"],
 _tmpl$0 = ["<span", ">risky</span>"],
 _tmpl$1 = ["<span", ">slow</span>"];
import { createSignal } from "solid-js";
function Layout(props) {
 var _v$ = _$ssrHydrationKey(),
 _v$2 = () => _$escape(props.header),
 _v$3 = _$scope(() => _$escape(props.children)),
 _v$4 = _$scope(() => _$escape(props.footer(2026)));
 // Each slot is wrapped in an element rather than sitting as a bare
 // placeholder run: MX drops the whitespace-only lines between siblings
 // where JSX keeps one space each, and the formatter insists on breaking
 // this body across lines. With real element boundaries the two agree.
 // See `fixtures/README.md`, "Whitespace in a twin".
 return _$ssr(_tmpl$, _v$, _v$2, _v$3, _v$4);
}
export function RenderProps() {
 var _v$0;
 // Setters are unused: the fixture exercises lowering shapes, not behavior.
 const [items, _setItems] = createSignal([]);
 const [user, _setUser] = createSignal(null);
 var _v$5 = _$ssrHydrationKey(),
 _v$6 = _$escape(_$For({
 get each() {
 return items();
 },
 children: (item, i) => {
 var _v$10, _v$11, _v$12;
 return _v$10 = _$ssrHydrationKey(), _v$11 = _$scope(() => _$escape(i())), _v$12 = _$scope(() => _$escape(item())), _$ssr(_tmpl$4, _v$10, _v$11, _v$12);
 }
 })),
 _v$7 = _$escape(_$Show({
 get when() {
 return user();
 },
 fallback: () => "Anonymous",
 children: u => {
 var _v$13, _v$14;
 return _v$13 = _$ssrHydrationKey(), _v$14 = () => _$escape(u().name), _$ssr(_tmpl$5, _v$13, _v$14);
 }
 })),
 _v$8 = _$escape(_$Errored({
 fallback: (e, reset) => () => {
 var _v$15, _v$16;
 return _v$15 = _$ssrHydrationKey(), _v$16 = () => _$escape(e.message), _$ssr(_tmpl$6, _v$15, _v$16);
 },
 get children() {
 return Risky({});
 }
 })),
 _v$9 = _$escape(_$Loading({
 fallback: () => {
 var _v$17;
 return _v$17 = _$ssrHydrationKey(), _$ssr(_tmpl$7, _v$17);
 },
 get children() {
 return Slow({});
 }
 })),
 _v$1 = _$escape(Layout({
 header: () => {
 var _v$18;
 return _v$18 = _$ssrHydrationKey(), _$ssr(_tmpl$8, _v$18);
 },
 footer: year => () => {
 var _v$19, _v$20;
 return _v$19 = _$ssrHydrationKey(), _v$20 = _$escape(year), _$ssr(_tmpl$9, _v$19, _v$20);
 },
 get children() {
 return _v$0 = _$ssrHydrationKey(), _$ssr(_tmpl$2, _v$0);
 }
 }));
 return _$ssr(_tmpl$3, _v$5, _v$6, _v$7, _v$8, _v$9, _v$1);
}
function Risky() {
 var _v$21 = _$ssrHydrationKey();
 return _$ssr(_tmpl$0, _v$21);
}
function Slow() {
 var _v$22 = _$ssrHydrationKey();
 return _$ssr(_tmpl$1, _v$22);
}