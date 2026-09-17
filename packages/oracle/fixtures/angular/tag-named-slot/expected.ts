import { Component } from "@angular/core";

@Component({
  selector: "mx-named-slot",
  standalone: true,
  imports: [],
  template: "<section><ng-content select=\"[header]\"></ng-content><ng-content></ng-content></section>",
})
export class NamedSlot {
}
export default NamedSlot;
