---
packages: [language-server, typescript-plugin, tsc, vite-plugin]
kind: Fixed
---
A file with two or more parse errors now shows every one of them. Before, the editor showed none (the language server published an empty list and handed the error to its unexpected-error hook), the TypeScript plugin and `mx-tsc` showed one diagnostic at the start of the file with no code and the whole error text as its message, and a Vite build failed with no file position in its header. Each parse error is now its own diagnostic with its own code and range, the cause before what it leaves behind (`mx-tsc` prints `page.mx(1,11): error MX_PARSE_EXPRESSION` and `page.mx(2,12): ...`), and a Vite build locates the first and lists the others in its message, as it does for a compile error. An error that holds no errors still reports once.
