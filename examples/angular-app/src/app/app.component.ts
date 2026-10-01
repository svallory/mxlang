import { NgClass } from "@angular/common";
import { Component } from "@angular/core";
import { MxHandlers } from "@mxlang/angular/runtime";
import { ProductList } from "./product-list/product-list.component";
import Badge from "./tags/badge";

// The page binds `onClick`, so the template calls `__mxOn`; MxHandlers carries it.
@Component({
  selector: "app-root",
  imports: [NgClass, Badge, ProductList],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class App extends MxHandlers {
  protected title = "angular";
  protected loggedIn = true;
  protected userName = "Ada";
  protected highlighted = false;
  protected items = [
    { id: 1, label: "MX" },
    { id: 2, label: "Angular" },
    { id: 3, label: "Bun" },
  ];

  protected toggleHighlight(_event: Event): void {
    this.highlighted = !this.highlighted;
  }
}
