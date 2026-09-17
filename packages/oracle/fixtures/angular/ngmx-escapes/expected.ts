import { Component } from "@angular/core";

@Component({
  selector: "app-escapes",
  template: `<pre>a \` b and \${{ '{' }}literal{{ '}' }} and \\\\ backslash</pre>`,
})
export class EscapesComponent {}
