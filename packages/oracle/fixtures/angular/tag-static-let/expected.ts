import { Component } from "@angular/core";

let n = 0;
function bump() { n++; }

@Component({
  selector: "mx-static-let",
  standalone: true,
  imports: [],
  template: "<button (click)=\"__mxOn(bump, this, $event)\">{{ n }}</button>",
})
export class StaticLet {
  protected get bump() { return bump; }
  protected get n() { return n; }
  protected set n(__mxNext: typeof n) { n = __mxNext; }
  protected readonly __mxOn = <E, R>(handler: ((event: E, element: EventTarget | null) => R) | null | undefined | false, receiver: unknown, event: E): R | undefined => handler ? handler.call(receiver, event, (event as { currentTarget?: EventTarget | null } | null)?.currentTarget ?? null) : undefined;
  protected readonly __mxOnAt = <K extends PropertyKey, E, R>(object: { [P in K]?: ((event: E, element: EventTarget | null) => R) | null | undefined | false }, key: K, event: E): R | undefined => this.__mxOn(object[key], object, event);
}
export default StaticLet;
