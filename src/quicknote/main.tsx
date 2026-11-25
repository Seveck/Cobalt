import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import QuickNote from "./QuickNote";
import "../i18n";
import "../index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element missing in quicknote.html");
}

createRoot(root).render(
  <StrictMode>
    <QuickNote />
  </StrictMode>,
);
