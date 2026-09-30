// @vitest-environment jsdom
import { Component, InjectionToken, inject } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MxHandlers, MxHandlersMixin } from "../src/runtime.ts";

// angular-handlers-base. A component whose constructor injects services and
// whose class takes the invoker from the runtime module must instantiate under
// Angular's DI and dispatch a real DOM event through `__mxOn` / `__mxOnAt`.
// Decorators are applied as calls (`Component({...})(Class)`) because the test
// transform does not lower TC39 decorators; the effect is the same.

const GREETING = new InjectionToken<string>("greeting");

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

function click(root: HTMLElement, selector: string) {
  (root.querySelector(selector) as HTMLElement).click();
}

describe("MxHandlersMixin under TestBed", () => {
  it("instantiates a mixin component with constructor DI and runs a handler with this and (event, element)", () => {
    class Base {
      readonly baseGreeting = inject(GREETING);
    }
    class Probe extends MxHandlersMixin(Base) {
      readonly greeting = inject(GREETING);
      seen: unknown[] = [];
      constructor() {
        super();
      }
      go(event: MouseEvent, element: EventTarget | null) {
        this.seen.push(this, event.type, element);
      }
    }
    Component({
      selector: "mx-probe",
      template: `<button id="a" (click)="__mxOn(go, this, $event)">x</button>`,
    })(Probe);

    TestBed.configureTestingModule({
      providers: [{ provide: GREETING, useValue: "hello" }],
    });
    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();

    expect(fixture.componentInstance.greeting).toBe("hello");
    expect(fixture.componentInstance.baseGreeting).toBe("hello");
    click(fixture.nativeElement, "#a");
    const [self, type, element] = fixture.componentInstance.seen;
    expect(self).toBe(fixture.componentInstance);
    expect(type).toBe("click");
    expect((element as HTMLElement).id).toBe("a");
  });

  it("__mxOnAt keeps the object as this for a member handler", () => {
    class Probe extends MxHandlers {
      svc = {
        n: 4,
        hit: 0,
        go(this: { n: number; hit: number }) {
          this.hit = this.n;
        },
      };
    }
    Component({
      selector: "mx-probe-at",
      template: `<button id="b" (click)="__mxOnAt(svc, 'go', $event)">x</button>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();
    click(fixture.nativeElement, "#b");
    expect(fixture.componentInstance.svc.hit).toBe(4);
  });

  it("a falsy handler is a no-op and does not throw", () => {
    class Probe extends MxHandlers {
      maybe: (() => void) | undefined = undefined;
    }
    Component({
      selector: "mx-probe-falsy",
      template: `<button id="c" (click)="__mxOn(maybe, this, $event)">x</button>`,
    })(Probe);

    const fixture = TestBed.createComponent(Probe);
    fixture.detectChanges();
    expect(() => click(fixture.nativeElement, "#c")).not.toThrow();
  });
});
