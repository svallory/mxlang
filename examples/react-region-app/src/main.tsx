import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Panel } from "./Panel.react.mx";

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <Panel
      items={[
        { id: "a", name: "Ann" },
        { id: "b", name: "Bo" },
      ]}
    />
  </StrictMode>,
);
