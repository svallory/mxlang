import { Component } from "@angular/core";

const PREFIX = "#";

@Component({
  selector: "mx-static-import",
  standalone: true,
  imports: [],
  template: "<i>{{ PREFIX }}</i>",
})
export class StaticImport {
  protected get PREFIX() { return PREFIX; }
}
export default StaticImport;
