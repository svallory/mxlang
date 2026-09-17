import { Component } from "@angular/core";

@Component({
  selector: "app-people",
  template: `<ul>@for (p of people; track p.id) { <li>@if (p.active) { {{ p.name }} } @else { (inactive) }</li> }</ul>`,
})
export class PeopleComponent {
  people = [{ id: 1, name: "Ada", active: true }];
}
