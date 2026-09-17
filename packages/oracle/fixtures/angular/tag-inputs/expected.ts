import { Component, Input } from "@angular/core";

export interface Input { name: string; size?: number }

@Component({
  selector: "mx-inputs",
  standalone: true,
  imports: [],
  template: "<span class=\"icon\">{{ name }}</span>",
})
export class Inputs {
  @Input({ required: true }) name!: string;
  @Input() size?: number;
}
export default Inputs;
