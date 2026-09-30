import { Component } from "@angular/core";
import { Badge as Chip } from "./tags/badge";
import { Badge } from "./tags/badge";

@Component({
  selector: "app-listing",
  imports: [Badge],
  template: `<ul><li>MX <mx-badge></mx-badge> <mx-badge></mx-badge></li></ul>`,
})
export class ListingComponent {}
