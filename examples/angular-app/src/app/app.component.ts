import { NgClass } from "@angular/common";
import { Component } from "@angular/core";

// TODO(task 1.7): once tag-file compile lands, call a discovered tag from
// src/app/tags/ here instead of inlining everything in one component.

@Component({
  selector: "app-root",
  imports: [NgClass],
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

  protected toggleHighlight(_event: Event): void {
    this.highlighted = !this.highlighted;
  }
}
