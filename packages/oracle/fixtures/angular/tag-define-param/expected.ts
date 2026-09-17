import { Component, Input as NgInput } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";

export interface Input { title: string }

@Component({
  selector: "mx-define-param",
  standalone: true,
  imports: [NgTemplateOutlet],
  template: "<ng-template #Row let-row> {{ row.label }} </ng-template><div>{{ title }}<ng-container [ngTemplateOutlet]=\"Row\" [ngTemplateOutletContext]=\"{ $implicit: item }\"></ng-container></div>",
})
export class DefineParam {
  @NgInput({ required: true }) title!: string;
}
export default DefineParam;
