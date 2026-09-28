import { scope as _$scope } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
var _tmpl$ = ["<li", "><!--$-->", "<!--/-->-<!--$-->", "<!--/--></li>"],
 _tmpl$2 = ["<section", "><h1>", "</h1><!--$-->", "<!--/--></section>"],
 _tmpl$3 = ["<div", "><!--$-->", "<!--/--><!--$-->", "<!--/--><!--$-->", "<!--/--></div>"];
function Empty() {
 return "no args";
}
function Row(item, i) {
 var _v$ = _$ssrHydrationKey(),
 _v$2 = _$escape(item),
 _v$3 = _$escape(i);
 return _$ssr(_tmpl$, _v$, _v$2, _v$3);
}
function Card(title, head) {
 var _v$4 = _$ssrHydrationKey(),
 _v$5 = _$escape(title),
 _v$6 = _$scope(() => _$escape(head()));
 return _$ssr(_tmpl$2, _v$4, _v$5, _v$6);
}
export function DefineHoist() {
 var _v$7 = _$ssrHydrationKey(),
 _v$8 = _$scope(() => _$escape(Empty())),
 _v$9 = _$scope(() => _$escape(Row(1, 0))),
 _v$0 = _$scope(() => _$escape(Card("Hi", () => "tagged")));
 return _$ssr(_tmpl$3, _v$7, _v$8, _v$9, _v$0);
}