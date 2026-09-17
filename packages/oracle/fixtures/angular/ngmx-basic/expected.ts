import { Component } from "@angular/core";

@Component({
  selector: "app-greeting",
  template: `<div class="greeting"><h1>Hello, {{ name }}!</h1><p>You have {{ count }} messages.</p></div>`,
})
export class GreetingComponent {
  name = "world";
  count = 3;
}
