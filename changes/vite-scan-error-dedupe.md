---
packages: [vite-plugin]
kind: Fixed
---
A tag file the scan cannot use is now reported once, not once per page that is compiled. `@mxlang/vite-plugin` used to repeat the same scan error for every compiled page in `vite build`, so one bad tag file gave N identical errors; a build now fails with the error once, and a different tag file, a different position, a different code or a different message is still reported. Under `vite serve` the scan problem is a warning, printed once per version of the tag file: editing the file, or fixing it and breaking it again, warns again, and a new build starts over. The warning also names the tag file and its real position (`File: tags/x.mx:1:0`, with a code frame) where Vite used to print the page being compiled with no position that meant anything.
