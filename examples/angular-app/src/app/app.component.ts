import { NgClass } from "@angular/common";
import { Component } from "@angular/core";
import { ProductList } from "./product-list/product-list.component";
import Badge from "./tags/badge";

@Component({
  selector: "app-root",
  imports: [NgClass, Badge, ProductList],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class App {
  protected title = "angular";
  protected loggedIn = true;
  protected userName = "Ada";
  protected highlighted = false;
  protected items = [
    { id: 1, label: "MX" },
    { id: 2, label: "Angular" },
    { id: 3, label: "Bun" },
  ];

  // The page binds `onClick`, so its class carries the event invoker the
  // template calls (`mx-angular build` prints this text; `MxHandlers` from
  // "@mxlang/angular/runtime" is the alternative).
  protected readonly __mxOn = <E, R>(
    handler:
      | ((event: E, element: EventTarget | null) => R)
      | null
      | undefined
      | false,
    receiver: unknown,
    event: E,
  ): R | undefined =>
    handler
      ? handler.call(
          receiver,
          event,
          (event as { currentTarget?: EventTarget | null } | null)
            ?.currentTarget ?? null,
        )
      : undefined;
  protected readonly __mxOnAt = <K extends PropertyKey, E, R>(
    object: {
      [P in K]?:
        | ((event: E, element: EventTarget | null) => R)
        | null
        | undefined
        | false;
    },
    key: K,
    event: E,
  ): R | undefined => this.__mxOn(object[key], object, event);

  protected toggleHighlight(_event: Event): void {
    this.highlighted = !this.highlighted;
  }
}
