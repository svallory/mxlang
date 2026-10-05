import { Component, Input, signal } from "@angular/core";

@Component({
  selector: "app-greeter",
  template: `
    <section>
      <h1>{{ label }}</h1>
      <button (click)="count.update((n) => n + 1)">clicked {{ count() }}</button>
      @if (count() > 2) {
        <p>That is plenty.</p>
      }
      <ul>
        @for (name of names; track name.id) {
          <li>{{ name.text }}</li>
        }
      </ul>
    </section>
  `,
})
export class Greeter {
  @Input() label = "";
  @Input() names: { id: number; text: string }[] = [];
  protected count = signal(0);
}
