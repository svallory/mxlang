import { Component, Input as NgInput } from "@angular/core";

export interface Input { name: string; size?: number }

@Component({
  selector: "mx-inputs",
  standalone: true,
  imports: [],
  template: "<span class=\"icon\">{{ name }}</span>",
})
export class Inputs {
  @NgInput({ required: true }) name!: string;
  @NgInput() size?: number;
}
export default Inputs;
