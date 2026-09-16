import { scope as _$scope } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
import { Repeat as _$Repeat } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { For as _$For } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
var _tmpl$ = ["<div", "><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--></div>"],
 _tmpl$2 = ["<li", "><!--$-->", "<!--/-->: <!--$-->", "<!--/--></li>"],
 _tmpl$3 = ["<li", ">", "</li>"],
 _tmpl$4 = ["<span", ">", "</span>"],
 _tmpl$5 = ["<b", ">", "</b>"],
 _tmpl$6 = ["<em", ">", "</em>"],
 _tmpl$7 = ["<p", "><!--$-->", "<!--/-->=<!--$-->", "<!--/--></p>"];
import { createSignal } from "solid-js";
export function Lists() {
 // Setters are unused: the fixture exercises lowering shapes, not behavior.
 const [rows, _setRows] = createSignal([]);
 const [count, _setCount] = createSignal(3);
 const [meta, _setMeta] = createSignal({});
 var _v$ = _$ssrHydrationKey(),
 _v$2 = _$escape(_$For({
 get each() {
 return rows();
 },
 keyed: x => x.id,
 children: (row, i) => {
 var _v$0, _v$1, _v$10;
 return _v$0 = _$ssrHydrationKey(), _v$1 = _$scope(() => _$escape(i())), _v$10 = () => _$escape(row().label), _$ssr(_tmpl$2, _v$0, _v$1, _v$10);
 }
 })),
 _v$3 = _$escape(_$For({
 get each() {
 return rows();
 },
 keyed: r => r.label,
 children: (row, i) => {
 var _v$11, _v$12;
 return _v$11 = _$ssrHydrationKey(), _v$12 = () => _$escape(row().label), _$ssr(_tmpl$3, _v$11, _v$12);
 }
 })),
 _v$4 = _$escape(_$Repeat({
 get count() {
 return count() - 1 + 1;
 },
 from: 1,
 children: i => {
 var _v$13, _v$14;
 return _v$13 = _$ssrHydrationKey(), _v$14 = _$escape(i), _$ssr(_tmpl$4, _v$13, _v$14);
 }
 })),
 _v$5 = _$escape(_$Repeat({
 count: 4,
 children: i => {
 var _v$15, _v$16;
 return _v$15 = _$ssrHydrationKey(), _v$16 = _$escape(i), _$ssr(_tmpl$5, _v$15, _v$16);
 }
 })),
 _v$6 = _$escape(_$Repeat({
 count: 5,
 children: mxIndex => {
 const i = 0 + mxIndex * 2;
 var _v$17 = _$ssrHydrationKey(),
 _v$18 = _$escape(i);
 return _$ssr(_tmpl$6, _v$17, _v$18);
 }
 })),
 _v$7 = _$escape(_$Repeat({
 count: 6,
 children: mxIndex => {
 const i = 10 + mxIndex * -2;
 var _v$19 = _$ssrHydrationKey(),
 _v$20 = _$escape(i);
 return _$ssr(_tmpl$6, _v$19, _v$20);
 }
 })),
 _v$8 = _$escape(_$Repeat({
 count: 4,
 children: mxIndex => {
 const i = 0 + mxIndex * 3;
 var _v$21 = _$ssrHydrationKey(),
 _v$22 = _$escape(i);
 return _$ssr(_tmpl$6, _v$21, _v$22);
 }
 })),
 _v$9 = _$escape(_$For({
 get each() {
 return Object.entries(meta());
 },
 keyed: e => e[0],
 children: mxEntry => {
 var _v$23, _v$24, _v$25;
 return _v$23 = _$ssrHydrationKey(), _v$24 = () => _$escape(mxEntry()[0]), _v$25 = () => _$escape(mxEntry()[1]), _$ssr(_tmpl$7, _v$23, _v$24, _v$25);
 }
 }));
 return _$ssr(_tmpl$, _v$, _v$2, _v$3, _v$4, _v$5, _v$6, _v$7, _v$8, _v$9);
}