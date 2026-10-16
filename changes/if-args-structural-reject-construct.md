---
packages: [core]
kind: Fixed
---
Under `structural: "reject"`, a `for` or `if` is reported once, as the construct (`MX_STRUCTURAL_CONSTRUCT`), however it is written. `<if(x)>`, `<else-if(x)>`, `<else(x)>`, `<for(x)>`, `<for|x|(y)>`, `<if|x|=a>` and an `<if>` or `<for>` with no condition or params used to report the construct's own shape error first, such as "Tag does not support arguments. Write the condition as a value attribute instead", a hint that points at a form the file cannot use either. A shape error of a `for` or `if` now applies only where the construct is legal (`structural: "pass"`, the unset default, or a template), and there the message is unchanged.
