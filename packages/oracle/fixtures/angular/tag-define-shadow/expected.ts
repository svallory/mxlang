import { Component } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";

@Component({
  selector: "mx-define-shadow",
  standalone: true,
  imports: [NgTemplateOutlet],
  template: "<ng-template #Row let-input> {{ input.label }} </ng-template><div><ng-container [ngTemplateOutlet]=\"Row\" [ngTemplateOutletContext]=\"{ $implicit: row }\"></ng-container></div>",
})
export class DefineShadow {
}
export default DefineShadow;
