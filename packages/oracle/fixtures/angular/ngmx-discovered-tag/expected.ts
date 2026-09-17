import { Component } from "@angular/core";
import { Badge } from "./tags/badge";

@Component({
  selector: "app-listing",
  imports: [Badge],
  template: `<ul><li>MX <mx-badge></mx-badge></li></ul>`,
})
export class ListingComponent {}
