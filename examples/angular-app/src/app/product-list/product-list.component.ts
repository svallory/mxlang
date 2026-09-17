import { KeyValuePipe, NgStyle, NgTemplateOutlet } from "@angular/common";
import { Component } from "@angular/core";

@Component({
  selector: "app-product-list",
  imports: [NgStyle, KeyValuePipe, NgTemplateOutlet],
  templateUrl: "./product-list.component.html",
})
export class ProductList {
  protected textColor = "#333";
  protected products: Record<
    string,
    { name: string; price: number; featured: boolean }
  > = {
    mx: { name: "MX", price: 0, featured: true },
    angular: { name: "Angular", price: 0, featured: false },
    bun: { name: "Bun", price: 0, featured: true },
  };
}
