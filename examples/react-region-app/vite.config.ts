import mx from "@mxlang/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// MX runs first and lowers each region of a `.react.mx` file to React JSX
// (and a whole-file `.mx` to React TSX); the React plugin then applies
// the same JSX transform and Fast Refresh integration as it does to `.tsx`.
export default defineConfig({
  plugins: [mx(), react()],
});
