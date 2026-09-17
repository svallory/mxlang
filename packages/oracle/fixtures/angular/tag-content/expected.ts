import { Component } from "@angular/core";

@Component({
  selector: "mx-content",
  standalone: true,
  imports: [],
  template: "<div class=\"card\"><ng-content></ng-content></div>",
})
export class Content {
}
export default Content;
