import { NgClass } from "@angular/common";
import { Component, Input } from "@angular/core";
import { Card } from "./tags/card";
import type { Member } from "./members";

@Component({
  selector: "app-team",
  imports: [Card, NgClass],
  template: `
    <mx-card>
      <ng-container ngProjectAs="[title]">
        Team <span class="count">{{ shown.length }}</span>
      </ng-container>
      <input name="q" class="search" type="search" [value]="query" (input)="search($event)" />
      @if (shown.length) {
        <ul class="members">
          @for (member of shown; track member.id) {
            <li [ngClass]="{ admin: member.admin }">
              {{ member.name }}
              @for (team of member.teams; track team) {
                <span class="tag">{{ team }}</span>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="empty">Nobody matches “{{ query }}”.</p>
      }
      <ng-container ngProjectAs="[footer]">
        <button class="button" (click)="clear()">Clear</button>
      </ng-container>
    </mx-card>
  `,
})
export class Team {
  @Input() members: Member[] = [];
  protected query = "";

  protected get shown() {
    return this.members.filter((member) => member.name.includes(this.query));
  }

  protected search(event: Event) {
    this.query = (event.target as HTMLInputElement).value;
  }

  protected clear() {
    this.query = "";
  }
}
